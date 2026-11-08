import fs from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const key = fs.readFileSync("/home/roomhacker/.config/llm-keys/opencode-100.key", "utf8").trim();
const model = "glm-5.3-flash-minimax-m3.1";
const input = [
  {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "Call caller_probe exactly once with label responses-check, then reply exactly with its returned value.",
      },
    ],
  },
];
const tools = [
  {
    type: "function",
    name: "caller_probe",
    description: "Get caller value",
    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  },
];
async function request(input) {
  const t = Date.now();
  const r = await fetch("http://127.0.0.1:20128/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
      "user-agent": "opencode/start-recovery-canary",
    },
    body: JSON.stringify({ model, input, tools, stream: false }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  console.log(
    JSON.stringify({
      status: r.status,
      ms: Date.now() - t,
      model: j.model,
      output: j.output,
      usage: j.usage,
      error: j.error,
    })
  );
  assert.equal(r.status, 200);
  return j;
}
const first = await request(input);
const call = first.output.find((x) => x.type === "function_call");
assert.ok(call);
const value = "RESPONSES_" + randomUUID();
input.push(
  ...first.output,
  { type: "function_call_output", call_id: call.call_id, output: value },
  {
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text: "The caller already ran the tool. Preserve its returned value. No more tool calls.",
      },
    ],
  }
);
const final = await request(input);
assert.equal(
  final.output
    .filter((x) => x.type === "message")
    .flatMap((x) => x.content)
    .map((x) => x.text || "")
    .join("")
    .trim(),
  value
);
console.log("PASS responses combo recovery");
