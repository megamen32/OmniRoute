/** A bounded real-request canary after a fresh Codex quota observation.
 *
 * A quota GET cannot overrule an upstream 429: a missing weekly window may still
 * be exhausted. This allows ONE existing caller request to reach the pinned
 * account; success clears the model lock in the normal response handler, while
 * another 429 remains an upstream verdict. No polling traffic is generated.
 */
import { getCodexModelScope } from "@omniroute/open-sse/config/codexQuotaScopes.ts";

type RecordValue = Record<string, unknown>;
type Connection = { id: string; providerSpecificData?: RecordValue | null };
type Lockout = { reason: string; lockedAt: string; remainingMs: number };

const MIN_PROBE_INTERVAL_MS = 15 * 60_000;
const MAX_OBSERVATION_AGE_MS = 60 * 60_000;
const MAX_TRACKED = 2048;
const lastProbeAt = new Map<string, number>();

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function openWindow(state: RecordValue, suffix: "5h" | "7d"): boolean | null {
  const used = state[`usage${suffix}`];
  const total = state[`limit${suffix}`];
  if (used === undefined && total === undefined) return null;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0
    || typeof total !== "number" || !Number.isFinite(total) || total <= 0) return false;
  return used < total;
}

/** Claim once per account and scope within a bounded interval. Admission is
 * serialized by the in-process map; do not clear any lock or persisted cooldown.
 */
export function claimCodexRecoveryCanary(
  connection: Connection,
  requestedModel: string,
  lock: Lockout | null | undefined,
  now = Date.now(),
): boolean {
  if (!lock || lock.reason !== "quota_exhausted" || lock.remainingMs <= 0) return false;
  const scope = getCodexModelScope(requestedModel);
  const data = record(connection.providerSpecificData);
  const state = record(record(data.codexQuotaStateByScope)[scope]);
  const observedAt = Date.parse(String(state.observedAt ?? ""));
  const lockedAt = Date.parse(lock.lockedAt);
  if (!Number.isFinite(lockedAt) || !Number.isFinite(observedAt)
    || observedAt <= lockedAt || observedAt > now || now - observedAt > MAX_OBSERVATION_AGE_MS) return false;
  if (record(data.codexExhaustedWindowByScope)[scope]) return false;
  // A *missing* weekly window permits only an isolated canary; it never
  // authorizes a quota unlock or a blanket bypass.
  if (openWindow(state, "5h") !== true || openWindow(state, "7d") === false) return false;
  const key = `${connection.id}:${scope}`;
  if (now - (lastProbeAt.get(key) ?? -Infinity) < MIN_PROBE_INTERVAL_MS) return false;
  if (lastProbeAt.size >= MAX_TRACKED) {
    const oldest = lastProbeAt.keys().next().value;
    if (oldest !== undefined) lastProbeAt.delete(oldest);
  }
  lastProbeAt.set(key, now);
  return true;
}

/** Test-only: no production caller may bulk-clear attempts to bypass throttling. */
export function resetCodexRecoveryCanariesForTests(): void {
  lastProbeAt.clear();
}
