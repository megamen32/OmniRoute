/**
 * Opt-in request-sized combo routing. Unlike the normal advisory context filter,
 * this gate never dispatches a target with a known-insufficient (or unknown) window.
 * It preserves priority order: free/small models first while they fit.
 */
import { getResolvedModelCapabilities } from "../../../src/lib/modelCapabilities";
import { deriveRequestCompatibilityRequirements } from "./comboStructure.ts";
import { evaluateContextLimit } from "./contextOverrideGate.ts";
import type { ComboLogger, ResolvedComboTarget } from "./types.ts";

const UNDECLARED_OUTPUT_RESERVE = 8192;
// Token estimation is approximate (characters/4); avoid routing exactly at the edge.
const INPUT_ESTIMATE_HEADROOM = 1.05;

export function filterTargetsByStrictRequestContext(
  targets: ResolvedComboTarget[],
  body: Record<string, unknown>,
  log: ComboLogger,
  outputLimitAdvisory: boolean
): { targets: ResolvedComboTarget[]; estimatedInputTokens: number; requiredContextTokens: number } {
  const requirements = deriveRequestCompatibilityRequirements(body);
  const estimatedInputTokens = Math.ceil(
    requirements.estimatedInputTokens * INPUT_ESTIMATE_HEADROOM
  );
  const requestedReserve = requirements.requestedOutputTokens || UNDECLARED_OUTPUT_RESERVE;
  let largestRequiredContext = estimatedInputTokens + requestedReserve;

  const kept = targets.filter((target) => {
    const capabilities = getResolvedModelCapabilities({
      provider: target.providerId || target.provider || null,
      model: target.modelStr,
    });
    const outputReserve =
      outputLimitAdvisory &&
      typeof capabilities.maxOutputTokens === "number" &&
      capabilities.maxOutputTokens > 0
        ? Math.min(requestedReserve, capabilities.maxOutputTokens)
        : requestedReserve;
    const requiredContextTokens = estimatedInputTokens + outputReserve;
    largestRequiredContext = Math.max(largestRequiredContext, requiredContextTokens);
    const fits = evaluateContextLimit(
      capabilities,
      { estimatedInputTokens, requiredContextTokens },
      target.modelStr
    );
    if (fits !== true) {
      log.info(
        "COMBO",
        `Strict request-context gate skipped ${target.modelStr} (estimate=${estimatedInputTokens}, reserve=${outputReserve}, context=${capabilities.contextWindow ?? "unknown"})`
      );
    }
    return fits === true;
  });

  return {
    targets: kept,
    estimatedInputTokens,
    requiredContextTokens: largestRequiredContext,
  };
}
