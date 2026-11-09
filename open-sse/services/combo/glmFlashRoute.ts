import type { ResolvedComboTarget } from "./types.ts";

const GLM_FLASH_MODEL = "glm-5.3-flash";

function targetModel(target: Pick<ResolvedComboTarget, "modelStr">): string {
  const slash = target.modelStr.lastIndexOf("/");
  return (slash >= 0 ? target.modelStr.slice(slash + 1) : target.modelStr).toLowerCase();
}

function targetProvider(target: Pick<ResolvedComboTarget, "provider">): string {
  return target.provider.toLowerCase();
}

function declaredTier(target: ResolvedComboTarget): number {
  const provider = targetProvider(target);
  if (provider === "opencode-zen" && targetModel(target).endsWith("-free")) return 0;
  if (provider === "zcode-start") return 1;
  if (provider === "zcode-cn-start") return 2;
  if (provider === "zcode-individual") return 3;
  if (provider === "zcode-cn-individual") return 4;
  if (provider === "glm") return 6;
  return 5;
}

/** True for the operator-declared GLM-5.3-Flash fallback route. */
export function isDeclaredGlmFlashRoute(targets: readonly ResolvedComboTarget[]): boolean {
  return (
    targets.some(
      (target) => targetProvider(target) === "glm" && targetModel(target) === GLM_FLASH_MODEL
    ) && targets.some((target) => targetProvider(target).startsWith("zcode"))
  );
}

/** Put the configured economic tiers back ahead of auto scoring. */
export function orderDeclaredGlmFlashTargets(
  targets: readonly ResolvedComboTarget[]
): ResolvedComboTarget[] {
  if (!isDeclaredGlmFlashRoute(targets)) return [...targets];
  return targets
    .map((target, index) => ({ target, index, tier: declaredTier(target) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ target }) => target);
}
