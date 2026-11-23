import test from "node:test";
import assert from "node:assert/strict";
import { orderPlanFirstSpeedFallback } from "../../open-sse/services/combo/planFirstSpeedFallback.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

const target = (provider: string, model = "model", account = "one") =>
  ({
    provider,
    modelStr: provider + "/" + model,
    executionKey: provider + "/" + model + "/" + account,
  }) as ResolvedComboTarget;
const start = target("zcode-start"),
  individual = target("zcode-individual");
const glm = target("glm"),
  mm = target("minimax"),
  cn = target("bigmodel");
const now = 1_000_000;
const metric = (latency: number, time = now, successRate = 100) => ({
  avgLatencyMs: latency,
  lastUsedAt: new Date(time).toISOString(),
  successRate,
  lastStatus: "ok",
});

test("plans beat faster fallback, fallback sorts speed not last-good order", () => {
  const metrics = {
    byTarget: { [glm.executionKey]: metric(1000), [mm.executionKey]: metric(100) },
  };
  assert.deepEqual(
    orderPlanFirstSpeedFallback([mm, individual, glm, start], metrics, "tiers", now),
    [start, individual, mm, glm]
  );
});
test("no plan or disabled target is invented, account metrics remain isolated", () => {
  const other = target("minimax", "model", "other");
  const metrics = { byTarget: { [mm.executionKey]: metric(10), [glm.executionKey]: metric(100) } };
  assert.deepEqual(orderPlanFirstSpeedFallback([other, glm], metrics, "accounts", now), [
    glm,
    other,
  ]);
});
test("stale metrics do not pin, bounded ordinary-request exploration has no extra target", () => {
  const metrics = {
    byTarget: { [glm.executionKey]: metric(1, now - 300001), [mm.executionKey]: metric(100) },
  };
  for (let i = 0; i < 15; i++)
    assert.deepEqual(orderPlanFirstSpeedFallback([glm, mm], metrics, "stale", now), [mm, glm]);
  assert.deepEqual(orderPlanFirstSpeedFallback([glm, mm], metrics, "stale", now), [glm, mm]);
  assert.deepEqual(orderPlanFirstSpeedFallback([glm, mm], metrics, "stale", now), [mm, glm]);
});
test("low-success and invalid or future observations cannot win on fast errors", () => {
  const metrics = {
    byTarget: {
      [glm.executionKey]: metric(10, now, 1),
      [mm.executionKey]: metric(100),
      [cn.executionKey]: metric(1, now + 1),
    },
  };
  assert.deepEqual(orderPlanFirstSpeedFallback([glm, mm, cn], metrics, "errors", now), [
    mm,
    glm,
    cn,
  ]);
});

test("recent target observations decay and reset after staleness", async () => {
  const { recordPlanFallbackObservation, getPlanFallbackObservations } =
    await import("../../open-sse/services/combo/planFirstSpeedFallback.ts");
  const combo = "ewma-test";
  recordPlanFallbackObservation(combo, "account-a", 1000, true, 1000);
  recordPlanFallbackObservation(combo, "account-a", 100, true, 2000);
  assert.equal(getPlanFallbackObservations(combo)?.byTarget?.["account-a"].avgLatencyMs, 730);
  recordPlanFallbackObservation(combo, "account-a", 100, true, 400000);
  assert.equal(getPlanFallbackObservations(combo)?.byTarget?.["account-a"].avgLatencyMs, 100);
  recordPlanFallbackObservation(combo, "account-b", 10, false, 400000);
  assert.equal(getPlanFallbackObservations(combo)?.byTarget?.["account-b"].successRate, 0);
  assert.equal(getPlanFallbackObservations(combo)?.byTarget?.["account-a"].successRate, 100);
});
