#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Exercise the standard Responses hosted-tool contract consumed by Airlock.
// Use the existing local OmniRoute client credential; never print it.
const base = (process.env.OMNIROUTE_TEST_URL || "https://omniroute.bezrabotnyi.com").replace(
  /\/$/,
  ""
);
const auth = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".local/share/opencode/auth.json"), "utf8")
);
const key = auth.omniroute?.type === "api" ? auth.omniroute.key : "";
assert.ok(key, "The configured local OmniRoute client credential is required");
const headers = { "Content-Type": "application/json", Authorization: "Bearer " + key };
const query = "Yandex Cloud Search API Wordstat documentation";
const validUrl = (url) =>
  typeof url === "string" &&
  /^https?:\/\/[^/\\\s]/i.test(url) &&
  (() => {
    try {
      const parsed = new URL(url);
      return !!parsed.hostname && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  })();
async function request(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    route + " HTTP " + response.status + ": " + text.slice(0, 160)
  );
  return text;
}
const direct = JSON.parse(await request("/v1/search", { query, max_results: 3 }));
assert.ok(direct.results?.length, "Default search must return usable results");
assert.ok(
  direct.results.every((result) => validUrl(result.url)),
  "All direct search URLs must be valid"
);
assert.equal(direct.provider, "keenable-search", "Keenable must be the selected primary");
const sse = await request("/v1/responses", {
  model: "minimax/MiniMax-M3.1-Flash",
  input: [
    {
      role: "user",
      content:
        "Use the web_search tool exactly once to find the official documentation: " +
        query +
        ". Return the sources.",
    },
  ],
  instructions:
    "You are a web search assistant. Use web_search and cite the sources. Do not answer from memory.",
  tools: [{ type: "web_search" }],
  stream: true,
});
const events = sse.split(/\r?\n\r?\n/).flatMap((block) => {
  const payload = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");
  if (!payload || payload === "[DONE]") return [];
  try {
    return [JSON.parse(payload)];
  } catch {
    return [];
  }
});
const citations = events
  .filter((event) => event.type === "response.output_text.annotation.added")
  .map((event) => event.annotation)
  .filter((annotation) => annotation?.type === "url_citation");
assert.ok(citations.length > 0, "Standard streaming client must receive source citation events");
assert.ok(
  citations.every((citation) => validUrl(citation.url)),
  "All streamed sources must have usable URLs"
);
const completed = events.findLast((event) => event.type === "response.completed")?.response;
assert.ok(completed, "Responses stream must settle with response.completed");
assert.ok(
  completed.output.some((item) => item.type === "web_search_call" && item.action?.type === "search")
);
assert.ok(
  !completed.output.some(
    (item) => item.type === "function_call" && item.name === "omniroute_web_search"
  ),
  "Internal hosted search must not leak as a client-owned function"
);
const text = completed.output
  .filter((item) => item.type === "message")
  .flatMap((item) => item.content || [])
  .filter((part) => part.type === "output_text")
  .map((part) => part.text)
  .join("\n");
assert.ok(text.includes(citations[0].url), "Search output must contain the cited result");
console.log(
  JSON.stringify({
    ok: true,
    base,
    defaultProvider: direct.provider,
    directResults: direct.results.length,
    citations: citations.length,
    completed: true,
    sourceUrls: [...new Set(citations.map((citation) => citation.url))].slice(0, 5),
  })
);
