import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-preferred-search-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "preferred-search-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const locks = await import("../../open-sse/services/accountFallback.ts");
const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { autoSearchCandidates } = await import("../../open-sse/config/searchRegistry.ts");
const { handleSearch } = await import("../../open-sse/handlers/search.ts");
const { executeWebSearch } = await import("../../src/lib/search/executeWebSearch.ts");
const searchRoute = await import("../../src/app/api/v1/search/route.ts");

const order = ["keenable-search", "tinyfish-search", "searxng-search"];
const originalFetch = globalThis.fetch;
const hit = { title: "Official docs", url: "https://example.com/docs", snippet: "Documentation" };
let sequence = 0;

async function seed(provider: string, extra: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: provider,
    apiKey: "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
    ...extra,
  });
}

async function seedDefaults() {
  await settingsDb.updateSettings({ searchProviderOrder: order });
  const tinyfish = await seed("tinyfish");
  await seed("searxng-search", {
    authType: "none",
    apiKey: null,
    providerSpecificData: { baseUrl: "https://search.example.com" },
  });
  return tinyfish;
}

async function runEntry(entry: "tool" | "route", label: string) {
  const query = label + " " + ++sequence;
  if (entry === "tool") return (await executeWebSearch({ query, max_results: 2 })).data;
  const response = await searchRoute.POST(
    new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: 2 }),
    })
  );
  assert.equal(response.status, 200);
  return response.json();
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await closeCallLogSaves(500);
  core.resetDbInstance();
  locks.clearAllModelLockouts();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});
test.after(async () => {
  globalThis.fetch = originalFetch;
  await closeCallLogSaves(500);
  core.resetDbInstance();
  locks.clearAllModelLockouts();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("operator order admits Keenable while the default candidate list stays unchanged", () => {
  assert.deepEqual(
    autoSearchCandidates("web", order)
      .slice(0, 3)
      .map((p) => p.id),
    order
  );
  assert.ok(!autoSearchCandidates("web").some((p) => p.id === "keenable-search"));
});

for (const entry of ["tool", "route"] as const) {
  test(entry + " uses keyless Keenable first through the existing search gateway", async () => {
    await seedDefaults();
    const hosts: string[] = [];
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      hosts.push(u.hostname);
      if (u.hostname !== "api.keenable.ai") return Response.json({ results: [hit] });
      assert.equal(u.pathname, "/v1/search/public");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("X-Keenable-Title"), "OmniRoute");
      assert.equal(new Headers(init?.headers).get("X-API-Key"), null);
      return Response.json({ results: [hit] });
    };
    const data = await runEntry(entry, "primary");
    assert.equal(data.provider, "keenable-search");
    assert.deepEqual(hosts, ["api.keenable.ai"]);
    assert.equal(data.results[0].url, hit.url);
  });

  test(entry + " reaches SearXNG after both preferred providers fail", async () => {
    await seedDefaults();
    const hosts: string[] = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      hosts.push(u.hostname);
      if (u.hostname === "api.keenable.ai")
        return Response.json({ error: "unavailable" }, { status: 503 });
      if (u.hostname === "api.search.tinyfish.ai")
        return Response.json({ error: "rate limit" }, { status: 429 });
      return Response.json({ results: [hit] });
    };
    const data = await runEntry(entry, "three-provider failover");
    assert.equal(data.provider, "searxng-search");
    assert.deepEqual(hosts, ["api.keenable.ai", "api.search.tinyfish.ai", "search.example.com"]);
  });

  test(entry + " skips blocked providers throughout the preferred chain", async () => {
    await seedDefaults();
    await settingsDb.updateSettings({ blockedProviders: ["tinyfish"] });
    const hosts: string[] = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      hosts.push(u.hostname);
      if (u.hostname === "api.keenable.ai") return Response.json({ results: [] });
      return Response.json({ results: [hit] });
    };
    const data = await runEntry(entry, "blocked fallback");
    assert.equal(data.provider, "searxng-search");
    assert.deepEqual(hosts, ["api.keenable.ai", "search.example.com"]);
  });
}

test("TinyFish maps the documented filters and a fixed ten-result page", async () => {
  let observed: URL | undefined;
  globalThis.fetch = async (url, init) => {
    observed = new URL(String(url));
    assert.equal(init?.redirect, "error");
    return Response.json({ results: [hit] });
  };
  const result = await handleSearch({
    query: "documentation",
    provider: "tinyfish-search",
    maxResults: 2,
    searchType: "news",
    country: "gb",
    language: "en",
    timeRange: "week",
    offset: 20,
    domainFilter: ["example.com", "docs.example.org", "-spam.example.com"],
    credentials: { apiKey: "test-key" },
  });
  assert.equal(result.success, true);
  assert.equal(observed?.searchParams.has("num_results"), false);
  assert.equal(observed?.searchParams.get("page"), "2");
  assert.equal(observed?.searchParams.get("domain_type"), "news");
  assert.equal(observed?.searchParams.get("location"), "GB");
  assert.equal(observed?.searchParams.get("language"), "en");
  assert.equal(observed?.searchParams.get("include_domains"), "example.com,docs.example.org");
  assert.equal(observed?.searchParams.get("exclude_domains"), "spam.example.com");
  assert.equal(observed?.searchParams.get("recency_minutes"), "10080");
});

test("SearXNG rejects malformed raw URLs before applying the result limit", async () => {
  globalThis.fetch = async () =>
    Response.json({
      results: [
        { title: "broken redirect", url: "http:///go/v1/abc", content: "wrong" },
        { title: "also malformed", url: "https:////redirect.example/path", content: "wrong" },
        { title: "userinfo", url: "https://user:password@example.com", content: "wrong" },
        hit,
      ],
    });
  const result = await handleSearch({
    query: "documentation",
    provider: "searxng-search",
    maxResults: 1,
    searchType: "web",
    credentials: { providerSpecificData: { baseUrl: "https://search.example.com" } },
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.data?.results.map((row) => row.url),
    [hit.url]
  );
});

test("an all-invalid successful HTTP response uses the next provider", async () => {
  const hosts: string[] = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    hosts.push(u.hostname);
    return Response.json({
      results:
        u.hostname === "api.search.tinyfish.ai"
          ? [{ url: "http:///go/v1/abc", title: "invalid" }]
          : [hit],
    });
  };
  const result = await handleSearch({
    query: "documentation",
    provider: "tinyfish-search",
    maxResults: 2,
    searchType: "web",
    credentials: { apiKey: "test-key" },
    alternateProvider: "searxng-search",
    alternateCredentials: { providerSpecificData: { baseUrl: "https://search.example.com" } },
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.provider, "searxng-search");
  assert.deepEqual(hosts, ["api.search.tinyfish.ai", "search.example.com"]);
});

test("a TinyFish search quota failure leaves its shared fetch connection active", async () => {
  const conn = await seed("tinyfish");
  globalThis.fetch = async () =>
    Response.json({ error: "daily search allowance exhausted" }, { status: 429 });
  const result = await handleSearch({
    query: "documentation",
    provider: "tinyfish-search",
    maxResults: 2,
    searchType: "web",
    credentials: { apiKey: "test-key", connectionId: String(conn.id) },
    connectionId: String(conn.id),
  });
  assert.equal(result.status, 429);
  const stored = await providersDb.getProviderConnectionById(String(conn.id));
  assert.equal(stored?.testStatus, "active");
  assert.equal(stored?.rateLimitedUntil ?? null, null);
  const fetchCredentials = await auth.getProviderCredentials("tinyfish");
  assert.equal(fetchCredentials?.connectionId, conn.id);
  assert.equal(locks.isModelLocked("tinyfish", String(conn.id), "websearch:tinyfish-search"), true);
});

test("Keenable stored-key validation uses the fixed search endpoint", async () => {
  const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
  let observed: { url: string; key: string | null; body: unknown } | undefined;
  globalThis.fetch = async (url, init) => {
    observed = {
      url: String(url),
      key: new Headers(init?.headers).get("X-API-Key"),
      body: JSON.parse(String(init?.body)),
    };
    return Response.json({ results: [hit] });
  };
  const result = await validateProviderApiKey({
    provider: "keenable-search",
    apiKey: "test-keenable-key",
  });
  assert.equal(result.valid, true);
  assert.equal(observed?.url, "https://api.keenable.ai/v1/search");
  assert.equal(observed?.key, "test-keenable-key");
});

test("Keenable key and result filters remain bound to the intended provider and domains", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.keenable.ai/v1/search");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "test-keenable-key");
    assert.deepEqual(JSON.parse(String(init?.body)).exclude_domains, ["spam.example.com"]);
    return Response.json({
      results: [
        { ...hit, url: "https://outside.example.net/other" },
        { ...hit, url: "https://spam.example.com/blocked" },
        { ...hit, url: "http:///go/broken" },
        { ...hit, url: "https://docs.example.com/allowed" },
        { ...hit, url: "https://example.org/other" },
      ],
    });
  };
  const result = await handleSearch({
    query: "documentation",
    provider: "keenable-search",
    maxResults: 2,
    searchType: "web",
    domainFilter: ["example.com", "example.org", "-spam.example.com"],
    credentials: {
      apiKey: "test-keenable-key",
      providerSpecificData: { baseUrl: "https://other.example" },
    },
    providerOptions: { baseUrl: "https://other.example" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.data?.results.map((row) => row.url),
    ["https://docs.example.com/allowed", "https://example.org/other"]
  );
});

test("an exhausted preferred chain reports failure instead of an empty success", async () => {
  await seedDefaults();
  const hosts: string[] = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(String(url)).hostname);
    return Response.json({ results: [] });
  };
  await assert.rejects(
    executeWebSearch({ query: "empty chain " + ++sequence }),
    /no usable sources/
  );
  assert.deepEqual(hosts, ["api.keenable.ai", "api.search.tinyfish.ai", "search.example.com"]);
});

test("preferred routing preserves key connection scope for every fallback", async () => {
  await seedDefaults();
  const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
  const own = await seed("tinyfish", { name: "allowed tinyfish", apiKey: "allowed-search-key" });
  const key = await createApiKey("scoped-search-test", "test-machine", [], {
    allowedConnections: [String(own.id)],
  });
  const hosts: string[] = [];
  globalThis.fetch = async (url, init) => {
    hosts.push(new URL(String(url)).hostname);
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "allowed-search-key");
    return Response.json({ error: "unavailable" }, { status: 503 });
  };
  const response = await searchRoute.POST(
    new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key.key },
      body: JSON.stringify({ query: "scope " + ++sequence }),
    })
  );
  assert.equal(response.status, 503);
  assert.deepEqual(hosts, ["api.search.tinyfish.ai"]);
});

test("TinyFish offset inside one native page does not repeat earlier results", async () => {
  globalThis.fetch = async () =>
    Response.json({
      results: Array.from({ length: 10 }, (_, i) => ({
        ...hit,
        url: "https://example.com/" + i,
      })),
    });
  const result = await handleSearch({
    query: "documentation",
    provider: "tinyfish-search",
    maxResults: 2,
    offset: 2,
    searchType: "web",
    credentials: { apiKey: "test-key" },
  });
  assert.deepEqual(
    result.data?.results.map((row) => row.url),
    ["https://example.com/2", "https://example.com/3"]
  );
});

test("TinyFish rejects unsupported offsets without silently repeating the last page", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [hit] });
  };
  for (const offset of [110, 200]) {
    const result = await handleSearch({
      query: "documentation",
      provider: "tinyfish-search",
      maxResults: 2,
      offset,
      searchType: "web",
      credentials: { apiKey: "test-key" },
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.match(result.error ?? "", /offset/i);
  }
  assert.equal(calls, 0);
});

test("TinyFish preserves the news publisher in supported result metadata", async () => {
  globalThis.fetch = async () =>
    Response.json({ results: [{ ...hit, publisher: "Official Newsroom" }] });
  const result = await handleSearch({
    query: "documentation",
    provider: "tinyfish-search",
    maxResults: 2,
    searchType: "news",
    credentials: { apiKey: "test-key" },
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.results[0]?.metadata?.author, "Official Newsroom");
});
