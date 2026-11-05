import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-single-window-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "test-only-secret";
const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const recovery = await import("../../src/lib/db/providers/codexAccountRecovery.ts");
const pool = await import("../../open-sse/services/codexAccount/index.ts");
const { getCodexUsage, setCodexUsageFetchForTests } =
  await import("../../open-sse/services/usage/codex.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
const until = new Date(Date.now() + 3600000).toISOString();
async function seed() {
  return db.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: crypto.randomUUID(),
    providerSpecificData: {
      codexScopeRateLimitedUntil: { codex: until, spark: until },
      codexExhaustedWindowByScope: { codex: "7d", spark: "7d" },
    },
  });
}
const primary = { used_percent: 53, limit_window_seconds: 604800, reset_at: 2000000000 };
const complete = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: primary,
    secondary_window: null,
  },
};
async function observe(payload: unknown) {
  setCodexUsageFetchForTests(async () => Response.json(payload));
  try {
    return await getCodexUsage("test-token");
  } finally {
    setCodexUsageFetchForTests(null);
  }
}
test("complete raw Pro weekly-only response releases only the Codex scope", async () => {
  const account = await seed();
  const usage = await observe(complete);
  await recovery.syncCodexQuotaObservation(account.id, usage, account.providerSpecificData);
  const after = pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id));
  assert.equal(after.children[0].unavailable, false);
  assert.equal(after.children[1].unavailable, true);
});

test("unknown, partial, invalid, exhausted and denied raw replies do not unlock", async () => {
  const invalid = [
    { ...complete, plan_type: "plus" },
    { ...complete, plan_type: undefined },
    { ...complete, rate_limit: { ...complete.rate_limit, secondary_window: undefined } },
    { ...complete, rate_limit: { ...complete.rate_limit, allowed: false } },
    { ...complete, rate_limit: { ...complete.rate_limit, limit_reached: true } },
    {
      ...complete,
      rate_limit: {
        ...complete.rate_limit,
        primary_window: { ...primary, used_percent: undefined },
      },
    },
    {
      ...complete,
      rate_limit: { ...complete.rate_limit, primary_window: { ...primary, used_percent: 100 } },
    },
    {
      ...complete,
      rate_limit: { ...complete.rate_limit, primary_window: { ...primary, reset_at: undefined } },
    },
    {
      ...complete,
      rate_limit: {
        ...complete.rate_limit,
        primary_window: { ...primary, limit_window_seconds: undefined },
      },
    },
    {
      ...complete,
      rate_limit: { ...complete.rate_limit, primary_window: { ...primary, used_percent: -1 } },
    },
    {
      ...complete,
      rate_limit: {
        ...complete.rate_limit,
        primary_window: { ...primary, limit_window_seconds: 18000 },
      },
    },
    { ...complete, rate_limit: { ...complete.rate_limit, secondary_window: {} } },
    {
      ...complete,
      rate_limit: { ...complete.rate_limit, secondary_window: { used_percent: 100 } },
    },
    { message: "upstream error" },
  ];
  for (const payload of invalid) {
    const account = await seed();
    await recovery.syncCodexQuotaObservation(
      account.id,
      await observe(payload),
      account.providerSpecificData
    );
    const after = pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id));
    assert.equal(after.children[0].unavailable, true, JSON.stringify(payload));
    assert.equal(after.children[1].unavailable, true);
  }
});
test("new failure during a single-window fetch wins over older evidence", async () => {
  const account = await seed();
  const usage = await observe(complete);
  await db.updateCodexScopeCooldown(
    account.id,
    "codex",
    new Date(Date.now() + 7200000).toISOString()
  );
  await recovery.syncCodexQuotaObservation(account.id, usage, account.providerSpecificData);
  const after = pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id));
  assert.equal(after.children[0].unavailable, true);
});
test("complete Pro response removes stale second-window hydration", async () => {
  const account = await db.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: crypto.randomUUID(),
    providerSpecificData: {
      codexScopeRateLimitedUntil: { codex: until },
      codexQuotaStateByScope: { codex: { usage7d: 100, limit7d: 100, resetAt7d: until } },
    },
  });
  await recovery.syncCodexQuotaObservation(
    account.id,
    await observe(complete),
    account.providerSpecificData
  );
  const after = await db.getProviderConnectionById(account.id);
  const state = after.providerSpecificData.codexQuotaStateByScope.codex;
  assert.equal(state.usage5h, 53);
  assert.equal(state.usage7d, undefined);
  assert.equal(pool.projectCodexAccountPool(after).children[0].unavailable, false);
});
test("terminal status is not reopened by successful quota data", async () => {
  const account = await seed();
  await db.updateProviderConnection(account.id, { testStatus: "banned" });
  const current = await db.getProviderConnectionById(account.id);
  await recovery.syncCodexQuotaObservation(
    account.id,
    await observe(complete),
    current.providerSpecificData
  );
  const after = await db.getProviderConnectionById(account.id);
  assert.equal(after.testStatus, "banned");
  assert.equal(pool.projectCodexAccountPool(after).children[0].unavailable, true);
});
test("two available windows retain legacy recovery without added evidence", async () => {
  const good = {
    ...complete,
    rate_limit: { ...complete.rate_limit, secondary_window: { ...primary, used_percent: 20 } },
  };
  const account = await seed();
  const usage = await observe(good);
  await recovery.syncCodexQuotaObservation(account.id, usage, account.providerSpecificData);
  assert.equal(
    pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id)).children[0]
      .unavailable,
    false
  );
  const other = await seed();
  await recovery.syncCodexQuotaObservation(
    other.id,
    { quotas: { session: { used: 0, total: 100 }, weekly: { used: 0, total: 100 } } },
    other.providerSpecificData
  );
  assert.equal(
    pool.projectCodexAccountPool(await db.getProviderConnectionById(other.id)).children[0]
      .unavailable,
    false
  );
});

test("an HTTP failure does not produce recovery evidence", async () => {
  const account = await seed();
  setCodexUsageFetchForTests(async () => new Response(null, { status: 503 }));
  try {
    const usage = await getCodexUsage("test-token");
    await recovery.syncCodexQuotaObservation(account.id, usage, account.providerSpecificData);
    assert.equal(
      pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id)).children[0]
        .unavailable,
      true
    );
  } finally {
    setCodexUsageFetchForTests(null);
  }
});

test("ordinary two-window raw response without allowed or reset preserves recovery", async () => {
  const account = await seed();
  const usage = await observe({
    plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 42 }, secondary_window: { used_percent: 20 } },
  });
  await recovery.syncCodexQuotaObservation(account.id, usage, account.providerSpecificData);
  assert.equal(
    pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id)).children[0]
      .unavailable,
    false
  );
});
test("explicit denial or exhaustion prevents two-window recovery", async () => {
  for (const flags of [{ allowed: false }, { limit_reached: true }]) {
    const account = await seed();
    const usage = await observe({
      plan_type: "plus",
      rate_limit: {
        ...flags,
        primary_window: { used_percent: 42 },
        secondary_window: { used_percent: 20 },
      },
    });
    await recovery.syncCodexQuotaObservation(account.id, usage, account.providerSpecificData);
    assert.equal(
      pool.projectCodexAccountPool(await db.getProviderConnectionById(account.id)).children[0]
        .unavailable,
      true
    );
  }
});
