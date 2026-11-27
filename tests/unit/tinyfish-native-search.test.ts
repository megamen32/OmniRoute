import test from "node:test";
import assert from "node:assert/strict";
import {
  autoSearchCandidates,
  getSearchCredentialFallbacks,
} from "../../open-sse/config/searchRegistry.ts";
import { handleSearch } from "../../open-sse/handlers/search.ts";

test("configured default prefers TinyFish, then configured SearXNG", () => {
  assert.deepEqual(
    autoSearchCandidates("web", ["tinyfish-search", "searxng-search"])
      .slice(0, 2)
      .map((p) => p.id),
    ["tinyfish-search", "searxng-search"]
  );
  assert.deepEqual(getSearchCredentialFallbacks("tinyfish-search"), ["tinyfish"]);
});
test("TinyFish uses the Search endpoint and returns normalized sources", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.search.tinyfish.ai");
    assert.equal(parsed.searchParams.get("query"), "wordstat");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
    return Response.json({
      results: [
        {
          title: "Documentation",
          url: "https://example.com/docs",
          snippet: "Search docs",
          date: "2026-10-01",
        },
      ],
    });
  };
  try {
    const r = await handleSearch({
      query: "wordstat",
      provider: "tinyfish-search",
      maxResults: 2,
      searchType: "web",
      credentials: { apiKey: "test-key" },
      log: null,
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.results?.[0]?.url, "https://example.com/docs");
    assert.equal(r.data?.results?.[0]?.snippet, "Search docs");
  } finally {
    globalThis.fetch = original;
  }
});
test("TinyFish quota and credential failures fall back to the configured SearXNG", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 429, 503]) {
      const hosts: string[] = [];
      globalThis.fetch = async (url, init) => {
        const u = new URL(String(url));
        hosts.push(u.hostname);
        if (u.hostname === "api.search.tinyfish.ai")
          return Response.json({ error: "upstream unavailable" }, { status });
        assert.equal(new Headers(init?.headers).get("x-api-key"), null);
        return Response.json({
          results: [
            { title: "Fallback", url: "https://example.com/fallback", content: "Fallback result" },
          ],
        });
      };
      const r = await handleSearch({
        query: "wordstat",
        provider: "tinyfish-search",
        maxResults: 2,
        searchType: "web",
        credentials: { apiKey: "test-key" },
        alternateProvider: "searxng-search",
        alternateCredentials: {
          providerSpecificData: { baseUrl: "https://search.example.com/search" },
        },
        log: null,
      });
      assert.equal(r.success, true);
      assert.equal(r.data?.provider, "searxng-search");
      assert.deepEqual(hosts, ["api.search.tinyfish.ai", "search.example.com"]);
    }
  } finally {
    globalThis.fetch = original;
  }
});
