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
