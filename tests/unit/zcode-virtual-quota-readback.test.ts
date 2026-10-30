import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-zcode-virtual-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-zcode-virtual-quota-secret";
process.env.ZCODE_SERVER_NODE = process.execPath;
process.env.ZCODE_SERVER_ENTRY = path.join(
  process.cwd(),
  "tests/fixtures/fake-zcode-app-server.mjs"
);
delete process.env.ZCODE_FAKE_QUOTA_MODE;

const core = await import("../../src/lib/db/core.ts");
const providerClientRoute = await import("../../src/app/api/providers/client/route.ts");
const usageRoute = await import("../../src/app/api/usage/[connectionId]/route.ts");
const providerLimitsRoute = await import("../../src/app/api/usage/provider-limits/route.ts");
const { ZCODE_START_VIRTUAL_CONNECTION_ID } =
  await import("../../src/lib/usage/zcodeVirtualConnection.ts");

test("virtual ZCode Start appears in dashboard and native quota reads back through API/cache", async () => {
  try {
    const clientResponse = await providerClientRoute.GET();
    const { connections } = (await clientResponse.json()) as {
      connections: Array<{ id: string; provider: string; authType: string }>;
    };
    const virtual = connections.find(
      (connection) => connection.id === ZCODE_START_VIRTUAL_CONNECTION_ID
    );
    assert.deepEqual(virtual, {
      id: "virtual:zcode-start",
      provider: "zcode-start",
      authType: "none",
      isActive: true,
      name: "ZCode Start",
    });

    const usageResponse = await usageRoute.GET(new Request("http://localhost/api/usage"), {
      params: Promise.resolve({ connectionId: ZCODE_START_VIRTUAL_CONNECTION_ID }),
    });
    assert.equal(usageResponse.status, 200);
    const usage = await usageResponse.json();
    assert.equal(usage.plan, "Fixture ZCode Start");
    assert.equal(usage.quotas.tokens.total, 500_000_000);
    assert.equal(usage.quotas.tokens.remaining, 500_000_000);

    const bulkResponse = await providerLimitsRoute.POST();
    const bulk = await bulkResponse.json();
    assert.equal(bulk.total, 1);
    assert.equal(bulk.succeeded, 1);
    assert.equal(bulk.caches[ZCODE_START_VIRTUAL_CONNECTION_ID].quotas.tokens.total, 500_000_000);

    const cacheResponse = await providerLimitsRoute.GET();
    const cacheBody = await cacheResponse.json();
    assert.equal(
      cacheBody.caches[ZCODE_START_VIRTUAL_CONNECTION_ID].quotas.tokens.total,
      500_000_000
    );

    process.env.ZCODE_FAKE_QUOTA_MODE = "unavailable";
    const unavailableResponse = await usageRoute.GET(new Request("http://localhost/api/usage"), {
      params: Promise.resolve({ connectionId: ZCODE_START_VIRTUAL_CONNECTION_ID }),
    });
    const unavailable = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 200);
    assert.equal(unavailable.quotas, undefined);
    assert.match(unavailable.message, /entitlement is unavailable/);

    const unavailableCacheResponse = await providerLimitsRoute.GET();
    const unavailableCache = await unavailableCacheResponse.json();
    const entry = unavailableCache.caches[ZCODE_START_VIRTUAL_CONNECTION_ID];
    assert.equal(entry.quotas, null);
    assert.match(entry.message, /entitlement is unavailable/);
  } finally {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    delete process.env.ZCODE_FAKE_QUOTA_MODE;
    delete process.env.ZCODE_SERVER_NODE;
    delete process.env.ZCODE_SERVER_ENTRY;
    delete process.env.API_KEY_SECRET;
    delete process.env.DATA_DIR;
  }
});
