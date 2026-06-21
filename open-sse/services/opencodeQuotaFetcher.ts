/**
 * opencodeQuotaFetcher.ts — OpenCode Go / OpenCode / OpenCode Zen Quota Fetcher
 *
 * Implements QuotaFetcher for the opencode-go, opencode, and opencode-zen providers
 * (quotaPreflight.ts + quotaMonitor.ts).
 *
 * OpenCode Go has THREE independent quota windows per subscription:
 *   - 5-hour (rolling):  $12 of usage
 *   - Weekly:            $30 of usage
 *   - Monthly:           $60 of usage
 *
 * Two fetch paths are supported (in priority order):
 *
 *   1. **Dashboard scrape** (cookie-auth) — When the connection is configured
 *      with a workspaceId + authCookie, we fetch the OpenCode workspace page
 *      and parse the SolidJS SSR hydration output. This is the only working
 *      path as of 2026 because the official usage API (anomalyco/opencode#16017
 *      / PR #16513) is still unmerged. Adapted from the openchamber-style
 *      opencode-quota plugin (slkiser/opencode-quota#41).
 *
 *      Config resolution (highest priority first):
 *        a) `connection.providerSpecificData.{workspaceId,authCookie}`
 *        b) env vars: `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`
 *
 *   2. **API-key endpoint** (defensive fallback) — When no cookie config is
 *      available, we attempt the official usage endpoint
 *      `https://opencode.ai/zen/go/v1/quota` with `Authorization: Bearer`.
 *      This endpoint currently returns 404 upstream; we log one warning
 *      per process and cache the failure for 5 minutes.
 *
 * Expected response shape (path #2):
 *   {
 *     quota: {
 *       window_5h:      { used: number, limit: number, reset_at: number | null },
 *       window_weekly:  { used: number, limit: number, reset_at: number | null },
 *       window_monthly: { used: number, limit: number, reset_at: number | null }
 *     }
 *   }
 *
 * Cookie scrape regex (path #1) matches the SolidJS hydration output, e.g.:
 *   monthlyUsage:$R[1]={usagePercent:42,resetInSec:86400,...}
 *
 * NOTE: As of 2026, no public quota API exists for OpenCode Go / OpenCode Zen
 * (tracked upstream in anomalyco/opencode#16017, #18648, #31084). Path #1
 * covers users who configure cookie auth; path #2 keeps the door open for
 * the eventual official API.
 *
 * On a 404 response (path #2) we log ONE console.warn (latched per process —
 * not per request) pointing at the upstream tracking issues, then cache the
 * "endpoint unavailable" result for 5 minutes to avoid hammering. On any
 * other non-200 / parse failure we return null (fail-open) silently.
 *
 * Cache: in-memory TTL (60s for success, 5 min for 404).
 *
 * Overrides:
 *   - `OMNIROUTE_OPENCODE_QUOTA_URL` — replace the API-key endpoint URL
 *   - `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` — env-based
 *     dashboard scrape config (used when no per-connection override exists)
 *
 * Registration: call registerOpencodeQuotaFetcher() once at server startup.
 */

import { registerQuotaFetcher, registerQuotaWindows, type QuotaInfo } from "./quotaPreflight.ts";
import { registerMonitorFetcher } from "./quotaMonitor.ts";

// OpenCode quota endpoint — same key works across opencode, opencode-go, opencode-zen
// Default points at /zen/go/v1/quota which returns 404 today (no public quota API yet,
// tracked in anomalyco/opencode#16017).  Set OMNIROUTE_OPENCODE_QUOTA_URL to override.
const OPENCODE_QUOTA_URL =
  process.env.OMNIROUTE_OPENCODE_QUOTA_URL ?? "https://opencode.ai/zen/go/v1/quota";

// Dashboard scrape URL prefix/suffix — `https://opencode.ai/workspace/{id}/go`
// SolidJS hydration output contains `monthlyUsage` with `usagePercent` and
// `resetInSec`. No public API exists; see anomalyco/opencode#16017 / PR #16513.
const OPENCODE_GO_DASHBOARD_PREFIX = "https://opencode.ai/workspace/";
const OPENCODE_GO_DASHBOARD_SUFFIX = "/go";

// Env-var based dashboard config (fallback when connection has no cookie set).
// Matches the openchamber-style opencode-quota plugin convention.
// Read once at module load; tests can override via the per-connection path.
const ENV_OPENCODE_GO_WORKSPACE_ID = process.env["OPENCODE_GO_WORKSPACE_ID"]?.trim() || null;
const ENV_OPENCODE_GO_AUTH_COOKIE = process.env["OPENCODE_GO_AUTH_COOKIE"]?.trim() || null;

// User-Agent for the dashboard scrape (mimics the opencode-quota plugin default).
const SCRAPE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

// Cache TTL — matches Codex / DeepSeek / Bailian pattern (60s)
const CACHE_TTL_MS = 60_000;
// TTL for cached "endpoint unavailable" results (404) — longer to avoid hammering
// a non-existent endpoint
const NO_ENDPOINT_TTL_MS = 5 * 60_000; // 5 minutes

// Window keys as surfaced to the dashboard and quota-window registry
export const OPENCODE_WINDOW_5H = "window_5h";
export const OPENCODE_WINDOW_WEEKLY = "window_weekly";
export const OPENCODE_WINDOW_MONTHLY = "window_monthly";

// Triple-window quota info
export interface OpencodeTripleWindowQuota extends QuotaInfo {
  window5h: { percentUsed: number; resetAt: string | null };
  windowWeekly: { percentUsed: number; resetAt: string | null };
  windowMonthly: { percentUsed: number; resetAt: string | null };
  limitReached: boolean;
}

interface CacheEntry {
  quota: OpencodeTripleWindowQuota | null;
  fetchedAt: number;
  /** true when quota is null because the upstream endpoint returned 404 */
  noEndpoint?: boolean;
}

// In-memory cache: connectionId → { quota, fetchedAt }
const quotaCache = new Map<string, CacheEntry>();

// One-time 404 warning per URL (avoids spamming on every request)
const _warned404Urls = new Set<string>();

/**
 * Reset the 404-warning latch (test-only).
 * Exported for unit tests that want to verify the warning fires on each fresh
 * 404 response.
 */
export function _resetWarned404Urls(): void {
  _warned404Urls.clear();
}

/**
 * Check whether a URL has had its 404 warning already emitted (test-only).
 */
export function _hasWarned404(url: string): boolean {
  return _warned404Urls.has(url);
}

// Auto-cleanup stale entries every 5 minutes
const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 5) {
      quotaCache.delete(key);
    }
  }
}, 5 * 60_000);

if (typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseWindowResetAt(window: Record<string, unknown>): string | null {
  const resetAt = toNumber(window["reset_at"] ?? window["resetAt"], 0);
  if (resetAt > 0) {
    // Unix timestamp in seconds (< 1e12) or milliseconds (>= 1e12)
    return new Date(resetAt < 1e12 ? resetAt * 1000 : resetAt).toISOString();
  }
  const resetAfterSeconds = toNumber(
    window["reset_after_seconds"] ?? window["resetAfterSeconds"],
    0
  );
  if (resetAfterSeconds > 0) {
    return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }
  return null;
}

function parseWindowPercent(window: Record<string, unknown>): number {
  const used = toNumber(window["used"] ?? window["used_amount"], 0);
  const limit = toNumber(window["limit"] ?? window["limit_amount"], 0);
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(1, used / limit));
}

// ─── Cookie auth / dashboard scrape helpers ───────────────────────────────────

/**
 * Resolved cookie-auth config for the OpenCode Go dashboard scrape.
 * Either both fields are present (configured) or both are missing (null).
 */
interface CookieAuth {
  workspaceId: string;
  authCookie: string;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveProviderSpecificData(
  connection: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!connection || typeof connection !== "object") return null;
  const psd = (connection as Record<string, unknown>)["providerSpecificData"];
  if (psd && typeof psd === "object" && !Array.isArray(psd)) {
    return psd as Record<string, unknown>;
  }
  return null;
}

/**
 * Resolve the (workspaceId, authCookie) pair for the dashboard scrape path.
 *
 * Precedence (highest first):
 *   1. `connection.providerSpecificData.{workspaceId,authCookie}`
 *   2. env vars `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`
 *   3. OpenChamber/OpenCode quota plugin config files
 *
 * Returns `null` when either field is missing from every source. The two
 * fields must come from the same source (all-env, all-provider, or all-file)
 * to avoid silently mixing stale config with fresh cookies.
 */
async function resolveCookieAuth(connection?: Record<string, unknown>): Promise<CookieAuth | null> {
  // 1) Per-connection providerSpecificData takes precedence.
  const psd = resolveProviderSpecificData(connection);
  if (psd) {
    const workspaceId = asNonEmptyString(psd["workspaceId"]);
    const authCookie = asNonEmptyString(psd["authCookie"]);
    if (workspaceId && authCookie) {
      return { workspaceId, authCookie };
    }
    // Per-connection override is partial → fall through to env (we never mix).
  }

  // 2) Env-var fallback.
  if (ENV_OPENCODE_GO_WORKSPACE_ID && ENV_OPENCODE_GO_AUTH_COOKIE) {
    return {
      workspaceId: ENV_OPENCODE_GO_WORKSPACE_ID,
      authCookie: ENV_OPENCODE_GO_AUTH_COOKIE,
    };
  }

  // 3) OpenChamber/OpenCode quota plugin config fallback.
  return await loadCookieAuthFromConfigFile();
}

function cookieAuthConfigPathCandidates(): string[] {
  const env = process.env ?? {};
  const explicit = asNonEmptyString(env["OPENCODE_GO_CONFIG_FILE"]);
  const home = asNonEmptyString(env.HOME);
  const xdg = asNonEmptyString(env.XDG_CONFIG_HOME);
  const candidates: string[] = [];

  if (explicit) candidates.push(explicit);
  if (xdg) {
    candidates.push(`${xdg}/opencode/opencode-quota/opencode-go.json`);
    candidates.push(`${xdg}/opencode-bar/opencode-go.json`);
    candidates.push(`${xdg}/openchamber/opencode-go.json`);
  }
  if (home) {
    candidates.push(`${home}/.config/opencode/opencode-quota/opencode-go.json`);
    candidates.push(`${home}/.config/opencode-bar/opencode-go.json`);
    candidates.push(`${home}/.config/openchamber/opencode-go.json`);
  }

  return candidates.filter((candidate) =>
    Boolean(candidate && !candidate.includes("\0") && !candidate.includes("\n"))
  );
}

async function loadCookieAuthFromConfigFile(): Promise<CookieAuth | null> {
  if (process.env.OPENCODE_GO_DISABLE_CONFIG_FILE === "1") return null;

  const { readFile } = await import("node:fs/promises");
  for (const filePath of cookieAuthConfigPathCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      const workspaceId = asNonEmptyString(record.workspaceId);
      const authCookie = asNonEmptyString(record.authCookie);
      if (workspaceId && authCookie) {
        return { workspaceId, authCookie };
      }
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") {
        console.warn(`[OpenCodeGoQuota] Failed to read quota config ${filePath}:`, error);
      }
    }
  }

  return null;
}

// SolidJS SSR hydration output uses `$R[n]={...}` record literals. The field
// order is not guaranteed, and body fields may include nested objects (e.g.
// `usageLimit:{}`). Adapted from the openchamber-style opencode-quota plugin
// (slkiser/opencode-quota#41) which correctly handles both shapes:
//
//   1. JSON-in-__next_f:    "rollingUsage":{...}
//   2. SolidStart inline:   rollingUsage:$R[1]={...}
//
// Examples from the live dashboard:
//   monthlyUsage:$R[1]={usagePercent:42,resetInSec:86400,usageLimit:{...}}
//   weeklyUsage:$R[0]={resetInSec:259200,usagePercent:30,usageLimit:{...}}
//   rollingUsage:$R[2]={usagePercent:5,resetInSec:18000,usageLimit:{...}}

const HTML_DECODE: Record<string, string> = {
  "&quot;": '"',
  "&#34;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&amp;": "&",
  '\\"': '"',
  "\\u0022": '"',
};

function normalizeHtmlEntities(html: string): string {
  let text = html;
  for (const [encoded, decoded] of Object.entries(HTML_DECODE)) {
    text = text.split(encoded).join(decoded);
  }
  return text;
}

interface ScrapeWindow {
  /** usagePercent as a 0..100 integer from the dashboard */
  usagePercent: number;
  /** resetInSec as a non-negative integer (seconds until reset) */
  resetInSec: number;
}

/**
 * Locate the body of `{...}` that follows a `fieldName:` (SolidStart inline)
 * or `"fieldName":` (JSON) marker. Brace-balanced so nested objects like
 * `usageLimit:{}` do not terminate the match early. Mirrors openchamber's
 * `captureObjectBody` so we stay aligned with the reference implementation.
 */
function captureObjectBody(fieldName: string, text: string): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match both:
  //   fieldName:$R[123]={...}
  //   "fieldName":{...}      (also unquoted fieldName:{...})
  const pattern = new RegExp(`["']?${escaped}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{`, "s");
  const match = pattern.exec(text);
  if (!match) return null;

  // Walk forward from the end of the opening `{`, balancing nested braces so
  // the body is the full object literal (including any nested objects).
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i);
      }
    }
  }
  return null;
}

/**
 * Extract a numeric field by name. Accepts:
 *   fieldName:42
 *   fieldName:"42"
 *   "fieldName":42
 *   "fieldName":"42"
 * Mirrors openchamber's `captureNumber` so we don't choke on quoted integers
 * (which SolidJS emits for some serialized props).
 */
function captureNumber(fieldName: string, text: string): number | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`["']?${escaped}["']?\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`);
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a single window record from the dashboard HTML body. Returns null
 * when either `usagePercent` or `resetInSec` is missing — the dashboard
 * always emits both together.
 */
function parseWindow(fieldName: string, text: string): ScrapeWindow | null {
  const body = captureObjectBody(fieldName, text);
  if (!body) return null;

  const usagePercent = captureNumber("usagePercent", body);
  const resetInSec = captureNumber("resetInSec", body);
  if (usagePercent === null || resetInSec === null) return null;

  return {
    usagePercent: Math.max(0, Math.min(100, usagePercent)),
    resetInSec: Math.max(0, Math.round(resetInSec)),
  };
}

/** Window labels as surfaced to the dashboard. */
const WINDOW_FIELD_NAMES: Record<string, string> = {
  monthly: "monthlyUsage",
  weekly: "weeklyUsage",
  hourly: "rollingUsage",
};

export interface ParsedDashboardUsage {
  monthly: ScrapeWindow | null;
  weekly: ScrapeWindow | null;
  hourly: ScrapeWindow | null;
}

/**
 * Parse the SolidJS SSR hydration output of the OpenCode Go workspace page.
 *
 * Returns a per-window record (5h rolling, weekly, monthly) or `null` if no
 * usage records were found. Mirrors openchamber's `parseDashboardUsage` so
 * we extract each window independently rather than collapsing to a single
 * "worst" value.
 */
function parseDashboardUsage(html: string): ParsedDashboardUsage | null {
  const text = normalizeHtmlEntities(html);

  const result: ParsedDashboardUsage = {
    monthly: parseWindow(WINDOW_FIELD_NAMES.monthly, text),
    weekly: parseWindow(WINDOW_FIELD_NAMES.weekly, text),
    hourly: parseWindow(WINDOW_FIELD_NAMES.hourly, text),
  };

  if (!result.monthly && !result.weekly && !result.hourly) return null;
  return result;
}

/**
 * Build a `OpencodeTripleWindowQuota` from a dashboard scrape result. Each
 * window from the dashboard is surfaced under its own `OPENCODE_WINDOW_*`
 * key so the UI can display 5h / weekly / monthly independently.
 */
function buildQuotaFromScrape(parsed: ParsedDashboardUsage): OpencodeTripleWindowQuota {
  const toWindow = (
    scrape: ScrapeWindow | null
  ): { percentUsed: number; resetAt: string | null } => {
    if (!scrape) return { percentUsed: 0, resetAt: null };
    return {
      percentUsed: scrape.usagePercent / 100,
      resetAt: new Date(Date.now() + scrape.resetInSec * 1000).toISOString(),
    };
  };

  // Dashboard exposes hourly (5h rolling) and weekly/monthly separately.
  // We map `hourly` to our `window_5h` label to match the OpenCode Go plan
  // ($12 rolling 5h cap) and the rest to their own keys.
  const window5h = toWindow(parsed.hourly);
  const windowWeekly = toWindow(parsed.weekly);
  const windowMonthly = toWindow(parsed.monthly);

  const worstPercent = Math.max(
    window5h.percentUsed,
    windowWeekly.percentUsed,
    windowMonthly.percentUsed
  );
  const limitReached = worstPercent >= 1;

  const windows: Record<string, { percentUsed: number; resetAt: string | null }> = {};
  if (parsed.hourly) windows[OPENCODE_WINDOW_5H] = window5h;
  if (parsed.weekly) windows[OPENCODE_WINDOW_WEEKLY] = windowWeekly;
  if (parsed.monthly) windows[OPENCODE_WINDOW_MONTHLY] = windowMonthly;

  // Dominant reset: prefer the worst window's reset time.
  let dominantResetAt: string | null = null;
  if (
    window5h.percentUsed >= windowWeekly.percentUsed &&
    window5h.percentUsed >= windowMonthly.percentUsed
  ) {
    dominantResetAt = window5h.resetAt ?? windowWeekly.resetAt ?? windowMonthly.resetAt;
  } else if (windowWeekly.percentUsed >= windowMonthly.percentUsed) {
    dominantResetAt = windowWeekly.resetAt ?? window5h.resetAt ?? windowMonthly.resetAt;
  } else {
    dominantResetAt = windowMonthly.resetAt ?? windowWeekly.resetAt ?? window5h.resetAt;
  }

  return {
    used: worstPercent * 100,
    total: 100,
    percentUsed: worstPercent,
    resetAt: dominantResetAt,
    windows,
    window5h,
    windowWeekly,
    windowMonthly,
    limitReached,
  };
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseOpencodeQuotaResponse(data: unknown): OpencodeTripleWindowQuota | null {
  const obj = toRecord(data);
  const quotaObj = toRecord(obj["quota"] ?? obj["data"] ?? obj["usage"]);

  // Look for windows under various possible keys
  const w5h = toRecord(
    quotaObj[OPENCODE_WINDOW_5H] ?? quotaObj["5h"] ?? quotaObj["hourly"] ?? quotaObj["short"]
  );
  const wWeekly = toRecord(
    quotaObj[OPENCODE_WINDOW_WEEKLY] ?? quotaObj["weekly"] ?? quotaObj["week"] ?? quotaObj["wk"]
  );
  const wMonthly = toRecord(
    quotaObj[OPENCODE_WINDOW_MONTHLY] ?? quotaObj["monthly"] ?? quotaObj["month"] ?? quotaObj["mo"]
  );

  const has5h = Object.keys(w5h).length > 0;
  const hasWeekly = Object.keys(wWeekly).length > 0;
  const hasMonthly = Object.keys(wMonthly).length > 0;

  // Need at least one window to be meaningful
  if (!has5h && !hasWeekly && !hasMonthly) return null;

  const percent5h = has5h ? parseWindowPercent(w5h) : 0;
  const percentWeekly = hasWeekly ? parseWindowPercent(wWeekly) : 0;
  const percentMonthly = hasMonthly ? parseWindowPercent(wMonthly) : 0;

  const resetAt5h = has5h ? parseWindowResetAt(w5h) : null;
  const resetAtWeekly = hasWeekly ? parseWindowResetAt(wWeekly) : null;
  const resetAtMonthly = hasMonthly ? parseWindowResetAt(wMonthly) : null;

  const worstPercent = Math.max(percent5h, percentWeekly, percentMonthly);
  const limitReached =
    Boolean(obj["limit_reached"] ?? quotaObj["limit_reached"]) || worstPercent >= 1;

  // Dominant reset: pick the window with the worst usage
  let dominantResetAt: string | null = null;
  if (worstPercent === percent5h) {
    dominantResetAt = resetAt5h ?? resetAtWeekly ?? resetAtMonthly;
  } else if (worstPercent === percentWeekly) {
    dominantResetAt = resetAtWeekly ?? resetAt5h ?? resetAtMonthly;
  } else {
    dominantResetAt = resetAtMonthly ?? resetAtWeekly ?? resetAt5h;
  }

  const window5h = { percentUsed: percent5h, resetAt: resetAt5h };
  const windowWeekly = { percentUsed: percentWeekly, resetAt: resetAtWeekly };
  const windowMonthly = { percentUsed: percentMonthly, resetAt: resetAtMonthly };

  const windows: Record<string, { percentUsed: number; resetAt: string | null }> = {};
  if (has5h) windows[OPENCODE_WINDOW_5H] = window5h;
  if (hasWeekly) windows[OPENCODE_WINDOW_WEEKLY] = windowWeekly;
  if (hasMonthly) windows[OPENCODE_WINDOW_MONTHLY] = windowMonthly;

  return {
    used: worstPercent * 100,
    total: 100,
    percentUsed: worstPercent,
    resetAt: dominantResetAt,
    windows,
    window5h,
    windowWeekly,
    windowMonthly,
    limitReached,
  };
}

// ─── Core Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch current quota for an OpenCode connection.
 * Returns percentUsed = max(5h%, weekly%, monthly%) — worst-case across all windows.
 *
 * Defensive implementation: returns null on any non-200 / parse failure (fail-open).
 * See module-level JSDoc for upstream API stability note.
 *
 * @param connectionId - Connection ID from the DB (used for cache keying)
 * @param connection - Optional connection snapshot with apiKey and/or
 *                     providerSpecificData.workspaceId + providerSpecificData.authCookie
 * @returns OpencodeTripleWindowQuota or null if fetch fails / no credentials
 */
export async function fetchOpencodeQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<OpencodeTripleWindowQuota | null> {
  // Check cache first
  const cached = quotaCache.get(connectionId);
  if (cached) {
    // 404 sentinel — use longer TTL to avoid hammering a non-existent endpoint
    if (cached.noEndpoint && Date.now() - cached.fetchedAt < NO_ENDPOINT_TTL_MS) {
      return null;
    }
    if (cached.quota !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.quota;
    }
  }

  // Path #1: dashboard scrape (cookie auth) — preferred when configured.
  // See module-level JSDoc for config resolution order.
  const cookieAuth = await resolveCookieAuth(connection);
  if (cookieAuth) {
    const quota = await fetchOpencodeQuotaFromDashboard(cookieAuth);
    if (quota) {
      quotaCache.set(connectionId, { quota, fetchedAt: Date.now() });
      return quota;
    }
    // Scrape failed (network / 401 / parse). Don't fall through to the
    // API-key path — the connection is configured for cookie auth, the
    // bearer attempt would just add a 404 warning noise. Return null.
    return null;
  }

  // Path #2: API-key endpoint (defensive fallback). Returns null when no
  // apiKey is set on the connection (no auth at all).
  const apiKey =
    typeof connection?.apiKey === "string" && connection.apiKey.trim().length > 0
      ? connection.apiKey
      : null;

  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch(OPENCODE_QUOTA_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Upstream doesn't expose this endpoint. Warn once per URL per process so
        // operators know the dashboard will be empty for opencode-go connections.
        // Cache a 404 sentinel for NO_ENDPOINT_TTL_MS to avoid hammering.
        // See opencode issues #10448, #16017, #18648, #31084.
        if (!_warned404Urls.has(OPENCODE_QUOTA_URL)) {
          _warned404Urls.add(OPENCODE_QUOTA_URL);
          console.warn(
            `[opencodeQuotaFetcher] ${OPENCODE_QUOTA_URL} returned 404 — opencode-go usage API is not yet public. ` +
              `Set OMNIROUTE_OPENCODE_QUOTA_URL to a working endpoint, or follow ` +
              `https://github.com/anomalyco/opencode/issues/16017 for upstream status. ` +
              `Alternatively, configure a workspaceId + authCookie on the connection ` +
              `(or via OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE env vars) to enable dashboard scraping.`
          );
        }
        quotaCache.set(connectionId, {
          quota: null,
          fetchedAt: Date.now(),
          noEndpoint: true,
        });
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        quotaCache.delete(connectionId);
      }
      return null;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      // Malformed JSON — fail open
      return null;
    }

    const quota = parseOpencodeQuotaResponse(data);
    if (!quota) return null;

    // Store in cache
    quotaCache.set(connectionId, { quota, fetchedAt: Date.now() });
    return quota;
  } catch {
    // Network error, timeout, etc. — fail open
    return null;
  }
}

/**
 * Path #1: dashboard scrape. Fetches the SolidJS-rendered workspace page
 * and parses the SSR hydration output for `monthlyUsage` / `weeklyUsage` /
 * `hourlyUsage` records. Returns null on any failure (fail-open).
 *
 * The dashboard is public-facing HTML, so we send a Mozilla UA + the
 * `auth=<cookie>` cookie that the workspace owner gets after login. See
 * anomalyco/opencode#16017 / PR #16513 for upstream API status.
 */
async function fetchOpencodeQuotaFromDashboard(
  auth: CookieAuth
): Promise<OpencodeTripleWindowQuota | null> {
  try {
    const url = `${OPENCODE_GO_DASHBOARD_PREFIX}${encodeURIComponent(auth.workspaceId)}${OPENCODE_GO_DASHBOARD_SUFFIX}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": SCRAPE_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        Cookie: `auth=${auth.authCookie}`,
      },
      // Dashboard pages can be large; give a bit more headroom than the
      // JSON path so we don't timeout on slow links.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // 401/403 means the cookie has expired or the workspace is wrong.
      // 404 means the workspace ID doesn't exist. Both are fail-open.
      return null;
    }

    const html = await response.text();
    const scrape = parseDashboardUsage(html);
    if (!scrape) return null;

    return buildQuotaFromScrape(scrape);
  } catch {
    // Network error, timeout, etc. — fail open.
    return null;
  }
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

/**
 * Force-invalidate the cache for a connection (e.g., after receiving quota headers).
 */
export function invalidateOpencodeQuotaCache(connectionId: string): void {
  quotaCache.delete(connectionId);
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the OpenCode quota fetcher with the preflight and monitor systems
 * for all three provider variants: opencode-go, opencode, opencode-zen.
 *
 * Call this once at server startup (in chat.ts, before registerGenericQuotaFetchers).
 */
export function registerOpencodeQuotaFetcher(): void {
  for (const provider of ["opencode-go", "opencode", "opencode-zen"] as const) {
    registerQuotaFetcher(provider, fetchOpencodeQuota);
    registerMonitorFetcher(provider, fetchOpencodeQuota);
    registerQuotaWindows(provider, [
      OPENCODE_WINDOW_5H,
      OPENCODE_WINDOW_WEEKLY,
      OPENCODE_WINDOW_MONTHLY,
    ]);
  }
}
