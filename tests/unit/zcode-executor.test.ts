import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ZcodeExecutor, resolveZcodeModel } from "../../open-sse/executors/zcode.ts";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");

function requestBody() {
  return {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Reply with a short status." },
    ],
  };
}

test("ZCode accepts GLM Coding Plan models and rejects unsafe/unknown ids", () => {
  assert.deepEqual(resolveZcodeModel("glm-5.2"), { ok: true, model: "glm-5.2" });
  assert.equal(resolveZcodeModel("-unexpected").ok, false);
  assert.equal(resolveZcodeModel("unknown-model").ok, false);
});

test("ZCode runs a local app-server turn and returns an OpenAI chat completion", async () => {
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    pollIntervalMs: 1,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "glm-5.2");
  assert.equal(body.choices?.[0]?.message?.role, "assistant");
  assert.equal(body.choices?.[0]?.message?.content, "fake zcode response");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
});

test("ZCode creates one-shot sessions with supported immediate persistence", async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const executor = new ZcodeExecutor({
    clientFactory: () => ({
      start: async () => undefined,
      close: async () => undefined,
      call: async (_service, method, params) => {
        calls.push({ method, params });
        if (method === "initialize") return { available: true };
        if (method === "createSession") return { sessionId: "session-1" };
        if (method === "setModel") return {};
        if (method === "sendPrompt") {
          return {
            session: { sessionId: "session-1", status: "completed" },
            messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] }],
          };
        }
        if (method === "disposeSession") return {};
        throw new Error(`unexpected method: ${method}`);
      },
    }),
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  const created = calls.find((call) => call.method === "createSession");
  assert.equal((created?.params[0] as { persistence?: string }).persistence, "immediate");
  const selected = calls.find((call) => call.method === "setModel");
  assert.equal(
    ((selected?.params[0] as { model?: { modelId?: string } }).model?.modelId),
    "GLM-5.2"
  );
});

test("ZCode buffers the completed turn into OpenAI SSE when stream=true", async () => {
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    pollIntervalMs: 1,
  });

  const result = await executor.execute({
    model: "glm-5.2-high",
    body: requestBody(),
    stream: true,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(text, /fake zcode response/);
  assert.match(text, /data: \[DONE\]/);
});
