import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchOpencodeQuota,
  invalidateOpencodeQuotaCache,
  registerOpencodeQuotaFetcher,
} from "../../open-sse/services/opencodeQuotaFetcher.ts";
import { preflightQuota } from "../../open-sse/services/quotaPreflight.ts";
import {
  clearQuotaMonitors,
  getActiveMonitorCount,
  startQuotaMonitor,
  stopQuotaMonitor,
} from "../../open-sse/services/quotaMonitor.ts";
import { clearSessions, touchSession } from "../../open-sse/services/sessionManager.ts";

const originalFetch = globalThis.fetch;
const originalDisableConfigFile = process.env.OPENCODE_GO_DISABLE_CONFIG_FILE;

test.beforeEach(() => {
  process.env.OPENCODE_GO_DISABLE_CONFIG_FILE = "1";
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDisableConfigFile === undefined) {
    delete process.env.OPENCODE_GO_DISABLE_CONFIG_FILE;
  } else {
    process.env.OPENCODE_GO_DISABLE_CONFIG_FILE = originalDisableConfigFile;
  }
  clearQuotaMonitors();
  clearSessions();
});

// ─── null / missing credentials ──────────────────────────────────────────────

test("fetchOpencodeQuota returns null when no API key is provided", async () => {
  const quota = await fetchOpencodeQuota(`missing-${Date.now()}`);
  assert.equal(quota, null);
});

test("fetchOpencodeQuota returns null when connection has empty apiKey", async () => {
  const quota = await fetchOpencodeQuota(`empty-key-${Date.now()}`, { apiKey: "" });
  assert.equal(quota, null);
});

// ─── non-200 responses (fail-open) ───────────────────────────────────────────

test("fetchOpencodeQuota returns null on 404 response", async () => {
  const connectionId = `oc-404-${Date.now()}`;

  globalThis.fetch = async () => new Response(null, { status: 404 });

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  assert.equal(quota, null);

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota returns null on 401 (invalid token)", async () => {
  const connectionId = `oc-401-${Date.now()}`;

  globalThis.fetch = async () => new Response(null, { status: 401 });

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "bad-key" });
  assert.equal(quota, null);
});

test("fetchOpencodeQuota returns null on 403 (forbidden)", async () => {
  const connectionId = `oc-403-${Date.now()}`;

  globalThis.fetch = async () => new Response(null, { status: 403 });

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "bad-key" });
  assert.equal(quota, null);
});

test("fetchOpencodeQuota returns null on 500 server error", async () => {
  const connectionId = `oc-500-${Date.now()}`;

  globalThis.fetch = async () => new Response(null, { status: 500 });

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  assert.equal(quota, null);

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota returns null on network error (fail-open)", async () => {
  const connectionId = `oc-net-${Date.now()}`;

  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  assert.equal(quota, null);
});

test("fetchOpencodeQuota returns null on timeout (fail-open)", async () => {
  const connectionId = `oc-timeout-${Date.now()}`;

  globalThis.fetch = async () => {
    await new Promise<never>((_, reject) => setTimeout(reject, 100));
    throw new Error("Timeout");
  };

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  assert.equal(quota, null);
});

// ─── 3-window parsing ($12/5h, $30/wk, $60/mo) ───────────────────────────────

test("fetchOpencodeQuota parses three-window quota response", async () => {
  const connectionId = `oc-three-${Date.now()}`;
  const calls: { url: string; init: RequestInit }[] = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url: url as string, init: init as RequestInit });
    return new Response(
      JSON.stringify({
        quota: {
          window_5h: { used: 4.0, limit: 12.0, reset_at: null },
          window_weekly: { used: 15.0, limit: 30.0, reset_at: null },
          window_monthly: { used: 20.0, limit: 60.0, reset_at: null },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });

  assert.equal(calls.length, 1);
  assert.ok(
    (calls[0].init as Record<string, unknown>)?.headers &&
      ((calls[0].init as Record<string, unknown>).headers as Record<string, unknown>)[
        "Authorization"
      ] === "Bearer test-key",
    "should send Bearer auth"
  );

  assert.ok(quota !== null, "should return a quota object");
  assert.ok(quota!.windows, "should have windows map");

  // window_5h: 4/12 = 33.3%
  assert.ok(
    Math.abs((quota!.windows!["window_5h"].percentUsed as number) - 4 / 12) < 0.001,
    "window_5h percentUsed should be ~0.333"
  );
  // window_weekly: 15/30 = 50%
  assert.ok(
    Math.abs((quota!.windows!["window_weekly"].percentUsed as number) - 0.5) < 0.001,
    "window_weekly percentUsed should be 0.5"
  );
  // window_monthly: 20/60 = 33.3%
  assert.ok(
    Math.abs((quota!.windows!["window_monthly"].percentUsed as number) - 20 / 60) < 0.001,
    "window_monthly percentUsed should be ~0.333"
  );

  // Worst-case: weekly at 50%
  assert.ok(
    Math.abs(quota!.percentUsed - 0.5) < 0.001,
    "overall percentUsed should mirror worst window"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota parses reset_at timestamps in windows", async () => {
  const connectionId = `oc-reset-${Date.now()}`;
  const futureTs = Math.floor((Date.now() + 3_600_000) / 1000); // +1h unix seconds

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        quota: {
          window_5h: { used: 10.0, limit: 12.0, reset_at: futureTs },
          window_weekly: { used: 28.0, limit: 30.0, reset_at: null },
          window_monthly: { used: 55.0, limit: 60.0, reset_at: null },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });

  assert.ok(quota !== null);
  // window_5h reset_at should be an ISO string
  const resetAt5h = quota!.windows?.["window_5h"]?.resetAt;
  assert.ok(typeof resetAt5h === "string", "window_5h resetAt should be an ISO string");
  assert.ok(
    new Date(resetAt5h as string).getTime() > Date.now(),
    "resetAt should be in the future"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota sets limitReached when any window is exhausted", async () => {
  const connectionId = `oc-exhausted-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        quota: {
          window_5h: { used: 12.0, limit: 12.0, reset_at: null },
          window_weekly: { used: 5.0, limit: 30.0, reset_at: null },
          window_monthly: { used: 10.0, limit: 60.0, reset_at: null },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });

  assert.ok(quota !== null);
  // window_5h is 100% used → worst-case
  assert.ok(Math.abs(quota!.percentUsed - 1.0) < 0.001, "percentUsed should be 1.0 when exhausted");
  assert.equal((quota as any).limitReached, true, "limitReached should be true");

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota returns null when quota object is absent from response", async () => {
  const connectionId = `oc-no-quota-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const quota = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  assert.equal(quota, null);

  invalidateOpencodeQuotaCache(connectionId);
});

// ─── caching ─────────────────────────────────────────────────────────────────

test("fetchOpencodeQuota caches results within TTL (second call is a no-op)", async () => {
  const connectionId = `oc-cache-${Date.now()}`;
  let calls = 0;

  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        quota: {
          window_5h: { used: 2.0, limit: 12.0, reset_at: null },
          window_weekly: { used: 10.0, limit: 30.0, reset_at: null },
          window_monthly: { used: 20.0, limit: 60.0, reset_at: null },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const first = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  const second = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });

  assert.equal(calls, 1, "should only hit the network once");
  assert.deepEqual(first, second, "cached result should be identical");

  invalidateOpencodeQuotaCache(connectionId);

  const third = await fetchOpencodeQuota(connectionId, { apiKey: "test-key" });
  assert.equal(calls, 2, "should re-fetch after cache invalidation");
  assert.ok(third !== null);

  invalidateOpencodeQuotaCache(connectionId);
});

// ─── registration + preflight integration ────────────────────────────────────

test("registerOpencodeQuotaFetcher exposes opencode-go quota to preflight system", async () => {
  const connectionId = `oc-preflight-${Date.now()}`;

  registerOpencodeQuotaFetcher();

  // Fully exhausted 5h window — preflight should block
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        quota: {
          window_5h: { used: 12.0, limit: 12.0, reset_at: null },
          window_weekly: { used: 5.0, limit: 30.0, reset_at: null },
          window_monthly: { used: 10.0, limit: 60.0, reset_at: null },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const preflight = await preflightQuota("opencode-go", connectionId, {
    apiKey: "test-key",
    providerSpecificData: { quotaPreflightEnabled: true },
  });

  assert.equal(preflight.proceed, false, "preflight should block when window is exhausted");
  assert.equal(preflight.reason, "quota_exhausted");

  invalidateOpencodeQuotaCache(connectionId);
});

test("registerOpencodeQuotaFetcher also covers opencode and opencode-zen providers", async () => {
  registerOpencodeQuotaFetcher();

  const { getQuotaFetcher } = await import("../../open-sse/services/quotaPreflight.ts");

  assert.ok(getQuotaFetcher("opencode-go"), "opencode-go should be registered");
  assert.ok(getQuotaFetcher("opencode"), "opencode should be registered");
  assert.ok(getQuotaFetcher("opencode-zen"), "opencode-zen should be registered");
});

test("registerOpencodeQuotaFetcher registers opencode-go in quotaMonitor system", async () => {
  const connectionId = `oc-monitor-${Date.now()}`;

  registerOpencodeQuotaFetcher();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        quota: {
          window_5h: { used: 11.0, limit: 12.0, reset_at: null },
          window_weekly: { used: 29.0, limit: 30.0, reset_at: null },
          window_monthly: { used: 58.0, limit: 60.0, reset_at: null },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  touchSession("session-oc", connectionId);
  startQuotaMonitor("session-oc", "opencode-go", connectionId, {
    providerSpecificData: { quotaMonitorEnabled: true },
  });

  assert.equal(getActiveMonitorCount(), 1);

  stopQuotaMonitor("session-oc");
  assert.equal(getActiveMonitorCount(), 0);

  invalidateOpencodeQuotaCache(connectionId);
});

// ─── 404 warning: log once, cache 5 min ────────────────────────────────────

test("404 response is cached for 5 minutes to avoid hammering", async () => {
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const connectionId = `conn-cache-${Date.now()}`;

  // First call: 1 fetch, no cache
  await fetchOpencodeQuota(connectionId, { apiKey: "sk-test-key" });
  const callsAfterFirst = callCount;
  assert.equal(callsAfterFirst, 1);

  // Second call within 5 min: should hit cache, no fetch
  await fetchOpencodeQuota(connectionId, { apiKey: "sk-test-key" });
  const callsAfterSecond = callCount;
  assert.equal(
    callsAfterSecond,
    1,
    `expected cache hit on second 404 call, but fetch ran ${callsAfterSecond - callsAfterFirst} extra times`
  );

  // After invalidation: 1 fresh fetch
  invalidateOpencodeQuotaCache(connectionId);
  await fetchOpencodeQuota(connectionId, { apiKey: "sk-test-key" });
  assert.equal(callCount, callsAfterSecond + 1);
});

// ─── Cookie-auth dashboard scrape (path #1) ──────────────────────────────────

test("fetchOpencodeQuota scrapes the OpenCode Go dashboard when authCookie + workspaceId are configured", async () => {
  const connectionId = `oc-dashboard-${Date.now()}`;
  const calls: { url: string; init: RequestInit }[] = [];

  // Simulate a SolidJS hydration output with `monthlyUsage` first.
  const html = `
    <html><body>
    <script>monthlyUsage:$R[1]={usagePercent:42,resetInSec:86400,label:"Monthly"}</script>
    </body></html>
  `;

  globalThis.fetch = async (url, init) => {
    calls.push({ url: url as string, init: init as RequestInit });
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };

  const quota = await fetchOpencodeQuota(connectionId, {
    apiKey: "sk-test-key", // also set to verify it's NOT used when cookie is configured
    providerSpecificData: {
      workspaceId: "wrk_test_workspace",
      authCookie: "Fe26.2**testcookie",
    },
  });

  assert.ok(quota !== null, "should return a quota object");
  assert.equal(calls.length, 1, "should hit the network exactly once");
  assert.ok(
    calls[0].url.includes("opencode.ai/workspace/wrk_test_workspace/go"),
    `expected dashboard URL, got ${calls[0].url}`
  );
  const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Cookie"], "auth=Fe26.2**testcookie", "should send the auth cookie");
  assert.ok(
    !("Authorization" in headers),
    "should NOT send Bearer auth on the dashboard path (cookie-only)"
  );

  // 42% → 0.42 fraction (only one window is present, so worst-case = 0.42)
  assert.ok(
    Math.abs(quota!.percentUsed - 0.42) < 0.001,
    `percentUsed should mirror 42% worst window, got ${quota!.percentUsed}`
  );
  // Only monthlyUsage is present in this fixture, so window_monthly is the
  // only populated window. window_5h / window_weekly stay at 0 / null.
  assert.ok(
    quota!.windows?.["window_monthly"],
    "should surface the monthly window from the scrape"
  );
  assert.equal(
    Math.round((quota!.windowMonthly.percentUsed ?? 0) * 100),
    42,
    "windowMonthly.percentUsed should be 0.42"
  );
  assert.equal(
    quota!.windowWeekly.percentUsed,
    0,
    "weekly window should default to 0 when not in the dashboard"
  );
  assert.equal(
    quota!.window5h.percentUsed,
    0,
    "5h window should default to 0 when not in the dashboard"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota scrapes correctly when resetInSec comes first in the SSR record", async () => {
  const connectionId = `oc-dash-order-${Date.now()}`;

  // Field order swapped — the parser must still extract both fields.
  const html = `
    <script>
    weeklyUsage:$R[0]={resetInSec:259200,usagePercent:30}
    </script>
  `;

  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie-value",
    },
  });

  assert.ok(quota !== null, "should still parse a valid quota when field order is swapped");
  // 30% is the only window, so worst-case is 0.30
  assert.ok(
    Math.abs(quota!.percentUsed - 0.3) < 0.001,
    `percentUsed should be 0.30, got ${quota!.percentUsed}`
  );
  // resetInSec 259200 → ~3 days from now
  const resetAtIso = quota!.resetAt;
  assert.ok(typeof resetAtIso === "string", "resetAt should be an ISO string");
  const resetAtMs = new Date(resetAtIso as string).getTime();
  const expectedMs = Date.now() + 259_200_000;
  // Allow a 5s tolerance for the test running across the boundary.
  assert.ok(
    Math.abs(resetAtMs - expectedMs) < 5_000,
    `resetAt should be ~3 days from now (delta=${Math.abs(resetAtMs - expectedMs)}ms)`
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota picks the worst window when multiple are present in the SSR output", async () => {
  const connectionId = `oc-dash-multi-${Date.now()}`;

  const html = `
    <script>
    monthlyUsage:$R[0]={usagePercent:10,resetInSec:86400}
    weeklyUsage:$R[1]={usagePercent:80,resetInSec:259200}
    hourlyUsage:$R[2]={usagePercent:55,resetInSec:18000}
    </script>
  `;

  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie-value",
    },
  });

  assert.ok(quota !== null, "should return a quota object");
  // weekly at 80% is the worst
  assert.ok(
    Math.abs(quota!.percentUsed - 0.8) < 0.001,
    `percentUsed should be 0.80 (worst window), got ${quota!.percentUsed}`
  );
  // 259200 seconds → ~3 days
  const resetAtMs = new Date(quota!.resetAt as string).getTime();
  const expectedMs = Date.now() + 259_200_000;
  assert.ok(
    Math.abs(resetAtMs - expectedMs) < 5_000,
    `resetAt should be from the worst window (weekly, ~3d)`
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota returns null when dashboard HTML has no usage records", async () => {
  const connectionId = `oc-dash-empty-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response("<html><body>No usage data</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie-value",
    },
  });

  assert.equal(quota, null, "should fail-open when no usage records are in the HTML");

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota returns null on dashboard 401 (expired cookie) without falling through to API key", async () => {
  const connectionId = `oc-dash-401-${Date.now()}`;
  let callCount = 0;

  globalThis.fetch = (async () => {
    callCount += 1;
    return new Response("Unauthorized", { status: 401 });
  }) as typeof fetch;

  const quota = await fetchOpencodeQuota(connectionId, {
    apiKey: "sk-test-key",
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "expired-cookie",
    },
  });

  assert.equal(quota, null, "expired cookie should fail-open");
  assert.equal(callCount, 1, "should NOT fall through to the API-key endpoint when cookie is set");

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota does not use cookie path when only one of (workspaceId, authCookie) is set", async () => {
  const connectionId = `oc-dash-partial-${Date.now()}`;

  // workspaceId present but authCookie missing → should fall through to API-key path
  // which will 404 (the standard fallback behavior). We're verifying it does NOT
  // attempt the dashboard scrape with an empty cookie.
  globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;

  const quota = await fetchOpencodeQuota(connectionId, {
    apiKey: "sk-test-key",
    providerSpecificData: {
      workspaceId: "wrk_test",
      // authCookie deliberately missing
    },
  });

  assert.equal(quota, null, "partial cookie config should fall through to API-key path");

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota does not use cookie path when authCookie is empty string", async () => {
  const connectionId = `oc-dash-empty-cookie-${Date.now()}`;

  globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;

  const quota = await fetchOpencodeQuota(connectionId, {
    apiKey: "sk-test-key",
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "   ", // whitespace-only — should be treated as missing
    },
  });

  assert.equal(quota, null, "empty cookie should fall through to API-key path");

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota caches successful dashboard scrapes (no second fetch on retry)", async () => {
  const connectionId = `oc-dash-cache-${Date.now()}`;
  let callCount = 0;

  const html = `<script>monthlyUsage:$R[1]={usagePercent:25,resetInSec:86400}</script>`;
  globalThis.fetch = (async () => {
    callCount += 1;
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const first = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie-value",
    },
  });
  const second = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie-value",
    },
  });

  assert.equal(callCount, 1, "should only hit the network once across two calls");
  assert.deepEqual(first, second, "cached result should be identical");

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota URL-encodes the workspaceId in the dashboard path", async () => {
  const connectionId = `oc-dash-encode-${Date.now()}`;
  const calls: { url: string }[] = [];

  globalThis.fetch = async (url) => {
    calls.push({ url: url as string });
    return new Response(`<script>monthlyUsage:$R[1]={usagePercent:10,resetInSec:60}</script>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

  await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      // Contains characters that would be valid in a workspace ID but should
      // be percent-encoded in the URL (e.g., forward-slashes, dots).
      workspaceId: "wrk/test.id with space",
      authCookie: "cookie",
    },
  });

  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.includes("wrk%2Ftest.id%20with%20space"),
    `workspaceId should be URL-encoded, got ${calls[0].url}`
  );
  assert.ok(
    !calls[0].url.includes("wrk/test.id with space"),
    "raw workspaceId should not appear unencoded in the URL"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota sets limitReached when dashboard usage is 100%", async () => {
  const connectionId = `oc-dash-full-${Date.now()}`;

  const html = `<script>monthlyUsage:$R[1]={usagePercent:100,resetInSec:86400}</script>`;
  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie",
    },
  });

  assert.ok(quota !== null);
  assert.equal(quota!.limitReached, true, "limitReached should be true at 100%");
  assert.ok(Math.abs(quota!.percentUsed - 1.0) < 0.001, "percentUsed should be 1.0");

  invalidateOpencodeQuotaCache(connectionId);
});

// ─── openchamber-style fixtures (nested objects, quoted numbers, all windows) ─

test("fetchOpencodeQuota handles nested usageLimit:{} in the dashboard body (openchamber shape)", async () => {
  const connectionId = `oc-dash-nested-${Date.now()}`;

  // Mirrors the live openchamber opencode-go.js plugin — `usageLimit:{}` is a
  // nested object that the previous regex `\{([^}]+)\}` truncated prematurely.
  const html = `
    <script>
    monthlyUsage:$R[1]={usagePercent:42,resetInSec:86400,usageLimit:{used:0,limit:0,resetAt:null},label:"Monthly"}
    </script>
  `;

  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie",
    },
  });

  assert.ok(quota !== null, "must parse despite the nested usageLimit object");
  assert.equal(
    Math.round((quota!.windowMonthly.percentUsed ?? 0) * 100),
    42,
    "usagePercent should be 42% even when a nested usageLimit object is present"
  );
  assert.ok(
    quota!.windowMonthly.resetAt,
    "resetAt should be present (resetInSec 86400 ≈ 1 day from now)"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota parses quoted numeric fields in the dashboard body", async () => {
  const connectionId = `oc-dash-quoted-${Date.now()}`;

  // SolidJS sometimes emits quoted values for serialized props; the parser
  // must still extract the numbers.
  const html = `<script>weeklyUsage:$R[0]={"usagePercent":"73","resetInSec":"259200"}</script>`;

  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie",
    },
  });

  assert.ok(quota !== null);
  assert.equal(
    Math.round((quota!.windowWeekly.percentUsed ?? 0) * 100),
    73,
    "quoted usagePercent should be parsed as 73"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota surfaces all three windows independently when present", async () => {
  const connectionId = `oc-dash-three-${Date.now()}`;

  // All three windows present with the same shape as the live dashboard —
  // rollingUsage is the 5h rolling window, not hourlyUsage.
  const html = `
    <script>
    monthlyUsage:$R[1]={usagePercent:30,resetInSec:86400}
    weeklyUsage:$R[2]={usagePercent:55,resetInSec:259200}
    rollingUsage:$R[3]={usagePercent:10,resetInSec:18000}
    </script>
  `;

  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie",
    },
  });

  assert.ok(quota !== null);
  assert.equal(
    Math.round((quota!.window5h.percentUsed ?? 0) * 100),
    10,
    "rollingUsage should map to window_5h"
  );
  assert.equal(Math.round((quota!.windowWeekly.percentUsed ?? 0) * 100), 55);
  assert.equal(Math.round((quota!.windowMonthly.percentUsed ?? 0) * 100), 30);
  assert.ok(quota!.windows?.["window_5h"]);
  assert.ok(quota!.windows?.["window_weekly"]);
  assert.ok(quota!.windows?.["window_monthly"]);
  // worst window is weekly at 55% → dominant reset = weekly's resetAt
  assert.ok(
    Math.abs(quota!.percentUsed - 0.55) < 0.001,
    `percentUsed should be 0.55 (worst window), got ${quota!.percentUsed}`
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("fetchOpencodeQuota handles JSON-in-__next_f shape with quoted field names", async () => {
  const connectionId = `oc-dash-json-${Date.now()}`;

  // Shape #1 from openchamber's parseWindow: embedded JSON object literal
  // with double-quoted field names. The brace-balanced captureObjectBody
  // must still extract the full body.
  const html = `<script>"rollingUsage":{"usagePercent":7,"resetInSec":1234,"label":"5h"}</script>`;

  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  const quota = await fetchOpencodeQuota(connectionId, {
    providerSpecificData: {
      workspaceId: "wrk_test",
      authCookie: "cookie",
    },
  });

  assert.ok(quota !== null);
  assert.equal(Math.round((quota!.window5h.percentUsed ?? 0) * 100), 7);

  invalidateOpencodeQuotaCache(connectionId);
});
