import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeZcodeSessionBridge } from "../../open-sse/executors/zcode/nativeSession.ts";
import { sanitizeProviderUsageForRequest } from "../../open-sse/utils/usageTracking.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

test("ZCode's exact token usage is not replaced by an estimate from executor metadata", () => {
  const usage = { prompt_tokens: 20520, completion_tokens: 446, total_tokens: 20966 };
  const request = {
    model: "glm-5.3",
    messages: [{ role: "user", content: "x".repeat(9000) }],
  };
  const metadata = { model: "glm-5.3", buffered: true, plan: "account:zai-start-plan" };

  assert.equal(
    sanitizeProviderUsageForRequest(usage, request, FORMATS.OPENAI),
    usage,
    "the complete request makes the native reported token count plausible"
  );
  const incorrectlyEstimated = sanitizeProviderUsageForRequest(
    { ...usage },
    metadata,
    FORMATS.OPENAI
  );
  assert.notEqual(incorrectlyEstimated.prompt_tokens, usage.prompt_tokens);
});

test("native session returns caller tool, binds continuation, and consumes external result once", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-session-test-"));
  let toolResult = "";
  let relayUrl = "";
  let headers: Record<string, string> = {};
  let toolRequest: Promise<void> | undefined;
  let closeCount = 0;
  let releasedWorkspaces = 0;
  let pendingUsageReads = 0;
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
        if (method === "getTaskTokenUsage")
          return {
            inputTokens: 1000,
            outputTokens: 12,
            totalTokens: 1012,
            reasoningTokens: 3,
            cacheReadTokens: 900,
            cacheCreationTokens: 5,
          };
        if (method === "readSession") {
          if (!toolResult && pendingUsageReads++ === 0)
            return { session: { status: "running" }, messages: [] };
          return toolResult
            ? {
                session: { status: "idle" },
                messages: [
                  {
                    info: {
                      finish: "stop",
                      semantics: { kind: "assistant_response" },
                      tokens: {
                        total: 1012,
                        input: 1000,
                        output: 12,
                        reasoning: 3,
                        cache: { read: 900, write: 5 },
                      },
                    },
                    parts: [
                      { type: "reasoning", text: "Checked caller result" },
                      { type: "text", text: toolResult },
                    ],
                  },
                ],
              }
            : {
                session: { status: "running" },
                messages: [
                  {
                    info: {
                      finish: "tool-calls",
                      semantics: { kind: "assistant_response" },
                      tokens: {
                        total: 1012,
                        input: 1000,
                        output: 12,
                        reasoning: 3,
                        cache: { read: 900, write: 5 },
                      },
                    },
                    parts: [],
                  },
                ],
              };
        }
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
    assert.deepEqual(result.usage, {
      inputTokens: 1000,
      outputTokens: 12,
      totalTokens: 1012,
      reasoningTokens: 3,
      cacheReadTokens: 900,
      cacheWriteTokens: 5,
    });
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
    assert.equal(toolResult, "", "invalid continuation must not consume the suspended tool");
    const final = await bridge.execute({ ...base, messages });
    assert.equal(final.text, "unpredictable-client-value");
    assert.deepEqual(final.usage, {
      inputTokens: 1000,
      outputTokens: 12,
      totalTokens: 1012,
      reasoningTokens: 3,
      cacheReadTokens: 900,
      cacheWriteTokens: 5,
    });
    assert.equal(final.reasoning, "Checked caller result");
    await toolRequest;
    assert.equal(closeCount, 0, "sticky native session remains available for the next turn");
    assert.equal(releasedWorkspaces, 0, "sticky workspace remains available for the next turn");
    assert.notDeepEqual(await readdir(root), [], "sticky workspace is retained until expiry");
  } finally {
    await bridge.close();
    assert.equal(closeCount, 1);
    assert.equal(releasedWorkspaces, 1, "bridge shutdown releases the native engine");
    await rm(root, { recursive: true, force: true });
  }
});

test("native session forwards vision attachments with a text prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-session-vision-"));
  let sent: Record<string, unknown> | undefined;
  const bridge = new NativeZcodeSessionBridge({
    workspaceRoot: root,
    pollMs: 1,
    timeoutMs: 1000,
    clientFactory: () => ({
      async start() {},
      async close() {},
      async call(_channel, method, args) {
        const params = (args[0] ?? {}) as Record<string, unknown>;
        if (method === "saveProject") return { id: "vision-project" };
        if (method === "createSession") return { session: { sessionId: "vision-session" } };
        if (method === "sendPrompt") {
          sent = params;
          return { accepted: true };
        }
        if (method === "readSession")
          return {
            session: { status: "idle" },
            messages: [
              {
                info: { finish: "stop", semantics: { kind: "assistant_response" } },
                parts: [{ type: "text", text: "vision accepted" }],
              },
            ],
          };
        if (method === "closeSession" || method === "disposeWorkspace") return true;
        return {};
      },
    }),
  });
  try {
    const result = await bridge.execute({
      scope: "vision-account:start:caller",
      selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
      messages: [{ role: "user", content: "Inspect the attached image." }],
      tools: [],
      attachments: [
        {
          kind: "image",
          filename: "gender.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataBase64: "YWJj",
        },
      ],
    });
    assert.equal(result.text, "vision accepted");
    assert.deepEqual(sent?.attachments, [
      {
        kind: "image",
        filename: "gender.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataBase64: "YWJj",
      },
    ]);
    assert.equal(sent?.content, "Inspect the attached image.");
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

test("native Start quota1005 is a tariff429 rather than a provider outage", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-quota-test-"));
  const bridge = new NativeZcodeSessionBridge({
    workspaceRoot: root,
    clientFactory: () => ({
      async start() {},
      async close() {},
      async call(_channel, method) {
        if (method === "saveProject") return { id: "quota-project" };
        if (method === "createSession") return { session: { sessionId: "quota-session" } };
        if (method === "readSession")
          return {
            session: { status: "error" },
            projection: {
              lastError: {
                code: "1005",
                message: "exceed quota limit",
                attribution: { providerErrorCode: "1005" },
              },
            },
          };
        return {};
      },
    }),
  });
  try {
    await assert.rejects(
      bridge.execute({
        scope: "quota-account:start",
        selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
        messages: [{ role: "user", content: "Probe" }],
        tools: [],
      }),
      { status: 429, message: "ZCode tariff quota or rate limit reached" }
    );
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const statusCode of [429, 503]) {
  test(`native Start only classifies code 3008 as a rate limit with HTTP 429 attribution (${statusCode})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-start-concurrency-"));
    const bridge = new NativeZcodeSessionBridge({
      workspaceRoot: root,
      clientFactory: () => ({
        async start() {},
        async close() {},
        async call(_channel, method) {
          if (method === "saveProject") return { id: "start-project" };
          if (method === "createSession") return { session: { sessionId: "start-session" } };
          if (method === "readSession")
            return {
              session: { status: "error" },
              projection: {
                lastError: {
                  type: "unknown_error",
                  code: "UNKNOWN_ERROR",
                  message: "Turn execution failed",
                  attribution: {
                    source: "provider",
                    statusCode,
                    providerErrorCode: "3008",
                  },
                },
              },
            };
          return {};
        },
      }),
    });
    try {
      await assert.rejects(
        bridge.execute({
          scope: "concurrency-account:start",
          selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
          messages: [{ role: "user", content: "Probe" }],
          tools: [],
        }),
        statusCode === 429
          ? { status: 429, message: "ZCode concurrent request limit reached" }
          : { status: 502, message: "ZCode native session failed" }
      );
    } finally {
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("native session reuses a completed sticky session for the next turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-session-reuse-"));
  let createCount = 0;
  let sendCount = 0;
  let closeCount = 0;
  const prompts: string[] = [];
  const bridge = new NativeZcodeSessionBridge({
    workspaceRoot: root,
    pollMs: 1,
    timeoutMs: 1000,
    continuationTimeoutMs: 1000,
    clientFactory: () => ({
      async start() {},
      async close() {
        closeCount++;
      },
      async call(_channel, method, args) {
        const params = (args[0] || {}) as Record<string, unknown>;
        if (method === "saveProject") return { id: "reuse-project" };
        if (method === "createSession") {
          createCount++;
          return { session: { sessionId: "reuse-session" } };
        }
        if (method === "sendPrompt") {
          sendCount++;
          prompts.push(String(params.content));
          return { accepted: true };
        }
        if (method === "readSession")
          return {
            session: { status: "idle" },
            messages: [
              {
                info: {
                  finish: "stop",
                  semantics: { kind: "assistant_response" },
                  tokens: { input: 10, output: 1, total: 11, reasoning: 0, cache: { read: 9 } },
                },
                parts: [{ type: "text", text: `answer-${sendCount}` }],
              },
            ],
          };
        if (method === "closeSession") return true;
        if (method === "disposeWorkspace") return true;
        throw new Error(`Unexpected method ${method}`);
      },
    }),
  });
  const first = {
    scope: "sticky-scope",
    selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" },
    messages: [{ role: "user", content: "first" }],
    tools: [],
  };
  try {
    const firstResult = await bridge.execute(first);
    assert.equal(firstResult.text, "answer-1");
    const secondResult = await bridge.execute({
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content: "answer-1" },
        { role: "user", content: "second" },
      ],
    });
    assert.equal(secondResult.text, "answer-2");
    assert.equal(createCount, 1);
    assert.equal(sendCount, 2);
    assert.deepEqual(prompts, ["first", "second"]);
    assert.equal(closeCount, 0);
  } finally {
    await bridge.close();
    assert.equal(closeCount, 1);
    await rm(root, { recursive: true, force: true });
  }
});

test("Start emits only current tool-turn reasoning, once per projected response", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-tool-reasoning-"));
  const expected = ["first\n\nsecond", undefined, undefined, undefined, "last"];
  let round = 0;
  let relay: { url: string; headers: { name: string; value: string }[] };
  let chain: Promise<void> | undefined;
  const bridge = new NativeZcodeSessionBridge({
    workspaceRoot: root,
    pollMs: 2,
    timeoutMs: 4000,
    clientFactory: () => ({
      async start() {},
      async close() {},
      async call(_channel, method, args) {
        if (method === "saveProject") return { id: "test-project" };
        if (method === "createSession") {
          relay = (args[0] as { mcpServers: [typeof relay] }).mcpServers[0];
          return { session: { sessionId: "test-session" } };
        }
        if (method === "sendPrompt") {
          chain = (async () => {
            const headers = Object.fromEntries(relay.headers.map((h) => [h.name, h.value]));
            const rpc = (method: string, params = {}) =>
              fetch(relay.url, {
                method: "POST",
                headers,
                body: JSON.stringify({ jsonrpc: "2.0", id: round + 1, method, params }),
              }).then((r) => r.json());
            await rpc("tools/list");
            for (; round < expected.length; round++)
              await rpc("tools/call", { name: "tool_0", arguments: { round } });
          })();
          void chain.catch(() => {});
        }
        if (method === "readSession") {
          const done = round === expected.length;
          const active = round === 4;
          const text = ["first", "duplicate", "outdated", "", "last"][round];
          const info = {
            messageId: ["one", "one", "old", "empty", "five", "final"][round],
            time: { created: round === 2 ? 1 : Date.now() },
            semantics: { kind: "assistant_response" },
            finish: done ? "stop" : active ? undefined : "tool-calls",
          };
          const parts = [
            ...(text ? [{ type: "reasoning", text }] : []),
            ...(round === 0 ? [{ type: "reasoning", text: "second" }] : []),
            ...(active ? [{ type: "tool", callId: "current" }] : []),
            ...(done ? [{ type: "text", text: "done" }] : []),
          ];
          return {
            session: { status: done ? "idle" : "running" },
            projection: {
              activeToolCalls: active ? [{ toolCallId: "current", status: "running" }] : [],
            },
            messages: [{ info, parts }],
          };
        }
        return {};
      },
    }),
  });
  const messages: Record<string, unknown>[] = [{ role: "user", content: "Use echo" }];
  const request = {
    scope: "test",
    messages,
    selection: { providerId: "account:zai-start-plan", modelId: "test" },
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
  };
  try {
    for (const [index, value] of expected.entries()) {
      const result = await bridge.execute({ ...request, messages: [...messages] });
      assert.equal(result.finishReason, "tool-calls");
      assert.equal(result.reasoning, value, `round ${index}`);
      const [call] = result.toolCalls as { id: string; name: string; input: object }[];
      assert.deepEqual(call.input, { round: index });
      messages.push(
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
        { role: "tool", tool_call_id: call.id, content: "ok" }
      );
    }
    assert.equal((await bridge.execute(request)).text, "done");
    await chain;
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
