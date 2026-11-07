import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.ZCODE_CANARY_URL || "http://127.0.0.1:39172";
const model = process.env.ZCODE_CANARY_MODEL || "zc-start/glm-5.3-flash";
const messages = [
  {
    role: "user",
    content:
      "Call caller_probe with label native-http-test, then reply with exactly the random value returned by the tool.",
  },
];
const tools = [
  {
    type: "function",
    function: {
      name: "caller_probe",
      description: "Get the calling application's random value.",
      parameters: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
      },
    },
  },
];
async function request(messages) {
  const started = Date.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.ZCODE_CANARY_CONNECTION_ID
        ? { "x-omniroute-connection": process.env.ZCODE_CANARY_CONNECTION_ID }
        : {}),
      ...(process.env.ZCODE_CANARY_API_KEY
        ? { authorization: `Bearer ${process.env.ZCODE_CANARY_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  console.log(
    JSON.stringify({
      stage: "http",
      status: response.status,
      elapsedMs: Date.now() - started,
      body: text.slice(0, 8000),
    })
  );
  assert.equal(response.status, 200);
  return JSON.parse(text);
}
const first = await request(messages);
assert.equal(first.choices[0].finish_reason, "tool_calls");
const assistant = first.choices[0].message;
assert.equal(assistant.tool_calls.length, 1);
const call = assistant.tool_calls[0];
assert.equal(call.function.name, "caller_probe");
assert.equal(JSON.parse(call.function.arguments).label, "native-http-test");
const result = `EXTERNAL_HTTP_RESULT_${randomUUID()}`;
console.log(JSON.stringify({ stage: "caller-executed", callId: call.id, result }));
const final = await request([
  ...messages,
  assistant,
  { role: "tool", tool_call_id: call.id, content: result },
]);
assert.equal(final.choices[0].finish_reason, "stop");
assert.equal(final.choices[0].message.content.trim(), result);
console.log(JSON.stringify({ stage: "PASS", model, result }));
