import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codex-429-canary-"));
process.env.DATA_DIR = DATA_DIR;
process.env.API_KEY_SECRET = "test-only-codex-429-canary";
const { claimCodexRecoveryCanary, resetCodexRecoveryCanariesForTests } =
  await import("../../src/sse/services/codexRecoveryCanary.ts");
const fallback = await import("../../open-sse/services/accountFallback.ts");
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");

test.after(() => {
  fallback.clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
test.beforeEach(() => {
  resetCodexRecoveryCanariesForTests();
  fallback.clearAllModelLockouts();
});

const now = Date.now();
function connection(id: string, state: Record<string, unknown> = {}) {
  return { id, providerSpecificData: { codexQuotaStateByScope: { codex: {
    observedAt: new Date(now - 60_000).toISOString(),
    usage5h: 0, limit5h: 100,
    ...state,
  } } } };
}
const lock = { reason: "quota_exhausted", lockedAt: new Date(now - 120_000).toISOString(), remainingMs: 86_400_000 };

test("a fresh positive Codex window allows exactly one bounded request canary, never an unlock", () => {
  const a = connection("a");
  assert.equal(claimCodexRecoveryCanary(a, "gpt-6.1-terra", lock, now), true);
  assert.equal(claimCodexRecoveryCanary(a, "gpt-6-luna", lock, now), false, "shared Codex quota must not allow concurrent canaries");
  assert.equal(claimCodexRecoveryCanary(a, "gpt-6-luna", lock, now + 16 * 60_000), true);
  assert.equal(claimCodexRecoveryCanary(connection("b"), "gpt-6-luna", lock, now), true, "other account unaffected");
});

test("never probe without fresh post-lock evidence or when known quota remains exhausted", () => {
  const cases = [
    connection("old", { observedAt: new Date(now - 3 * 60_000).toISOString() }),
    connection("stale", { observedAt: new Date(now - 2 * 3600_000).toISOString() }),
    connection("future", { observedAt: new Date(now + 60_000).toISOString() }),
    connection("five-hour", { usage5h: 100 }),
    connection("weekly", { usage7d: 100, limit7d: 100 }),
    connection("broken", { usage5h: "0" }),
    { id: "held", providerSpecificData: { ...connection("held").providerSpecificData,
      codexExhaustedWindowByScope: { codex: "7d" } } },
  ];
  for (const c of cases) assert.equal(claimCodexRecoveryCanary(c, "gpt-6-luna", lock, now), false, c.id);
  assert.equal(claimCodexRecoveryCanary(connection("notfound"), "gpt-6-luna",
    { ...lock, reason: "not_found" }, now), false);
  assert.equal(claimCodexRecoveryCanary(connection("expired"), "gpt-6-luna",
    { ...lock, remainingMs: 0 }, now), false);
});

test("credential selection can route one real canary without erasing the upstream lock", async () => {
  const a = await providers.createProviderConnection({
    provider: "codex", authType: "oauth", name: "codex-recovery-canary",
    accessToken: "test-access", refreshToken: "test-refresh",
    isActive: true, testStatus: "active",
    providerSpecificData: {
      quotaPreflightEnabled: false,
      limitPolicy: { enabled: false },
      codexLimitPolicy: { use5h: false, useWeekly: false },
    },
  });
  fallback.lockModel("codex", a.id, "gpt-6.1-terra", "quota_exhausted", 86_400_000);
  const blocked = await auth.getProviderCredentials("codex", null, null, "gpt-6-luna");
  assert.notEqual(blocked?.connectionId, a.id);

  await providers.updateProviderConnection(a.id, { providerSpecificData: {
    ...a.providerSpecificData,
    codexQuotaStateByScope: { codex: { observedAt: new Date(Date.now() + 1).toISOString(),
      usage5h: 0, limit5h: 100 } },
  } });
  // Ensure the observation timestamp is no longer in the future.
  await new Promise((resolve) => setTimeout(resolve, 12));
  const selected = await auth.getProviderCredentials("codex", null, null, "gpt-6-luna");
  assert.equal(selected?.connectionId, a.id);
  assert.equal(fallback.isModelLocked("codex", a.id, "gpt-6-luna"), true);
  const second = await auth.getProviderCredentials("codex", null, null, "gpt-6-luna");
  assert.notEqual(second?.connectionId, a.id, "a second request cannot bypass the same lock");
});
