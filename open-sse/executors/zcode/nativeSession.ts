import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ZcodeClientLike } from "../zcodeProtocol.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(record) : []);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(record(value))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value;
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const historyDigest = (messages: RecordValue[]) =>
  digest(
    messages.map((message) => ({
      role: message.role,
      content: message.content || "",
      tool_call_id: message.tool_call_id,
      tool_calls: message.tool_calls,
    }))
  );
const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export class NativeSessionError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message);
  }
}
type Tool = { name: string; description?: string; inputSchema: RecordValue };
type PendingTool = {
  id: string;
  rpcId: string | number;
  name: string;
  input: RecordValue;
  response: ServerResponse;
  delivered: boolean;
};
type Run = {
  client: ZcodeClientLike;
  sessionId: string;
  workspace: { workspacePath: string; workspaceIdentity: string };
  scope: string;
  history: RecordValue[];
  toolsHash: string;
  pending: PendingTool[];
  toolsListed: boolean;
  relay: Server;
  busy: boolean;
  expires: ReturnType<typeof setTimeout>;
};

export interface NativeSessionOptions {
  clientFactory: () => ZcodeClientLike;
  workspaceRoot: string;
  timeoutMs?: number;
  continuationTimeoutMs?: number;
  pollMs?: number;
}

/** A caller tool is a suspended MCP request. Only the caller supplies its result. */
export class NativeZcodeSessionBridge {
  private continuations = new Map<string, Run>();
  private runs = new Set<Run>();
  constructor(private options: NativeSessionOptions) {}
  async close(): Promise<void> {
    await Promise.allSettled([...this.runs].map((run) => this.dispose(run)));
  }

  async execute(input: {
    scope: string;
    selection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
    messages: RecordValue[];
    tools: Tool[];
    signal?: AbortSignal | null;
  }): Promise<RecordValue> {
    const results = input.messages.filter((m) => m.role === "tool");
    const ids = results.map((m) => String(m.tool_call_id || ""));
    const matches = ids.map((id) => this.continuations.get(id)).filter((v): v is Run => !!v);
    let run = matches[0];
    if (run) {
      if (matches.some((other) => other !== run) || run.scope !== input.scope || run.busy)
        throw new NativeSessionError("ZCode tool continuation does not match this request", 409);
      if (
        run.toolsHash !== digest(input.tools) ||
        historyDigest(input.messages.slice(0, run.history.length)) !== historyDigest(run.history)
      )
        throw new NativeSessionError("ZCode tool continuation history changed", 409);
      const outstanding = run.pending.filter((tool) => tool.delivered);
      if (outstanding.some((tool) => !ids.includes(tool.id)))
        throw new NativeSessionError("All pending ZCode tool results are required", 400);
      const suffix = input.messages.slice(run.history.length);
      if (
        suffix.length !== outstanding.length ||
        suffix.some(
          (message) =>
            message.role !== "tool" || !outstanding.some((tool) => tool.id === message.tool_call_id)
        ) ||
        new Set(suffix.map((message) => message.tool_call_id)).size !== suffix.length
      )
        throw new NativeSessionError(
          "Send only the pending tool results; send new messages after this turn finishes",
          400
        );
      run.busy = true;
      for (const tool of outstanding) {
        const result = results.find((m) => m.tool_call_id === tool.id)!;
        this.continuations.delete(tool.id);
        tool.response.writeHead(200, { "content-type": "application/json" });
        tool.response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: tool.rpcId,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    typeof result.content === "string"
                      ? result.content
                      : JSON.stringify(result.content),
                },
              ],
            },
          })
        );
      }
      run.pending = run.pending.filter((tool) => !outstanding.includes(tool));
      run.history = input.messages;
    } else {
      const last = input.messages.at(-1);
      if (last?.role === "tool" && ids.some((id) => id.startsWith("call_zcn_")))
        throw new NativeSessionError("ZCode tool continuation expired; start a new request", 409);
      run = await this.start(input);
    }
    try {
      const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
      while (Date.now() < deadline) {
        if (input.signal?.aborted) throw new NativeSessionError("ZCode request cancelled", 499);
        if (run.pending.some((tool) => !tool.delivered)) {
          // Let simultaneous tool requests arrive before returning one caller turn.
          await new Promise((resolve) => setTimeout(resolve, 40));
          const pending = run.pending.filter((tool) => !tool.delivered);
          for (const tool of pending) {
            tool.delivered = true;
            this.continuations.set(tool.id, run);
          }
          const calls = pending.map((tool) => ({
            id: tool.id,
            name: tool.name,
            input: tool.input,
          }));
          run.history = [
            ...input.messages,
            {
              role: "assistant",
              content: "",
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            },
          ];
          run.busy = false;
          run.expires.refresh();
          return { text: "", finishReason: "tool-calls", toolCalls: calls };
        }
        const snapshot = record(
          await run.client.call("zcode-agent", "readSession", [
            {
              ...run.workspace,
              sessionId: run.sessionId,
              messageLimit: 20,
            },
          ])
        );
        const session = record(snapshot.session);
        if (session.status === "error") {
          const error = record(record(snapshot.projection).lastError);
          const detail = `${error.code || ""} ${error.message || ""}`;
          if (
            /\b1310\b|Weekly\/Monthly Limit Exhausted|quota[_ ]exhausted|rate[_ ]limit/i.test(
              detail
            )
          )
            throw new NativeSessionError("ZCode tariff quota or rate limit reached", 429);
          if (/\b401\b|unauthorized|invalid[_ ]token|authentication/i.test(detail))
            throw new NativeSessionError("ZCode account needs a new login", 401);
          throw new NativeSessionError("ZCode native session failed");
        }
        const messages = list(snapshot.messages);
        const response = messages
          .filter((message) => record(record(message.info).semantics).kind === "assistant_response")
          .at(-1);
        if (response && session.status === "idle" && record(response.info).finish === "stop") {
          if (input.tools.length && !run.toolsListed) {
            throw new NativeSessionError("ZCode caller tools did not connect", 503);
          }
          const text = list(response.parts)
            .filter((part) => part.type === "text")
            .map((part) => String(part.text ?? ""))
            .join("");
          const reasoning = list(response.parts)
            .filter((part) => part.type === "reasoning")
            .map((part) => String(part.text ?? ""))
            .join("\n\n");
          const tokens = record(record(response.info).tokens);
          await this.dispose(run);
          return {
            text,
            reasoning,
            finishReason: "stop",
            usage: {
              inputTokens: tokens.input ?? 0,
              outputTokens: tokens.output ?? 0,
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 300));
      }
      throw new NativeSessionError("ZCode native session timed out", 504);
    } catch (error) {
      await this.dispose(run);
      throw error;
    }
  }

  private async start(input: Parameters<NativeZcodeSessionBridge["execute"]>[0]): Promise<Run> {
    if (!input.messages.length) throw new NativeSessionError("Messages are required", 400);
    // Keep native names independent of caller punctuation and naming collisions.
    const names = new Map(input.tools.map((tool, index) => [`tool_${index}`, tool]));
    const token = randomUUID();
    let run: Run;
    const relay = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024 * 1024) {
            response.writeHead(413).end();
            return;
          }
        }
        const parsed = rpcSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          response.writeHead(400).end();
          return;
        }
        const message = parsed.data;
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const reply = (result: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize")
          reply({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "omniroute-caller", version: "1.0.0" },
          });
        else if (message.method === "tools/list") {
          run.toolsListed = true;
          reply({
            tools: [...names].map(([name, tool]) => ({
              ...tool,
              name,
              description: `${tool.name}: ${tool.description || "Caller-provided tool"}`,
              annotations: { readOnlyHint: true },
            })),
          });
        } else if (message.method === "tools/call") {
          const tool = names.get(String(message.params?.name));
          if (!tool || !run) {
            response.writeHead(400).end();
            return;
          }
          run.pending.push({
            id: `call_zcn_${randomUUID().replaceAll("-", "")}`,
            rpcId: message.id,
            name: tool.name,
            input: record(message.params?.arguments),
            response,
            delivered: false,
          });
        } else reply({});
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    const address = relay.address();
    if (!address || typeof address === "string") throw new NativeSessionError("MCP relay failed");
    const workspacePath = join(this.options.workspaceRoot, randomUUID());
    let client: ZcodeClientLike;
    try {
      await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      client = this.options.clientFactory();
    } catch (error) {
      relay.closeAllConnections();
      relay.close();
      await rm(workspacePath, { recursive: true, force: true });
      throw error;
    }
    run = {
      client,
      relay,
      sessionId: "",
      scope: input.scope,
      history: input.messages,
      toolsHash: digest(input.tools),
      pending: [],
      toolsListed: false,
      busy: true,
      workspace: { workspacePath, workspaceIdentity: workspacePath },
      expires: setTimeout(() => {
        void this.dispose(run).catch(() => undefined);
      }, this.options.continuationTimeoutMs ?? 600_000),
    };
    this.runs.add(run);
    run.expires.unref();
    try {
      await client.start();
      const project = record(
        await client.call("project", "saveProject", [
          {
            name: "OmniRoute request",
            roots: [workspacePath],
          },
        ])
      );
      const state = record(
        await client.call("zcode-agent", "createSession", [
          {
            ...run.workspace,
            projectId: project.id,
            model: input.selection,
            persistence: "deferred",
            titleGenerationEnabled: false,
            toolAllowlist: [...names.keys()].map((name) => `mcp__omniroute__${name}`),
            mcpServers: names.size
              ? [
                  {
                    name: "omniroute",
                    type: "http",
                    protocolVersion: "legacy",
                    scope: "user",
                    url: `http://127.0.0.1:${address.port}/mcp`,
                    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
                    alwaysLoad: true,
                    timeoutMs: this.options.continuationTimeoutMs ?? 600_000,
                  },
                ]
              : [],
          },
        ])
      );
      run.sessionId = String(record(state.session).sessionId || "");
      if (!run.sessionId) throw new NativeSessionError("Native session was not created");
      const content =
        input.messages.length === 1 && typeof input.messages[0].content === "string"
          ? input.messages[0].content
          : `Respond to the latest user request in this caller conversation. Preserve its instructions and history. Only use the provided caller tools.\n${JSON.stringify(input.messages)}`;
      await client.call("zcode-agent", "sendPrompt", [
        {
          ...run.workspace,
          sessionId: run.sessionId,
          modelSelection: input.selection,
          inputId: randomUUID(),
          content,
        },
      ]);
      return run;
    } catch (error) {
      await this.dispose(run);
      throw error;
    }
  }

  private async dispose(run: Run): Promise<void> {
    if (!this.runs.delete(run)) return;
    clearTimeout(run.expires);
    for (const [id, owner] of this.continuations) if (owner === run) this.continuations.delete(id);
    for (const tool of run.pending) tool.response.destroy();
    run.relay.closeAllConnections();
    run.relay.close();
    try {
      if (run.sessionId)
        await run.client.call("zcode-agent", "closeSession", [
          {
            ...run.workspace,
            sessionId: run.sessionId,
          },
        ]);
    } finally {
      try {
        // Closing a deferred session does not stop its workspace engine. Native
        // releasePreparation also preserves other sessions in a shared engine.
        try {
          await run.client.call("zcode-agent", "disposeWorkspace", [
            { ...run.workspace, releasePreparation: true },
          ]);
        } finally {
          await run.client.close();
        }
      } finally {
        await rm(run.workspace.workspacePath, { recursive: true, force: true });
      }
    }
  }
}
