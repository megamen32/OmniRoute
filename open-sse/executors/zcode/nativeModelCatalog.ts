import type { ProviderCredentials } from "../base.ts";
import { NativeZcodeHostClient } from "./nativeHostClient.ts";
import { nativeZcodeHosts, zcodeNativeProfileCredentials } from "./nativeHostManager.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function isZcodeNativeModelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(value);
}

type NativeAccountModel = { modelId: string; config: Record<string, unknown> };

// Only the named account/tariff can qualify a model for discovery.
export function nativeZcodeAccountModels(view: unknown, providerId: string): NativeAccountModel[] {
  const providers = record(view).providers;
  if (!Array.isArray(providers)) return [];
  const models = providers
    .map(record)
    .find((provider) => provider.providerId === providerId)?.models;
  if (!Array.isArray(models)) return [];
  return models.map(record).flatMap(({ modelId, config }) => {
    const entry = record(config);
    return isZcodeNativeModelId(modelId) && entry.enabled === true
      ? [{ modelId, config: entry }]
      : [];
  });
}

const positiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export function projectNativeZcodeModels(view: unknown, providerId: string) {
  const models = new Map<
    string,
    {
      id: string;
      name: string;
      contextLength?: number;
      maxOutputTokens?: number;
    }
  >();
  for (const { modelId, config } of nativeZcodeAccountModels(view, providerId)) {
    const id = modelId.toLowerCase();
    if (models.has(id)) continue;
    models.set(id, {
      id,
      name: modelId,
      contextLength: positiveInteger(record(config.properties).contextWindow),
      maxOutputTokens: positiveInteger(record(record(config.optionSpecs).maxOutputTokens).max),
    });
  }
  return [...models.values()];
}

export async function readNativeZcodeIndividualCatalog(credentials: ProviderCredentials) {
  const family = credentials.providerSpecificData?.family;
  if (family !== "zai" && family !== "bigmodel") throw new Error("ZCode account region missing");
  const plan = "individual-coding-plan";
  const serverRoot = await nativeZcodeHosts.ensure(
    zcodeNativeProfileCredentials(credentials, plan),
    undefined,
    plan
  );
  const client = new NativeZcodeHostClient({
    serverRoot,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 8000,
  });
  try {
    await client.start();
    const view = await client.call("model-selection", "getView", []);
    return {
      provider: family === "zai" ? "zcode-individual" : "zcode-cn-individual",
      models: projectNativeZcodeModels(view, `account:${family}-${plan}`),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
