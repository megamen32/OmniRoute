import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ZCODE_START_PLAN_PROVIDER_ID = "account:zai-start-plan";
export const ZCODE_START_PLAN_BUILTIN_ID = "builtin:zai-start-plan";
export const ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID = "account:zai-individual-coding-plan";
export const ZCODE_INDIVIDUAL_PLAN_BUILTIN_ID = "builtin:zai-coding-plan";

export type ZcodePlanName = "start" | "individual";
export type ZcodePlanProviderId =
  | typeof ZCODE_START_PLAN_PROVIDER_ID
  | typeof ZCODE_START_PLAN_BUILTIN_ID
  | typeof ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID
  | typeof ZCODE_INDIVIDUAL_PLAN_BUILTIN_ID;

export function resolveZcodeGatewayProviderOrder(configuredProviderId?: string | null): string[] {
  if (configuredProviderId) return [configuredProviderId];
  return [ZCODE_START_PLAN_PROVIDER_ID, ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID];
}

export interface ZcodeGatewayProfile {
  plan: ZcodePlanName;
  providerId: ZcodePlanProviderId;
  apiKey: string;
  messagesUrl: string;
  authScheme: "bearer" | "x-api-key";
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function resolveProfile(providerId: string): {
  plan: ZcodePlanName;
  configProviderId: string;
  messagesPath: string;
  expectedOrigin: string;
  expectedPath: string;
  authScheme: "bearer" | "x-api-key";
} {
  if (providerId === ZCODE_START_PLAN_PROVIDER_ID || providerId === ZCODE_START_PLAN_BUILTIN_ID) {
    return {
      plan: "start",
      configProviderId: ZCODE_START_PLAN_BUILTIN_ID,
      messagesPath: "v1/messages",
      expectedOrigin: "https://zcode.z.ai",
      expectedPath: "/api/v1/zcode-plan/anthropic",
      authScheme: "bearer",
    };
  }
  if (
    providerId === ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID ||
    providerId === ZCODE_INDIVIDUAL_PLAN_BUILTIN_ID
  ) {
    return {
      plan: "individual",
      configProviderId: ZCODE_INDIVIDUAL_PLAN_BUILTIN_ID,
      messagesPath: "messages",
      expectedOrigin: "https://api.z.ai",
      expectedPath: "/api/anthropic/v1",
      authScheme: "x-api-key",
    };
  }
  throw new Error("Unsupported ZCode Coding Plan profile");
}

/**
 * Read one explicitly identified ZCode subscription credential. Start and
 * Individual use separate config entries, origins and authorization schemes;
 * this helper never copies credentials between plans.
 */
export async function readZcodePlanGatewayProfile(
  providerId: string,
  configPath = join(homedir(), ".zcode", "v2", "config.json")
): Promise<ZcodeGatewayProfile> {
  const profileSpec = resolveProfile(providerId);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(configPath, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("ZCode profile config is not a regular file");
    if (process.platform !== "win32") {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid !== undefined && info.uid !== uid)
        throw new Error("ZCode profile config is not owned by the service user");
      if ((info.mode & 0o077) !== 0)
        throw new Error("ZCode profile config permissions are too broad");
    }

    const parsed = asRecord(JSON.parse(await handle.readFile("utf8")));
    const providers = asRecord(parsed.provider);
    const profile = asRecord(providers[profileSpec.configProviderId]);
    if (profile.enabled !== true || profile.kind !== "anthropic")
      throw new Error(`${profileSpec.plan} ZCode Coding Plan profile is not enabled`);

    const options = asRecord(profile.options);
    let baseUrl: URL;
    try {
      baseUrl = new URL(typeof options.baseURL === "string" ? options.baseURL : "");
    } catch {
      throw new Error(`${profileSpec.plan} ZCode Coding Plan profile has an invalid API origin`);
    }
    if (
      baseUrl.origin !== profileSpec.expectedOrigin ||
      baseUrl.pathname.replace(/\/+$/, "") !== profileSpec.expectedPath ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error(
        `${profileSpec.plan} ZCode Coding Plan profile has an unsupported API origin`
      );
    }

    const apiKey = options.apiKey;
    if (typeof apiKey !== "string" || apiKey.length > 2048 || !apiKey || /\s/.test(apiKey)) {
      throw new Error(`${profileSpec.plan} ZCode Coding Plan profile has no valid credential`);
    }
    if (profileSpec.plan === "individual" && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(apiKey)) {
      throw new Error("Individual ZCode Coding Plan profile has an invalid credential format");
    }
    if (profileSpec.plan === "start" && apiKey.split(".").length < 3) {
      throw new Error("Start ZCode Coding Plan profile has an invalid signed credential format");
    }

    const endpoint = new URL(
      `${profileSpec.expectedPath}/${profileSpec.messagesPath}`,
      baseUrl.origin
    );
    return {
      plan: profileSpec.plan,
      providerId: providerId as ZcodePlanProviderId,
      apiKey,
      messagesUrl: endpoint.toString(),
      authScheme: profileSpec.authScheme,
    };
  } finally {
    await handle.close();
  }
}

/** Compatibility wrapper for the Individual-only native gateway call sites. */
export async function readZcodeIndividualCodingPlanApiKey(
  providerId: string,
  configPath = join(homedir(), ".zcode", "v2", "config.json")
): Promise<string> {
  if (
    providerId !== ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID &&
    providerId !== ZCODE_INDIVIDUAL_PLAN_BUILTIN_ID
  ) {
    throw new Error("Native ZCode streaming supports only the explicitly selected Individual Plan");
  }
  const profile = await readZcodePlanGatewayProfile(providerId, configPath);
  return profile.apiKey;
}
