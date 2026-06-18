import test from "node:test";
import assert from "node:assert/strict";

const usage = await import("../../open-sse/services/usage.ts");
const { USAGE_SUPPORTED_PROVIDERS } = await import("../../src/shared/constants/providers.ts");

const originalDisableConfigFile = process.env.OPENCODE_GO_DISABLE_CONFIG_FILE;

test.beforeEach(() => {
  process.env.OPENCODE_GO_DISABLE_CONFIG_FILE = "1";
});

test.afterEach(() => {
  if (originalDisableConfigFile === undefined) {
    delete process.env.OPENCODE_GO_DISABLE_CONFIG_FILE;
  } else {
    process.env.OPENCODE_GO_DISABLE_CONFIG_FILE = originalDisableConfigFile;
  }
});

test("USAGE_SUPPORTED_PROVIDERS includes opencode-go", () => {
  assert.ok(
    (USAGE_SUPPORTED_PROVIDERS as string[]).includes("opencode-go"),
    "opencode-go must be in the usage-supported providers allowlist"
  );
});

test("getUsageForProvider returns helpful message when opencode-go has no apiKey", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return new Response("unexpected", { status: 500 });
  };

  try {
    const result = (await usage.getUsageForProvider({
      id: "opencode-go-no-key",
      provider: "opencode-go",
      apiKey: "",
    })) as { message?: string };

    assert.equal(called, false, "quota fetch must not run without an API key");
    assert.match(result.message ?? "", /OpenCode Go/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getUsageForProvider exposes OpenCode Go 5h, weekly, and monthly quotas via API fallback", async () => {
  const originalFetch = globalThis.fetch;
  const reset5hSec = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const resetWeeklySec = Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60;
  const resetMonthlySec = Math.floor(Date.now() / 1000) + 20 * 24 * 60 * 60;
  let requestUrl = "";
  let requestHeaders: Headers | null = null;

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers as HeadersInit | undefined);

    // Match the API endpoint used by fetchOpencodeQuota
    return new Response(
      JSON.stringify({
        quota: {
          window_5h: {
            used: 3,
            limit: 12,
            reset_at: reset5hSec,
          },
          window_weekly: {
            used: 15,
            limit: 30,
            reset_at: resetWeeklySec,
          },
          window_monthly: {
            used: 6,
            limit: 60,
            reset_at: resetMonthlySec,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = (await usage.getUsageForProvider({
      id: "opencode-go-api-usage",
      provider: "opencode-go",
      apiKey: "sk-opencode-go-key",
    })) as {
      plan?: string | null;
      quotas?: Record<
        string,
        {
          used: number;
          total: number;
          remaining: number;
          remainingPercentage: number;
          resetAt: string | null;
          displayName?: string;
          currency?: string;
        }
      >;
    };

    assert.match(requestUrl, /opencode\.ai\/zen\/go\/v1\/quota/);
    assert.equal(requestHeaders?.get("Authorization"), "Bearer sk-opencode-go-key");
    assert.equal(result.plan, "OpenCode Go");
    assert.deepEqual(Object.keys(result.quotas ?? {}), [
      "window_5h",
      "window_weekly",
      "window_monthly",
    ]);

    assert.equal(result.quotas!.window_5h.displayName, "$12 / 5-hour");
    assert.equal(result.quotas!.window_5h.currency, "USD");
    assert.equal(result.quotas!.window_5h.used, 3);
    assert.equal(result.quotas!.window_5h.total, 12);
    assert.equal(result.quotas!.window_5h.remaining, 9);
    assert.equal(result.quotas!.window_5h.remainingPercentage, 75);

    assert.equal(result.quotas!.window_weekly.displayName, "$30 / week");
    assert.equal(result.quotas!.window_weekly.used, 15);
    assert.equal(result.quotas!.window_weekly.total, 30);
    assert.equal(result.quotas!.window_weekly.remaining, 15);
    assert.equal(result.quotas!.window_weekly.remainingPercentage, 50);

    assert.equal(result.quotas!.window_monthly.displayName, "$60 / month");
    assert.equal(result.quotas!.window_monthly.used, 6);
    assert.equal(result.quotas!.window_monthly.total, 60);
    assert.equal(result.quotas!.window_monthly.remaining, 54);
    assert.equal(result.quotas!.window_monthly.remainingPercentage, 90);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getUsageForProvider returns helpful message when OpenCode Go quota API returns 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 401 });

  try {
    const result = (await usage.getUsageForProvider({
      id: "opencode-go-401",
      provider: "opencode-go",
      apiKey: "bad-key",
    })) as { message: string };
    assert.match(result.message ?? "", /unable to fetch quota data/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getUsageForProvider returns helpful message when OpenCode Go quota API returns invalid JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  try {
    const result = (await usage.getUsageForProvider({
      id: "opencode-go-bad-json",
      provider: "opencode-go",
      apiKey: "sk-test-key",
    })) as { message: string };
    assert.match(result.message ?? "", /unable to fetch quota data/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
