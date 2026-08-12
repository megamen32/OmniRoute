import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-cache-8728-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// Dynamic import required: DATA_DIR must be set before the module's top-level
// DB init runs (same pattern as tests/unit/account-fallback-service.test.ts).
const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");

function payload(body: string, status = 200): catalogCache.CatalogPayload {
  return {
    body,
    headers: { "content-type": "application/json" },
    status,
    cacheTTL: 60_000,
  };
}

let seq = 0;
/** Unique per call so tests never collide on the shared cache key. */
function request() {
  seq += 1;
  return new Request(`http://localhost/v1/models?t=${seq}`);
}

async function resolve(build: (request: Request) => Promise<catalogCache.CatalogPayload>) {
  return catalogCache.resolveCachedCatalogResponse(
    request(),
    { corsHeaders: {}, diagnosticHeaders: {} },
    build
  );
}

test.beforeEach(() => {
  catalogCache.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("ordinary TTL expiry serves the last success while it is stale and schedules one refresh", async () => {
  const initial = await resolve(async () => payload("old"));
  assert.equal(await initial.text(), "old");

  catalogCache.__expireCatalogCacheForTest(1000);

  // Concurrent stale reads all serve the cached snapshot within the stale window.
  const staleResponses = await Promise.all(
    Array.from({ length: 5 }, () => resolve(async () => payload("new")))
  );
  assert.deepEqual(
    await Promise.all(staleResponses.map((response) => response.text())),
    Array(5).fill("old")
  );
  assert.equal(
    catalogCache.__getCatalogBuilderRunsForTest(),
    1,
    "stale path must schedule exactly one background refresh"
  );
});

test("an error payload is returned, cached briefly, but rebuilds once it ages past the stale window", async () => {
  const first = await resolve(async () => payload("temporary failure", 503));
  assert.equal(first.status, 503);
  assert.equal(await first.text(), "temporary failure");

  // 503 is stored as a fresh entry: a follow-up in TTL serves the same error.
  const withinTtl = await resolve(async () => payload("recovered"));
  assert.equal(withinTtl.status, 503);
  assert.equal(await withinTtl.text(), "temporary failure");

  // Once past the stale-while-revalidate window the entry is dead and the next
  // read rebuilds — it is never replayed as "stale".
  catalogCache.__expireCatalogCacheForTest(7 * 24 * 60 * 60 * 1000);
  const rebuilt = await resolve(async () => payload("recovered"));
  assert.equal(rebuilt.status, 200);
  assert.equal(await rebuilt.text(), "recovered");
});

test("after the stale window a stale entry is not served; it rebuilds instead", async () => {
  const first = await resolve(async () => payload("old"));
  assert.equal(await first.text(), "old");

  // 7 days >> 30s stale window: entry is dead, next read must rebuild.
  catalogCache.__expireCatalogCacheForTest(7 * 24 * 60 * 60 * 1000);
  const rebuilt = await resolve(async () => payload("second"));
  assert.equal(await rebuilt.text(), "second");
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), 2);
});