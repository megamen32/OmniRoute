import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const fixture = join(process.cwd(), "tests/fixtures/fake-mcode-exec.mjs");

async function loadMinimaxCodeExecutor() {
  return import("../../open-sse/executors/minimax-code.ts");
}

function requestBody() {
  return {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Reply with a short status." },
    ],
  };
}

test("MiniMax Code accepts its own models and rejects unsafe/unknown ids", async () => {
  const { resolveMinimaxCodeModel } = await loadMinimaxCodeExecutor();
  assert.deepEqual(resolveMinimaxCodeModel("MiniMax-M3.1-Flash"), {
    ok: true,
    model: "MiniMax-M3.1-Flash",
  });
  assert.deepEqual(resolveMinimaxCodeModel("minimax-code/MiniMax-M3"), {
    ok: true,
    model: "MiniMax-M3",
  });
  assert.deepEqual(resolveMinimaxCodeModel("mmcode/MiniMax-M3.1-Flash"), {
    ok: true,
    model: "MiniMax-M3.1-Flash",
  });
  assert.equal(resolveMinimaxCodeModel("-unexpected").ok, false);
  assert.equal(resolveMinimaxCodeModel("unknown-model").ok, false);
});

test("MiniMax Code builds a one-shot CLI run against the local profile", async () => {
  const { buildMinimaxCodeExecArgs } = await loadMinimaxCodeExecutor();
  const args = buildMinimaxCodeExecArgs({
    model: "MiniMax-M3.1-Flash",
    cwd: "/tmp/workspace",
    maxSteps: 1,
    permission: "off",
    timeoutMs: 180000,
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "--model", "minimax/MiniMax-M3.1-Flash"]);
  assert.ok(args.includes("--output-format"));
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--input") + 1], "-");
  assert.equal(args[args.indexOf("--cwd") + 1], "/tmp/workspace");
  assert.equal(args[args.indexOf("--max-steps") + 1], "1");
  assert.equal(args[args.indexOf("--permission") + 1], "off");
  assert.equal(args[args.indexOf("--mode") + 1], "lightweight");
});

test("MiniMax Code can run the full agent context mode", async () => {
  const { buildMinimaxCodeExecArgs } = await loadMinimaxCodeExecutor();
  const args = buildMinimaxCodeExecArgs({
    model: "MiniMax-M3.1-Flash",
    cwd: "/tmp/workspace",
    mode: "standard",
  });
  assert.equal(args[args.indexOf("--mode") + 1], "standard");
});

test("MiniMax Code folds stream-json events into the final answer and usage", async () => {
  const { applyExecEvent, createExecState } = await loadMinimaxCodeExecutor();
  const state = createExecState();
  const delta1 = applyExecEvent(state, {
    type: "item.started",
    item: { type: "agent_message", contentDelta: "При" },
  });
  const delta2 = applyExecEvent(state, {
    type: "item.updated",
    item: { type: "agent_message", contentDelta: "вет" },
  });
  assert.equal(delta1, "При");
  assert.equal(delta2, "вет");
  applyExecEvent(state, {
    type: "item.completed",
    item: { type: "agent_message", content: "Привет" },
  });
  applyExecEvent(state, { type: "turn.completed", usage: { inputTokens: 5, outputTokens: 2 } });
  applyExecEvent(state, {
    type: "exec.completed",
    result: { status: "succeeded", output: "Привет" },
  });
  assert.equal(state.text, "Привет");
  assert.equal(state.status, "succeeded");
  assert.equal(state.usage?.outputTokens, 2);
  assert.equal(state.error, null);
});

test("MiniMax Code reports a failed run as an error", async () => {
  const { applyExecEvent, createExecState } = await loadMinimaxCodeExecutor();
  const state = createExecState();
  applyExecEvent(state, {
    type: "exec.completed",
    result: { status: "failed", error: "model unavailable" },
  });
  assert.equal(state.error, "model unavailable");
});

test("MiniMax Code runs the local CLI and returns an OpenAI chat completion", async () => {
  const { MinimaxCodeExecutor } = await loadMinimaxCodeExecutor();
  const executor = new MinimaxCodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });

  const result = await executor.execute({
    model: "MiniMax-M3.1-Flash",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "MiniMax-M3.1-Flash");
  assert.equal(body.choices?.[0]?.message?.role, "assistant");
  assert.equal(body.choices?.[0]?.message?.content, "fake minimax code response");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
  assert.equal(body.usage?.completion_tokens, 7);
  assert.equal(body.usage?.estimated, false);
});

test("MiniMax Code gives the agent real tools when the transport is pinned to the CLI", async () => {
  const { MinimaxCodeExecutor } = await loadMinimaxCodeExecutor();
  const seen: string[] = [];
  const steps: number[] = [];
  const executor = new MinimaxCodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    transport: "cli",
    runner: async (options) => {
      seen.push(options.mode);
      steps.push(options.maxSteps);
      return {
        text: "ok",
        usage: null,
        state: { text: "ok", usage: null, status: "succeeded", error: null },
      };
    },
  });

  await executor.execute({
    model: "MiniMax-M3.1-Flash",
    body: {
      ...requestBody(),
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    },
    stream: false,
    credentials: {},
  });
  assert.deepEqual(seen, ["standard"]);
  // An agentic run needs a real step budget so the model can use tools and
  // still report the result back.
  assert.deepEqual(steps, [8]);

  // A plain chat request stays on the lightweight profile (no tools, fast).
  await executor.execute({
    model: "MiniMax-M3.1-Flash",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  assert.deepEqual(seen, ["standard", "lightweight"]);
  assert.deepEqual(steps, [8, 1]);
});

test("MiniMax Code routes client tools to the managed gateway and plain chat to the CLI", async () => {
  const { resolveMinimaxCodeTransport } = await loadMinimaxCodeExecutor();
  // Client tools live on the client machine: the model must call them through
  // the native tool protocol, so the run goes to the managed gateway.
  assert.equal(resolveMinimaxCodeTransport("auto", true), "gateway");
  // Plain chat has nothing to execute and stays on the fast local CLI.
  assert.equal(resolveMinimaxCodeTransport("auto", false), "cli");
  // An explicit choice always wins.
  assert.equal(resolveMinimaxCodeTransport("cli", true), "cli");
  assert.equal(resolveMinimaxCodeTransport("gateway", false), "gateway");
});

test("MiniMax Code streams assistant deltas as OpenAI SSE when stream=true", async () => {
  const { MinimaxCodeExecutor } = await loadMinimaxCodeExecutor();
  const executor = new MinimaxCodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });

  const result = await executor.execute({
    model: "MiniMax-M3.1-Flash",
    body: requestBody(),
    stream: true,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /data: \[DONE\]/);
  // The client concatenates the streamed deltas into the final answer.
  const deltas = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => {
      const chunk = JSON.parse(line.slice("data: ".length));
      return chunk.choices?.[0]?.delta?.content || "";
    })
    .join("");
  assert.equal(deltas, "fake minimax code response");
});

test("MiniMax Code returns native tool calls from the managed gateway", async () => {
  const { MinimaxCodeExecutor } = await loadMinimaxCodeExecutor();
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");

  const dir = await mkdtemp(join(tmpdir(), "mmcode-auth-"));
  const authFile = join(dir, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({
      schemaVersion: 1,
      records: {
        "com.minimax.mcode.oauth.prod.en": {
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          clientId: "mcode-public",
          scopes: ["agent.default"],
          audience: "agent-backend",
          expiresAtMs: Date.now() + 3_600_000,
          generation: 1,
        },
      },
    })
  );

  let seenBody: Record<string, unknown> = {};
  let seenAuth = "";
  const server = createServer((req, res) => {
    seenAuth = String(req.headers.authorization || "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [
            { type: "text", text: "Checking the time." },
            { type: "tool_use", id: "call_1", name: "get_time", input: { city: "Moscow" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 31, output_tokens: 9 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const previousUrl = process.env.MINIMAX_CODE_GATEWAY_URL;
  process.env.MINIMAX_CODE_GATEWAY_URL = `http://127.0.0.1:${port}/mavis/api/v1/llm/v1/messages`;

  try {
    const executor = new MinimaxCodeExecutor({ authFile });
    const result = await executor.execute({
      model: "MiniMax-M3.1-Flash",
      body: {
        messages: [{ role: "user", content: "What time is it in Moscow?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_time",
              description: "Current time in a city",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      },
      stream: false,
      credentials: {},
    });
    const response = "response" in result ? result.response : result;
    assert.equal(response.status, 200);
    const body = await response.json();
    const choice = body.choices?.[0];
    assert.equal(choice?.finish_reason, "tool_calls");
    assert.equal(choice?.message?.content, "Checking the time.");
    const call = choice?.message?.tool_calls?.[0];
    assert.equal(call?.id, "call_1");
    assert.equal(call?.type, "function");
    assert.equal(call?.function?.name, "get_time");
    assert.deepEqual(JSON.parse(call?.function?.arguments), { city: "Moscow" });
    assert.equal(body.usage?.prompt_tokens, 31);
    assert.equal(body.usage?.completion_tokens, 9);

    // The upstream call carries the managed-gateway contract.
    assert.equal(seenAuth, "Bearer test-access-token");
    assert.equal(seenBody.model, "MiniMax-M3.1-Flash");
    assert.equal((seenBody.tools as Record<string, unknown>[])[0].name, "get_time");
    assert.equal(seenBody.stream, false);
  } finally {
    if (previousUrl === undefined) delete process.env.MINIMAX_CODE_GATEWAY_URL;
    else process.env.MINIMAX_CODE_GATEWAY_URL = previousUrl;
    server.close();
  }
});
