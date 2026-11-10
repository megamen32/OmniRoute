import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataDir } from "../_setup/tempDataDir.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";
import type { ZcodeCallOptions } from "../../open-sse/executors/zcodeProtocol.ts";

const { dir, cleanup } = createTempDataDir("native-simple-profile-");
const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.ts");
const { NativeZcodeHostClient } =
  await import("../../open-sse/executors/zcode/nativeHostClient.ts");
const { NativeZcodeSessionBridge } =
  await import("../../open-sse/executors/zcode/nativeSession.ts");
const { nativeZcodeHosts } = await import("../../open-sse/executors/zcode/nativeHostManager.ts");
test.after(cleanup);

type RecordValue = Record<string, unknown>;
type Call = { channel: string; method: string; args: unknown[]; options?: ZcodeCallOptions };
const body = { messages: [{ role: "user", content: "Reply" }] };
let sequence = 0;
function fixture(
  t: TestContext,
  options: {
    generate?: (params: RecordValue) => Promise<unknown>;
    close?: () => Promise<void>;
    getViewError?: Error;
  } = {}
) {
  const serverRoot = join(dir, String(sequence++), ".zcode", "server");
  const calls: Call[] = [];
  let bridgeCalls = 0;
  t.mock.method(nativeZcodeHosts, "ensure", async () => serverRoot);
  t.mock.method(NativeZcodeHostClient.prototype, "start", async () => {});
  t.mock.method(NativeZcodeHostClient.prototype, "close", options.close || (async () => {}));
  t.mock.method(NativeZcodeSessionBridge.prototype, "execute", async () => {
    bridgeCalls++;
    throw new Error("Session bridge is forbidden for the simple profile");
  });
  t.mock.method(
    NativeZcodeHostClient.prototype,
    "call",
    async (channel: string, method: string, args: unknown[], callOptions?: ZcodeCallOptions) => {
      calls.push({ channel, method, args, options: callOptions });
      if (method === "getView") {
        if (options.getViewError) throw options.getViewError;
        return {
          providers: ["zai", "bigmodel"].flatMap((family) =>
            ["start-plan", "individual-coding-plan"].map((plan) => ({
              providerId: `account:${family}-${plan}`,
              models: [
                {
                  modelId: "GLM-5.3-Flash",
                  config: {
                    optionSpecs: {
                      reasoningLevel: { values: ["low", "high"] },
                      maxOutputTokens: { max: 64000 },
                    },
                  },
                },
              ],
            }))
          ),
        };
      }
      assert.equal(channel, "zcode-agent");
      assert.equal(method, "generateWorkspaceText", "no project/session/MCP RPC is allowed");
      return options.generate
        ? options.generate(args[0] as RecordValue)
        : { text: "ready", finishReason: "stop" };
    }
  );
  return {
    serverRoot,
    calls,
    bridgeCalls: () => bridgeCalls,
    async execute(
      requestBody: RecordValue = body,
      overrides: Partial<ExecuteInput> = {},
      executorOptions = {}
    ) {
      const result = await new ZcodeExecutor(executorOptions).execute({
        model: "glm-5.3-flash",
        body: requestBody,
        stream: false,
        credentials: {
          connectionId: "fixture",
          authType: "oauth",
          providerSpecificData: { family: "zai" },
        },
        ...overrides,
      });
      const response = "response" in result ? result.response : result;
      return { result, response, json: await response.json() };
    },
  };
}

test("simple native profile returns tools and accepts caller tool results without sessions or projects", async (t) => {
  let turn = 0;
  const f = fixture(t, {
    generate: async () =>
      ++turn === 1
        ? {
            text: "",
            finishReason: "tool-calls",
            toolCalls: [{ id: "call_plain", name: "echo", input: { value: 7 } }],
            usage: { inputTokens: 100, outputTokens: 5 },
          }
        : {
            text: "caller-result",
            finishReason: "stop",
            usage: { inputTokens: 110, outputTokens: 4 },
          },
  });
  const tools = [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }];
  const firstBody = { ...body, tools, max_tokens: 999999 };
  const first = await f.execute(firstBody);
  assert.equal(first.response.status, 200);
  assert.equal(first.json.choices[0].finish_reason, "tool_calls");
  const call = first.json.choices[0].message.tool_calls[0];
  const secondBody = {
    tools,
    messages: [
      ...body.messages,
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "caller-result" },
    ],
  };
  const second = await f.execute(secondBody);
  assert.equal(second.response.status, 200);
  assert.equal(second.json.choices[0].message.content, "caller-result");
  assert.equal(second.json.usage.prompt_tokens, 110);
  const generated = f.calls.filter((call) => call.method === "generateWorkspaceText");
  assert.equal(generated.length, 2);
  const initial = generated[0].args[0] as RecordValue;
  const continued = generated[1].args[0] as RecordValue;
  assert.deepEqual(initial.tools, [{ name: "echo", inputSchema: { type: "object" } }]);
  assert.deepEqual(continued.messages, [
    ...body.messages,
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_plain", name: "echo", input: { value: 7 } }],
    },
    { role: "tool", content: "caller-result", toolCallId: "call_plain", toolName: "echo" },
  ]);
  assert.equal(initial.querySource, "omniroute");
  assert.equal(initial.maxOutputTokens, 64000);
  assert.equal(continued.maxOutputTokens, 64000);
  assert.equal(initial.workspacePath, continued.workspacePath);
  assert.equal(initial.workspaceIdentity, initial.workspacePath);
  assert.equal((await stat(String(initial.workspacePath))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(String(initial.workspacePath)), []);
  assert.equal(f.bridgeCalls(), 0);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["getView", "generateWorkspaceText", "getView", "generateWorkspaceText"]
  );
  assert.equal("transformedBody" in second.result && second.result.transformedBody, secondBody);
});

test("CLI profile is written and read back before boot with MCP/plugins/hooks/memory/subagent disabled", async (t) => {
  const f = fixture(t);
  const path = join(f.serverRoot, "..", "cli", "config.json");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      unrelated: "keep",
      features: { mcp: true, memory: true, subagent: true, other: true },
      mcp: { servers: { foreign: {} } },
      plugins: { enabled: true },
      hooks: { enabled: true },
    })
  );
  t.mock.method(NativeZcodeHostClient.prototype, "start", async () => {
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(config.features, { mcp: false, memory: false, subagent: false, other: true });
    assert.deepEqual(config.mcp.servers, {});
    assert.equal(config.plugins.enabled, false);
    assert.equal(config.hooks.enabled, false);
    assert.equal(config.unrelated, "keep");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
  const result = await f.execute();
  assert.equal(result.response.status, 200);
  assert.equal(f.bridgeCalls(), 0);
});

for (const family of ["zai", "bigmodel"])
  for (const plan of ["start", "individual"]) {
    test(`simple profile pins ${family}/${plan} instead of a default account`, async (t) => {
      const f = fixture(t);
      const result = await f.execute(
        body,
        {
          credentials: {
            connectionId: "fixture",
            authType: "oauth",
            providerSpecificData: { family },
          },
        },
        { provider: `zcode-${plan}` }
      );
      assert.equal(result.response.status, 200);
      const params = f.calls.find((call) => call.method === "generateWorkspaceText")!
        .args[0] as RecordValue;
      assert.equal(
        (params.selection as RecordValue).providerId,
        `account:${family}-${plan === "start" ? "start-plan" : "individual-coding-plan"}`
      );
      assert.equal(
        ((params.selection as RecordValue).options as RecordValue).reasoningLevel,
        "high"
      );
    });
  }

for (const [kind, error, status, code] of [
  [
    "quota",
    Object.assign(new Error("native quota"), { providerCode: 1310 }),
    429,
    "insufficient_quota",
  ],
  ["error", new Error("original native fault"), 502, "bad_gateway"],
] as const) {
  test(`late cleanup abort preserves already received ${kind}`, async (t) => {
    const controller = new AbortController();
    const f = fixture(t, {
      generate: async () => {
        throw error;
      },
      close: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    const result = await f.execute(body, { signal: controller.signal });
    assert.equal(result.response.status, status);
    assert.equal(result.json.error.code, code);
    assert.equal(result.json.notSubmitted, undefined);
    if (kind === "error") assert.match(result.json.error.message, /original native fault/);
  });
}

test("a completed text survives a late cleanup abort", async (t) => {
  const controller = new AbortController();
  const f = fixture(t, {
    close: async () => {
      controller.abort();
    },
  });
  const result = await f.execute(body, { signal: controller.signal });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.choices[0].message.content, "ready");
});

test("provider route rejection is request-scoped and cannot ban a shared account", async (t) => {
  const f = fixture(t, {
    generate: async () => {
      throw Object.assign(new Error("safe blocked route"), { providerReason: "unusual_activity" });
    },
  });
  const result = await f.execute();
  assert.equal(result.response.status, 502);
  assert.equal(result.json.error.code, "upstream_response_failed");
  assert.equal(result.json.error.type, "upstream_response_failed");
  assert.equal(
    result.json.error.message,
    "ZCode text-generation request context was rejected by upstream"
  );
  assert.equal(result.json.notSubmitted, undefined);
  const { isRequestScopedUpstreamFailure } =
    await import("../../open-sse/services/combo/comboPredicates.ts");
  assert.equal(isRequestScopedUpstreamFailure(result.json.error), true);
});

test("an unconfirmed native RPC business code is not enough to claim exhausted quota", async (t) => {
  const f = fixture(t, {
    generate: async () => {
      throw Object.assign(new Error("ZCode host request failed"), { providerCode: 1005 });
    },
  });
  const result = await f.execute();
  assert.equal(result.response.status, 502);
  assert.equal(result.json.error.code, "bad_gateway");
});

for (const mode of ["abort", "deadline"] as const) {
  test(`simple native generation observes ${mode} during the awaited RPC`, async (t) => {
    const controller = new AbortController();
    let entered: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: ((value: unknown) => void) | undefined;
    const f = fixture(t, {
      generate: async () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const operation = f.execute(
      body,
      { signal: controller.signal },
      { turnTimeoutMs: mode === "deadline" ? 100 : 1000 }
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reached,
        operation.then(() => {
          throw new Error("generation RPC never started");
        }),
      ]);
      if (mode === "abort") controller.abort();
      const result = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error("RPC did not observe cancellation")), 500);
        }),
      ]);
      assert.equal(result.response.status, mode === "abort" ? 499 : 504);
    } finally {
      clearTimeout(guard);
      release?.({ text: "late" });
      await operation;
    }
  });
}
