import { homedir } from "node:os";
import { join } from "node:path";
import { ZcodeAppServerClient, type ZcodeClientLike } from "../../executors/zcodeProtocol.ts";
import { createQuotaFromUsage, type UsageQuota } from "./quota.ts";

type JsonRecord = Record<string, unknown>;

export interface ZcodeUsageOptions {
  clientFactory?: () => ZcodeClientLike;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function nativeClient(): ZcodeClientLike {
  const runtimeRoot = process.env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server");
  const command = process.env.ZCODE_SERVER_NODE || join(runtimeRoot, "node");
  const entry = process.env.ZCODE_SERVER_ENTRY || join(runtimeRoot, "zcode-server.cjs");
  return new ZcodeAppServerClient({
    command,
    args: [entry],
    env: { ...process.env, ZCODE_SERVICE_AUTHORITY_MODE: "standalone-server" },
  });
}

function toQuota(snapshot: JsonRecord): UsageQuota | null {
  const quota = asRecord(snapshot.quota);
  const limits = Array.isArray(quota.limits) ? quota.limits.map(asRecord) : [];
  const entitlement = limits.find(
    (limit) => limit.meter === "model_usage" && limit.unitType === "token"
  );
  if (!entitlement) return null;

  const total = Number(entitlement.unit ?? entitlement.number);
  const used = Number(entitlement.usage ?? entitlement.currentValue);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0) return null;
  const result = createQuotaFromUsage(
    used,
    total,
    entitlement.nextResetTime ?? asRecord(snapshot.remaining).nextResetTime
  );
  const percent = Number(asRecord(snapshot.remaining).percentage ?? entitlement.percentage);
  if (Number.isFinite(percent)) {
    result.remainingPercentage = Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
  }
  result.displayName = String(asRecord(quota).level || "ZCode");
  return result;
}

/** Read the signed-in ZCode account's current native entitlement without inference. */
export async function getZcodeUsage(
  provider: string,
  options: ZcodeUsageOptions = {}
): Promise<{ plan: string; quotas: Record<string, UsageQuota> } | { message: string }> {
  if (provider !== "zcode-start") return { message: "Unsupported ZCode plan." };

  const providerId = "account:zai-start-plan";
  const client = options.clientFactory?.() || nativeClient();
  try {
    await client.start();
    const raw = await client.call("usage-stats", "getEntitlementSnapshot", [
      {
        preferredProviderId: providerId,
        accountAccess: { accountType: "zai", mode: "start-plan" },
      },
    ]);
    const snapshot = asRecord(raw);
    if (snapshot.authenticated !== true || asRecord(snapshot.provider).id !== providerId) {
      return { message: "ZCode account entitlement is unavailable for the selected plan." };
    }
    const quota = toQuota(snapshot);
    if (!quota) return { message: "ZCode did not report a usable token entitlement." };
    const details = asRecord(snapshot.subscription).details;
    const detail = Array.isArray(details) ? asRecord(details[0]) : {};
    if (typeof detail.productName === "string") quota.displayName = detail.productName;
    return { plan: quota.displayName || "ZCode", quotas: { tokens: quota } };
  } catch {
    return { message: "Unable to read the signed-in ZCode account entitlement." };
  } finally {
    await client.close().catch(() => undefined);
  }
}
