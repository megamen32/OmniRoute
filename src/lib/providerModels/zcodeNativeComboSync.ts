import { createCombo, getComboByName, getCombos } from "@/lib/db/combos";

type ZcodeModel = {
  id?: unknown;
  name?: unknown;
  inputTokenLimit?: unknown;
  contextWindow?: unknown;
};

function comboName(modelId: string): string {
  const name = `zcode-native/${modelId}`;
  return name.length <= 100 ? name : name.slice(0, 83) + "-" + modelId.slice(-16);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isPinnedToAccount(combo: Record<string, unknown>, modelId: string, connectionId: string) {
  const steps = Array.isArray(combo.models) ? combo.models : [];
  const [step] = steps;
  return (
    combo.isActive !== false &&
    steps.length === 1 &&
    step &&
    typeof step === "object" &&
    (step as Record<string, unknown>).providerId === "zcode-individual" &&
    (step as Record<string, unknown>).model === `zcode-individual/${modelId}` &&
    (step as Record<string, unknown>).connectionId === connectionId
  );
}

/** Keep OpenCode aliases pinned to the account whose native catalog was synced. */
export async function syncZcodeNativeCombos(
  connectionId: string,
  models: readonly ZcodeModel[]
): Promise<{ added: string[]; conflicts: string[] }> {
  const combos = await getCombos();
  const byName = new Map(
    combos.flatMap((combo) =>
      typeof combo.name === "string" ? [[combo.name, combo] as const] : []
    )
  );
  const added: string[] = [];
  const conflicts: string[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const modelId = typeof model.id === "string" ? model.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    const name = comboName(modelId);
    const existing = byName.get(name) || (await getComboByName(name));
    if (existing) {
      if (!isPinnedToAccount(existing, modelId, connectionId)) conflicts.push(name);
      continue;
    }

    const contextLength =
      positiveInteger(model.inputTokenLimit) ?? positiveInteger(model.contextWindow);
    const created = await createCombo({
      name,
      displayName: `${typeof model.name === "string" ? model.name : modelId} · ZCode Individual`,
      description: "Discovered from the selected ZCode Individual account.",
      strategy: "priority",
      ...(contextLength ? { context_length: contextLength } : {}),
      models: [
        {
          kind: "model",
          providerId: "zcode-individual",
          model: `zcode-individual/${modelId}`,
          connectionId,
          weight: 1,
        },
      ],
      config: { maxRetries: 0, maxSetRetries: 0, disableSessionStickiness: true },
      isActive: true,
      version: 2,
    });
    byName.set(name, created);
    added.push(name);
  }

  return { added, conflicts };
}
