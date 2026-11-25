import test from "node:test";
import assert from "node:assert/strict";
import { evaluateZcodeTariffQuota as check } from "../../src/sse/services/zcodeTariffQuota.ts";

const now = Date.parse("2026-11-24T14:00:00Z");
const group = (
  plan: string,
  status: string,
  quotas = {},
  observedAt = new Date(now).toISOString()
) => ({ plan, status, quotas, observedAt });
const cache = (...quotaGroups: Record<string, unknown>[]) => ({ quotaGroups });
const token = (remainingPercentage: number, resetAt = "2026-11-25T00:00:00Z") => ({
  remainingPercentage,
  resetAt,
});
const evalQuota = (p: string, c: ReturnType<typeof cache> | null, enabled = true) =>
  check(p, "oauth", c, enabled, () => 20, now);
test("no_plan and unknown are distinct, and Individual is not contaminated by Start", () => {
  const c = cache(
    group("start", "no_plan"),
    group("individual", "available", { session: token(95), weekly: token(35) })
  );
  assert.deepEqual(evalQuota("zcode-start", c)?.reasons, ["zcode:start:no_plan"]);
  assert.equal(evalQuota("zcode-individual", c)?.blocked, false);
  assert.deepEqual(evalQuota("zcode-start", null)?.reasons, ["zcode:start:unknown"]);
  assert.equal(evalQuota("zcode-start", c, false)?.blocked, true);
});
test("quota cutoff, stale or reset observation, and automatic recovery", () => {
  assert.equal(
    evalQuota("zcode-cn-start", cache(group("start", "available", { tokens: token(0) })))?.blocked,
    true
  );
  assert.equal(
    evalQuota("zcode-start", cache(group("start", "available", { tokens: token(20) })))?.blocked,
    true
  );
  assert.equal(
    evalQuota("zcode-start", cache(group("start", "available", { tokens: token(80) })))?.blocked,
    false
  );
  assert.deepEqual(
    evalQuota(
      "zcode-start",
      cache(
        group("start", "available", { tokens: token(80) }, new Date(now - 600_000).toISOString())
      )
    )?.reasons,
    ["zcode:start:unknown"]
  );
  assert.deepEqual(
    evalQuota(
      "zcode-start",
      cache(group("start", "available", { tokens: token(0, "2026-11-24T13:00:00Z") }))
    )?.reasons,
    ["zcode:start:unknown"]
  );
  assert.equal(
    evalQuota(
      "zcode-cn-individual",
      cache(group("individual", "available", { session: token(90) }))
    )?.blocked,
    false
  );
});
test("Individual fails open when the quota observation is missing or stale", () => {
  assert.equal(evalQuota("zcode-individual", null)?.blocked, false);
  assert.equal(
    evalQuota(
      "zcode-individual",
      cache(
        group(
          "individual",
          "available",
          { session: token(90), weekly: token(90) },
          new Date(now - 600_000).toISOString()
        )
      )
    )?.blocked,
    false
  );
  assert.equal(
    evalQuota("zcode-individual", cache(group("individual", "no_plan")))?.blocked,
    false
  );
});
test("unrelated providers and non-OAuth credentials remain unchanged", () => {
  assert.equal(evalQuota("minimax", null), null);
  assert.equal(
    check("zcode-start", "apikey", null, true, () => 20, now),
    null
  );
  assert.equal(evalQuota("zcode-start", null, false), null);
});
