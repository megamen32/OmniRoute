/**
 * usage/codex.ts — Codex (OpenAI / ChatGPT backend) usage fetcher.
 *
 * Extracted from services/usage.ts (god-file decomposition): the Codex family — the ChatGPT
 * backend usage-API config and the getCodexUsage fetcher that reads the persisted workspace
 * binding and shapes quotas via buildCodexUsageQuotas. Depends only on the scalar leaf +
 * codexUsageQuotas — no host coupling — so it lives as a co-located provider leaf. usage.ts
 * imports getCodexUsage (dispatcher). Behavior-preserving move.
 */

import { buildCodexUsageQuotas, findCodexSparkRateLimit } from "../codexUsageQuotas.ts";
import { fetchWithConnectionProxy } from "../connectionProxyFetch.ts";
import { getCodexBackendIdentityHeaders } from "../../config/codexClient.ts";
import { getFieldValue } from "./scalars.ts";

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
};

type CodexUsageFetch = (input: string, init: RequestInit) => Promise<Response>;
let codexUsageFetch: CodexUsageFetch = (input, init) => fetch(input, init);

/** Test-only: replace the usage request. Pass null to restore global fetch. */
export function setCodexUsageFetchForTests(fetchImpl: CodexUsageFetch | null): void {
  codexUsageFetch = fetchImpl ?? ((input, init) => fetch(input, init));
}

/**
 * Evidence for recovery comes from the successful raw response, before the
 * display parser supplies defaults. An absent secondary field is ambiguous;
 * an explicit null is the only accepted one-window Pro shape.
 */
function recoveryEvidence(data: unknown): { codex?: "single" } {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const root = record(data);
  const limit = record(getFieldValue(root, "rate_limit", "rateLimit"));
  const field = (obj: Record<string, unknown>, snake: string, camel: string) =>
    Object.prototype.hasOwnProperty.call(obj, snake) ? obj[snake] : obj[camel];
  const validWindow = (value: unknown) => {
    const window = record(value);
    const used = field(window, "used_percent", "usedPercent");
    const duration = field(window, "limit_window_seconds", "limitWindowSeconds");
    const resetAt = field(window, "reset_at", "resetAt");
    const resetAfter = field(window, "reset_after_seconds", "resetAfterSeconds");
    const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
    return (
      typeof used === "number" &&
      Number.isFinite(used) &&
      used >= 0 &&
      used < 100 &&
      positive(duration) &&
      (positive(resetAt) || positive(resetAfter))
    );
  };
  const open = (value: Record<string, unknown>) =>
    value.allowed === true && field(value, "limit_reached", "limitReached") === false;
  const first = (value: Record<string, unknown>) => field(value, "primary_window", "primaryWindow");
  const second = (value: Record<string, unknown>) =>
    field(value, "secondary_window", "secondaryWindow");
  const firstWindow = record(first(limit));
  const duration = field(firstWindow, "limit_window_seconds", "limitWindowSeconds");
  const plan = getFieldValue(root, "plan_type", "planType");
  const result: { codex?: "single" } = {};
  if (
    open(limit) &&
    validWindow(first(limit)) &&
    typeof plan === "string" &&
    plan.trim().toLowerCase() === "pro" &&
    duration === 604800 &&
    second(limit) === null
  ) {
    result.codex = "single";
  }
  return result;
}

/**
 * Codex (OpenAI) Usage - Fetch from ChatGPT backend API
 * IMPORTANT: Uses persisted workspaceId from OAuth to ensure correct workspace binding.
 * No fallback to other workspaces - strict binding to user's selected workspace.
 */
export async function getCodexUsage(
  accessToken?: string,
  providerSpecificData: Record<string, unknown> = {},
  connectionId?: string
) {
  try {
    // Use persisted workspace ID from OAuth - NO FALLBACK
    const accountId =
      typeof providerSpecificData.workspaceId === "string"
        ? providerSpecificData.workspaceId
        : null;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Same UA/version identity chain as Codex inference (sub2api v0.1.178
      // unified-outbound-identity): usage probes must not show up upstream as
      // an anonymous half-identity next to the converged inference traffic.
      ...getCodexBackendIdentityHeaders(),
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const response = connectionId
      ? await fetchWithConnectionProxy(
          connectionId,
          CODEX_CONFIG.usageUrl,
          {
            method: "GET",
            headers,
          },
          { fetchFn: codexUsageFetch }
        )
      : await codexUsageFetch(CODEX_CONFIG.usageUrl, {
          method: "GET",
          headers,
        });
    if (!response) {
      throw new Error("Codex API error: proxied request failed");
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          message: `Codex token expired or access denied. Please re-authenticate the connection.`,
        };
      }
      throw new Error(`Codex API error: ${response.status}`);
    }

    const data = await response.json();

    const { rateLimit, quotas, bankedResetCredits, rateLimitReachedType, paidCredits } =
      buildCodexUsageQuotas(data);
    const sparkLimitReached = getFieldValue(
      findCodexSparkRateLimit(data).rateLimit,
      "limit_reached",
      "limitReached"
    );

    return {
      ...(typeof sparkLimitReached === "boolean" ? { sparkLimitReached } : {}),
      ...(getFieldValue(rateLimit, "allowed") === false ? { codexLimitDenied: true } : {}),
      ...(getFieldValue(findCodexSparkRateLimit(data).rateLimit, "allowed") === false
        ? { sparkLimitDenied: true }
        : {}),
      plan: String(getFieldValue(data, "plan_type", "planType") || "unknown"),
      limitReached: Boolean(getFieldValue(rateLimit, "limit_reached", "limitReached")),
      quotas,
      codexRecoveryEvidence: recoveryEvidence(data),
      // Banked reset credits (display-only, eligibility-gated — issue #5199).
      // Absent for most accounts; never throws when the upstream omits it.
      ...(bankedResetCredits !== undefined ? { bankedResetCredits } : {}),
      ...(paidCredits ? { paidCredits } : {}),
      ...(rateLimitReachedType !== undefined ? { rateLimitReachedType } : {}),
    };
  } catch (error) {
    return { message: `Failed to fetch Codex usage: ${(error as Error).message}` };
  }
}
