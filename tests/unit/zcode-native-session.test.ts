import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeZcodeSessionBridge } from "../../open-sse/executors/zcode/nativeSession.ts";

test("native session returns caller tool, binds continuation, and consumes external result once", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-session-test-"));
  let toolResult = "";
  let relayUrl = "";
  let headers: Record<string, string> = {};
  let toolRequest: Promise<void> | undefined;
  let closeCount = 0;
  let releasedWorkspaces = 0;
  const bridge = new NativeZcodeSessionBridge({
    workspaceRoot: root,
    pollMs: 2,
    timeoutMs: 2000,
    clientFactory: () => ({
      async start() {},
      async close() {
        closeCount++;
      },
      async call(_channel, method, args) {
        const params = args[0] as Record<string, unknown>;
        if (method === "saveProject") return { id: "owned-project" };
        if (method === "createSession") {
          assert.deepEqual(params.toolAllowlist, ["mcp__omniroute__tool_0"]);
          const server = (
            params.mcpServers as Array<{
              url: string;
              protocolVersion: string;
              headers: Array<{ name: string; value: string }>;
            }>
          )[0];
          assert.equal(server.protocolVersion, "legacy");
          relayUrl = server.url;
          headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
          return { session: { sessionId: "owned-session" } };
        }
        if (method === "sendPrompt") {
          toolRequest = (async () => {
            await fetch(relayUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
            });
            const response = await fetch(relayUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "tool_0", arguments: { value: 7 } },
              }),
            });
            const body = await response.json();
            toolResult = body.result.content[0].text;
          })();
          return { accepted: true };
        }
        if (method === "readSession")
          return toolResult
            ? {
                session: { status: "idle" },
                messages: [
                  {
                    info: { finish: "stop", semantics: { kind: "assistant_response" } },
                    parts: [
                      { type: "reasoning", text: "Checked caller result" },
                      { type: "text", text: toolResult },
                    ],
                  },
                ],
              }
            : { session: { status: "running" }, messages: [] };
        if (method === "closeSession") return true;
        if (method === "disposeWorkspace") {
          assert.equal(params.releasePreparation, true);
          releasedWorkspaces++;
          return true;
        }
        throw new Error(`Unexpected method ${method}`);
      },
    }),
  });
  const base = {
    scope: "account-a:start:caller-a",
    selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
    messages: [{ role: "user", content: "Use echo" }],
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
  };
  try {
    const result = await bridge.execute(base);
    assert.equal(result.finishReason, "tool-calls");
    assert.equal(toolResult, "", "native tool must remain suspended until caller returns a result");
    const call = (result.toolCalls as Array<{ id: string; name: string; input: unknown }>)[0];
    assert.equal(call.name, "echo");
    assert.deepEqual(call.input, { value: 7 });
    const messages = [
      ...base.messages,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      },
      { role: "tool", content: "unpredictable-client-value", tool_call_id: call.id },
    ];
    await assert.rejects(
      bridge.execute({ ...base, scope: "account-b:start:caller-a", messages }),
      /does not match/
    );
    await assert.rejects(
      bridge.execute({
        ...base,
        messages: [{ role: "user", content: "changed" }, ...messages.slice(1)],
      }),
      /history changed/
    );
    await assert.rejects(
      bridge.execute({
        ...base,
        messages: [...messages, { role: "user", content: "new instruction" }],
      }),
      /only the pending tool results/
    );
    assert.equal(toolResult, "", "invalid continuation must not consume the suspended tool");
    const final = await bridge.execute({ ...base, messages });
    assert.equal(final.text, "unpredictable-client-value");
    assert.equal(final.reasoning, "Checked caller result");
    await toolRequest;
    assert.equal(closeCount, 1);
    assert.equal(releasedWorkspaces, 1, "completed request releases its native engine");
    assert.deepEqual(await readdir(root), [], "completed request workspace is removed");
    await assert.rejects(bridge.execute({ ...base, messages }), /expired/);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native session rejects a successful answer when caller tools never connected", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-session-missing-tools-"));
  const bridge = new NativeZcodeSessionBridge({
    workspaceRoot: root,
    pollMs: 1,
    timeoutMs: 1000,
    clientFactory: () => ({
      async start() {},
      async close() {},
      async call(_channel, method) {
        if (method === "saveProject") return { id: "project" };
        if (method === "createSession") return { session: { sessionId: "session" } };
        if (method === "readSession")
          return {
            session: { status: "idle" },
            messages: [
              {
                info: { finish: "stop", semantics: { kind: "assistant_response" } },
                parts: [{ type: "text", text: "No tool available" }],
              },
            ],
          };
        return {};
      },
    }),
  });
  try {
    await assert.rejects(
      bridge.execute({
        scope: "cold-host",
        selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
        messages: [{ role: "user", content: "Call echo" }],
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      }),
      { status: 503, message: "ZCode caller tools did not connect" }
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
