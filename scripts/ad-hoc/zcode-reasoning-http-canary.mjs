import assert from "node:assert/strict";
const endpoint = process.env.ZCODE_CANARY_URL || "http://127.0.0.1:20128/v1/chat/completions";
const key = process.env.ZCODE_CANARY_API_KEY;
if (!key) throw new Error("Missing protected canary credential");
for (const stream of [false, true]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent": "opencode/zcode-reasoning-canary",
    },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: "zcode-individual/glm-5.3",
      stream,
      messages: [
        {
          role: "user",
          content:
            "This is a formatting test. Return exactly this literal sample, with no explanation or tools: <think>FORMAT_CHECK</think>\n[COMPRESSED:aging:fullSummary] [COMPRESSED:summary] FORMAT_OK",
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const messages = stream
    ? raw
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta)
        .filter(Boolean)
    : [JSON.parse(raw).choices[0].message];
  const content = messages.map((m) => m.content || "").join("");
  const reasoning = messages.map((m) => m.reasoning_content || "").join("");
  assert.equal(content.trim(), "FORMAT_OK");
  assert.match(reasoning, /FORMAT_CHECK/);
  assert.doesNotMatch(content, /<\/?think>|\[COMPRESSED:/);
  console.log(JSON.stringify({ stage: "PASS", stream, content, reasoningSeparated: true }));
}
