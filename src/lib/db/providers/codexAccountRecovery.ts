import { backupDbFile } from "../backup";
import { getDbInstance, rowToCamel } from "../core";
import { invalidateDbCache } from "../readCache";
import { toRecord } from "./columns";

type RecordValue = Record<string, unknown>;
type Scope = "codex" | "spark";

function clearScope(data: RecordValue, scope: Scope): void {
  for (const key of [
    "codexScopeRateLimitedUntil",
    "codexScopeRateLimitSource",
    "codexExhaustedWindowByScope",
  ]) {
    const values = { ...toRecord(data[key]) };
    delete values[scope];
    data[key] = values;
  }
  if (toRecord(data.codexQuotaState).scope === scope) delete data.codexExhaustedWindow;
}

/** Atomic, account-scoped release. Credentials and terminal account states are untouched. */
export async function clearCodexAccountCooldown(id: string, scope: Scope = "codex") {
  return mutate(id, (data) => clearScope(data, scope));
}

function mutate(
  id: string,
  apply: (data: RecordValue, connection: RecordValue) => void
): RecordValue | null {
  const db = getDbInstance();
  const result = db.transaction(() => {
    const row = db.prepare("SELECT * FROM provider_connections WHERE id = ?").get(id);
    if (!row) return null;
    const connection = toRecord(rowToCamel(row));
    if (connection.provider !== "codex") return null;
    const data = { ...toRecord(connection.providerSpecificData) };
    const previous = JSON.stringify(data);
    apply(data, connection);
    if (JSON.stringify(data) === previous) return data;
    backupDbFile("pre-write");
    db.prepare(
      "UPDATE provider_connections SET provider_specific_data = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(data), new Date().toISOString(), id);
    return data;
  })();
  // #13389: codex quota/cooldown observations are routing/health-only writes;
  // the model catalog never reads them, so don't bust the /v1/models cache.
  if (result) invalidateDbCache("connections", undefined, { skipModelCatalog: true });
  return result;
}

/** A live usage response hydrates display and releases only fully recovered quota scopes.
 * Compare the pre-fetch state inside the transaction so newer failures win.
 */
export async function syncCodexQuotaObservation(id: string, usage: RecordValue, expected: unknown) {
  if (usage.message) return null;
  const quotas = toRecord(usage.quotas);
  if (!Object.keys(quotas).length) return null;
  return mutate(id, (data, connection) => {
    const before = toRecord(expected);
    for (const scope of ["codex", "spark"] as const) {
      const prefix = scope === "spark" ? "gpt_5_3_codex_spark_" : "";
      const session = toRecord(quotas[`${prefix}session`]);
      const weekly = toRecord(quotas[`${prefix}weekly`]);
      const valid = (window: RecordValue) =>
        typeof window.used === "number" &&
        Number.isFinite(window.used) &&
        window.used >= 0 &&
        typeof window.total === "number" &&
        Number.isFinite(window.total) &&
        window.total > 0;
      if (!valid(session) && !valid(weekly)) continue;
      const keys = [
        "codexScopeRateLimitedUntil",
        "codexScopeRateLimitSource",
        "codexExhaustedWindowByScope",
        "codexQuotaStateByScope",
      ];
      if (
        keys.some(
          (key) =>
            JSON.stringify(toRecord(data[key])[scope]) !==
            JSON.stringify(toRecord(before[key])[scope])
        )
      )
        continue;
      const byScope = { ...toRecord(data.codexQuotaStateByScope) };
      const snapshot: RecordValue = {
        ...toRecord(byScope[scope]),
        observedAt: new Date().toISOString(),
      };
      for (const [window, suffix] of [
        [session, "5h"],
        [weekly, "7d"],
      ] as const) {
        if (!valid(window)) continue;
        Object.assign(snapshot, {
          [`usage${suffix}`]: window.used,
          [`limit${suffix}`]: window.total,
          [`resetAt${suffix}`]: window.resetAt ?? null,
        });
      }
      const evidence = toRecord(usage.codexRecoveryEvidence)[scope];
      if (scope === "codex" && evidence === "single") {
        // A complete one-window response replaces previously hydrated second-window data.
        delete snapshot.usage7d;
        delete snapshot.limit7d;
        delete snapshot.resetAt7d;
      }
      byScope[scope] = snapshot;
      data.codexQuotaStateByScope = byScope;
      if (
        !["banned", "expired", "deactivated", "credits_exhausted"].includes(
          String(connection.testStatus ?? "").toLowerCase()
        ) &&
        valid(session) &&
        Number(session.used) < Number(session.total) &&
        !(scope === "codex"
          ? usage.limitReached === true || usage.codexLimitDenied === true
          : usage.sparkLimitReached === true || usage.sparkLimitDenied === true) &&
        ((valid(weekly) && Number(weekly.used) < Number(weekly.total)) ||
          (scope === "codex" && evidence === "single" && !valid(weekly)))
      )
        clearScope(data, scope);
    }
  });
}
