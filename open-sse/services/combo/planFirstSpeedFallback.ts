import type { ResolvedComboTarget } from "./types.ts";

type SpeedMetric = {
  avgLatencyMs?: number;
  successRate?: number;
  lastUsedAt?: string | null;
  lastStatus?: string | null;
};
type SpeedMetrics = { byTarget?: Record<string, SpeedMetric> } | null;
const observations = new Map<string, Record<string, SpeedMetric>>();

/** Actual target-attempt latency, never time spent on earlier failed targets. */
export function recordPlanFallbackObservation(
  comboName: string,
  executionKey: string,
  latencyMs: number,
  success: boolean,
  now = Date.now()
): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  if (!observations.has(comboName) && observations.size >= 1000) {
    observations.delete(observations.keys().next().value!);
  }
  const targets = observations.get(comboName) || {};
  const previous = targets[executionKey];
  const age = now - Date.parse(previous?.lastUsedAt || "");
  const reuse = Number.isFinite(age) && age >= 0 && age <= 300_000;
  targets[executionKey] = {
    avgLatencyMs: reuse
      ? 0.3 * Math.max(1, latencyMs) + 0.7 * (previous.avgLatencyMs || 1)
      : Math.max(1, latencyMs),
    successRate: reuse
      ? 0.3 * (success ? 100 : 0) + 0.7 * (previous.successRate || 0)
      : success
        ? 100
        : 0,
    lastStatus: success ? "ok" : "error",
    lastUsedAt: new Date(now).toISOString(),
  };
  const keys = Object.keys(targets);
  if (keys.length > 256) delete targets[keys[0]];
  observations.set(comboName, targets);
}

export function getPlanFallbackObservations(comboName: string): SpeedMetrics {
  return { byTarget: observations.get(comboName) || {} };
}

const counters = new Map<string, number>();
const PLAN_ORDER = ["zcode-start", "zcode-individual"];

/** Opt-in only. Plans retain declared tiers; speed ranking never adds providers.
 * Missing/stale metrics get bounded exploration on an ordinary fallback request,
 * not a timer or an extra upstream call. Caller eligibility checks still apply.
 */
export function orderPlanFirstSpeedFallback(
  targets: ResolvedComboTarget[],
  metrics: SpeedMetrics,
  comboName: string,
  now = Date.now()
): ResolvedComboTarget[] {
  const next = (counters.get(comboName) || 0) + 1;
  if (!counters.has(comboName) && counters.size >= 1000) {
    counters.delete(counters.keys().next().value!);
  }
  counters.set(comboName, next);
  const plans = PLAN_ORDER.flatMap((provider) => targets.filter((t) => t.provider === provider));
  const fallback = targets.filter((t) => !PLAN_ORDER.includes(t.provider));
  const ranked = fallback.map((target, index) => {
    // Per execution key preserves model and account identity.
    const metric = metrics?.byTarget?.[target.executionKey];
    const age = now - Date.parse(metric?.lastUsedAt || "");
    const latency = Number(metric?.avgLatencyMs);
    const fresh =
      Number.isFinite(age) && age >= 0 && age <= 300_000 && Number.isFinite(latency) && latency > 0;
    const success = Math.max(0.01, Math.min(1, Number(metric?.successRate || 0) / 100));
    return {
      target,
      index,
      fresh,
      score: fresh
        ? (latency / (success * success)) * (metric?.lastStatus === "error" ? 4 : 1)
        : Infinity,
    };
  });
  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  if (next % 16 === 0) {
    const stale = ranked.filter((item) => !item.fresh);
    if (stale.length) {
      const chosen = stale[(Math.floor(next / 16) - 1) % stale.length];
      ranked.splice(ranked.indexOf(chosen), 1);
      ranked.unshift(chosen);
    }
  }
  return [...plans, ...ranked.map((item) => item.target)];
}
