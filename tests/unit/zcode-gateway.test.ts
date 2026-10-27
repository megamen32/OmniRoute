import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executeZcodeGateway, nativeZcodeBody } from "../../open-sse/executors/zcode/gateway.ts";
import { buildZcodeModelRequest } from "../../open-sse/executors/zcode.ts";
import { ZCODE_MODELS } from "../../open-sse/config/providers/registry/zcode/index.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";

const TARGET = "https://api.z.ai/api/anthropic/v1/messages";
const body = { messages: [{ role: "user", content: "hello" }], max_tokens: 2048 };
const input: ExecuteInput = { model: "glm-5.3-flash", body, stream: true, credentials: {} };
const native = buildZcodeModelRequest(body);
const encoder = new TextEncoder();
const event = (type: string, data: Record<string, unknown>) =>
  "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";
const start =
  event("message_start", {
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "GLM-5.3-Flash",
      content: [],
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  }) +
  event("content_block_start", {
    index: 1,
    content_block: { type: "thinking", thinking: "" },
  }) +
  event("content_block_delta", {
    index: 1,
    delta: { type: "thinking_delta", thinking: "private reasoning" },
  }) +
  event("content_block_stop", { index: 1 }) +
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
const delta = (text: string) =>
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
const end =
  event("content_block_stop", { index: 0 }) +
  event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
  event("message_stop", {});

function fixture() {
  return { key: "fixture-" + randomUUID() + ".synthetic-secret" };
}
function backend(t: TestContext, key: string, respond: () => Response) {
  const counts = { inference: 0 };
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit = {}) => {
    const h = new Headers(options.headers);
    assert.equal(url, TARGET, "native routing must not use the generic API");
    counts.inference++;
    requestSignal = options.signal as AbortSignal | undefined;
    assert.equal(h.get("x-api-key"), key);
    assert.equal(h.get("anthropic-version"), "2023-06-01");
    assert.equal(h.has("x-client-sig"), false, "the documented Coding Plan HTTP route is unsigned");
    const request = JSON.parse(String(options.body));
    if (request.stream === true)
      assert.equal(h.get("accept"), "text/event-stream", "stream requests must negotiate SSE");
    assert.equal(request.model, "GLM-5.3-Flash");
    assert.deepEqual(request.output_config, { effort: "low" });
    return respond();
  });
  return {
    counts,
    get requestSignal() {
      return requestSignal;
    },
  };
}

test("native request maps model, budget and reasoning effort", () => {
  assert.deepEqual(nativeZcodeBody(input, native), {
    model: "GLM-5.3-Flash",
    max_tokens: 2048,
    metadata: {},
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    thinking: { type: "enabled" },
    output_config: { effort: "low" },
    stream: true,
  });
});

test("GLM-5.3 models expose low/medium/max and preserve native effort through the gateway", () => {
  for (const id of ["glm-5.3", "glm-5.3-flash"]) {
    const metadata = ZCODE_MODELS.find((model) => model.id === id);
    assert.deepEqual(metadata?.supportedThinkingEfforts, ["low", "medium", "max"]);
    const requestInput = { ...input, model: id };
    for (const [requested, expected] of [
      ["low", "low"],
      ["medium", "high"],
      ["high", "high"],
      ["max", "max"],
    ]) {
      const requestBody = { ...body, reasoning_effort: requested },
        result = nativeZcodeBody(
          { ...requestInput, body: requestBody },
          buildZcodeModelRequest(requestBody)
        );
      assert.equal((result.output_config as Record<string, unknown>).effort, expected, id);
    }
  }
});

test("explicit max is not downgraded by a low default in either effort field", () => {
  for (const requestBody of [
    { ...body, reasoning_effort: "max", output_config: { effort: "low" } },
    { ...body, reasoning_effort: "low", output_config: { effort: "max" } },
  ]) {
    const result = nativeZcodeBody(
      { ...input, body: requestBody },
      buildZcodeModelRequest(requestBody)
    );
    assert.equal((result.output_config as Record<string, unknown>).effort, "max");
  }
});

test("native request maps no-effort to the minimum supported low level", () => {
  for (const requestBody of [
    { ...body, reasoning_effort: "none" },
    { ...body, output_config: { effort: "none" } },
  ]) {
    const requestInput = { ...input, body: requestBody };
    assert.equal(
      (
        nativeZcodeBody(requestInput, buildZcodeModelRequest(requestBody)).output_config as Record<
          string,
          unknown
        >
      ).effort,
      "low"
    );
  }
});

test(
  "official Coding Plan HTTP auth is scoped and deltas arrive before completion",
  { timeout: 10000 },
  async (t) => {
    const f = fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>,
      complete = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(start + delta("first ")));
      },
    });
    const { counts } = backend(
      t,
      f.key,
      () => new Response(source, { headers: { "content-type": "text/event-stream" } })
    );
    const result = await executeZcodeGateway(input, native, { apiKey: f.key });
    assert.ok(!(result instanceof Response));
    assert.equal(result.transport, "zcode-native-gateway");
    const reader = result.response.body!.getReader(),
      decoder = new TextDecoder();
    let text = "";
    while (!text.includes("first ")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(complete, false);
    for (const byte of encoder.encode(delta("Привет"))) controller.enqueue(new Uint8Array([byte]));
    controller.enqueue(encoder.encode(end));
    complete = true;
    controller.close();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(text.includes("Привет"));
    assert.equal(
      text.includes("</think>"),
      false,
      "OpenAI clients must not receive the marker in visible text"
    );
    assert.ok(text.includes("reasoning_content"));
    assert.ok(text.includes("private reasoning"));
    assert.ok(text.includes("[DONE]"));
    assert.deepEqual(counts, { inference: 1 });
    assert.equal(JSON.stringify(result.transformedBody).includes(f.key), false);
  }
);

test(
  "native gateway bounds stream read-ahead before the client attaches",
  { timeout: 10000 },
  async (t) => {
    const f = fixture();
    const totalFrames = 200;
    let produced = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(start + delta("first ")));
        produced++;
      },
      pull(controller) {
        if (produced >= totalFrames) {
          controller.enqueue(encoder.encode(end));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(delta("x".repeat(80))));
        produced++;
      },
    });
    backend(
      t,
      f.key,
      () => new Response(source, { headers: { "content-type": "text/event-stream" } })
    );

    const result = await executeZcodeGateway(input, native, { apiKey: f.key });
    assert.ok(!(result instanceof Response));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      produced < totalFrames,
      `the native transform must backpressure before the client attaches; produced ${produced}/${totalFrames} frames`
    );

    const reader = result.response.body!.getReader();
    let responseText = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      responseText += new TextDecoder().decode(chunk.value);
    }
    assert.ok(responseText.includes("[DONE]"));
  }
);

test("tool output and usage translate; upstream refusal is returned without replay", async (t) => {
  const f = fixture();
  let status = 200;
  const { counts } = backend(t, f.key, () =>
    status === 200
      ? Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "GLM-5.3-Flash",
          content: [{ type: "tool_use", id: "call_1", name: "get_value", input: { value: 17 } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 7, output_tokens: 4 },
        })
      : Response.json(
          { error: { type: "rate_limit_error", message: "fixture quota exhausted" } },
          { status, headers: { "retry-after": "30" } }
        )
  );
  const result = await executeZcodeGateway({ ...input, stream: false }, native, { apiKey: f.key });
  assert.ok(!(result instanceof Response));
  const reply = await result.response.json();
  assert.equal(reply.choices[0].message.tool_calls[0].function.name, "get_value");
  assert.equal(reply.usage.prompt_tokens, 7);
  for (const code of [429, 413, 503]) {
    status = code;
    const refusal = await executeZcodeGateway(input, native, { apiKey: f.key });
    assert.ok(refusal instanceof Response);
    assert.equal(refusal.status, code);
    assert.equal(refusal.headers.get("retry-after"), "30");
  }
  assert.deepEqual(counts, { inference: 4 });
});

test("missing scoped credential and pre-aborted request do not dispatch", async (t) => {
  const f = fixture();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("unexpected network");
  });
  const missing = await executeZcodeGateway({ ...input, credentials: { apiKey: f.key } }, native);
  assert.ok(missing instanceof Response);
  assert.equal(missing.status, 401);
  const controller = new AbortController();
  controller.abort();
  const aborted = await executeZcodeGateway({ ...input, signal: controller.signal }, native, {
    apiKey: f.key,
  });
  assert.ok(aborted instanceof Response);
  assert.equal(aborted.status, 499);
  assert.equal(calls, 0);
});

test("consumer cancellation reaches the Coding Plan stream without replay", async (t) => {
  const f = fixture();
  const backendState = backend(
    t,
    f.key,
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(start + delta("first ")));
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
  );
  const result = await executeZcodeGateway(input, native, { apiKey: f.key });
  assert.ok(!(result instanceof Response));
  const reader = result.response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  assert.equal(backendState.requestSignal?.aborted, true);
  assert.equal(backendState.counts.inference, 1);
});
