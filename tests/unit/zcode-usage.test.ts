import assert from "node:assert/strict";
import test from "node:test";
import { getZcodeUsage } from "../../open-sse/services/usage/zcode.ts";
import type { ZcodeClientLike } from "../../open-sse/executors/zcodeProtocol.ts";
import { isSupportedUsageConnection } from "../../src/lib/usage/providerLimits.ts";
import { supportsProviderQuota } from "../../src/shared/utils/providerQuotaVisibility.ts";
import { createZcodeStartVirtualConnection } from "../../src/lib/usage/zcodeVirtualConnection.ts";

function clientWith(snapshot: unknown, calls: unknown[][]): ZcodeClientLike {
  return {
    async start() {},
    async call(channel, method, args) {
      calls.push([channel, method, ...args]);
      return snapshot;
    },
    async close() {},
  };
}

test("ZCode Start quota uses only authenticated native entitlement", async () => {
  const calls: unknown[][] = [];
  const result = await getZcodeUsage("zcode-start", {
    clientFactory: () =>
      clientWith(
        {
          authenticated: true,
          provider: { id: "account:zai-start-plan" },
          remaining: { count: 500_000_000, percentage: 1, nextResetTime: 1793581200000 },
          subscription: { details: [{ productName: "ZCODE WEEKEND BUILD" }] },
          quota: {
            level: "Start",
            limits: [
              {
                unit: 500_000_000,
                usage: 0,
                remaining: 500_000_000,
                meter: "model_usage",
                unitType: "token",
              },
            ],
          },
        },
        calls
      ),
  });

  assert.deepEqual(calls, [
    [
      "usage-stats",
      "getEntitlementSnapshot",
      {
        preferredProviderId: "account:zai-start-plan",
        accountAccess: { accountType: "zai", mode: "start-plan" },
      },
    ],
  ]);
  assert.equal("message" in result, false);
  if ("message" in result) return;
  assert.equal(result.quotas.tokens.total, 500_000_000);
  assert.equal(result.quotas.tokens.used, 0);
  assert.equal(result.quotas.tokens.remaining, 500_000_000);
  assert.equal(result.quotas.tokens.remainingPercentage, 100);
  assert.equal(result.quotas.tokens.displayName, "ZCODE WEEKEND BUILD");
});

test("ZCode rejects snapshots for another provider or unknown provider ids", async () => {
  let calls = 0;
  const invalid = await getZcodeUsage("zcode-start", {
    clientFactory: () =>
      clientWith({ authenticated: true, provider: { id: "builtin:zai-coding-plan" } }, []),
  });
  const unsupported = await getZcodeUsage("zcode-individual", {
    clientFactory: () => {
      calls += 1;
      return clientWith({}, []);
    },
  });

  assert.ok("message" in invalid);
  assert.ok("message" in unsupported);
  assert.equal(calls, 0);
});

test("ZCode Start no-auth connection is eligible for provider quota UI and refresh", () => {
  const connection = createZcodeStartVirtualConnection();
  assert.equal(supportsProviderQuota(connection.provider), true);
  assert.equal(isSupportedUsageConnection(connection), true);
  assert.equal(
    isSupportedUsageConnection({ id: "unrelated", provider: "zcode-start", authType: "none" }),
    false
  );
});
