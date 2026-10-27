import type { RegistryEntry } from "../../shared.ts";
import { GLM_SHARED_MODELS } from "../../../glmProvider.ts";

const GLM_EXECUTOR_EFFORT_ALIASES = new Set([
  "glm-5.3-high",
  "glm-5.3-low",
  "glm-5.3-flash-high",
  "glm-5.3-flash-low",
  "glm-5.3-flash-max",
  "glm-5.2-high",
  "glm-5.2-max",
]);
const ZCODE_GATEWAY_EFFORT_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

export const ZCODE_MODELS = GLM_SHARED_MODELS.filter(
  (model) => !GLM_EXECUTOR_EFFORT_ALIASES.has(model.id)
).map((model) => ({
  ...model,
  supportedThinkingEfforts: ZCODE_GATEWAY_EFFORT_MODELS.has(model.id)
    ? ["low", "medium", "max"]
    : [],
  supportsVision: Boolean(model.supportsVision),
}));

/**
 * Local ZCode app-server backend. Authentication remains in the user's local
 * ZCode profile (`builtin:zai-coding-plan`); OmniRoute does not receive or
 * persist the Z.ai credential.
 */
export const zcodeProvider: RegistryEntry = {
  id: "zcode",
  alias: "zc",
  format: "openai",
  executor: "zcode",
  baseUrl: "zcode://app-server/stdio",
  authType: "none",
  authHeader: "none",
  // ZCode's app-server transport does not consume reasoning_effort; keep thinking
  // capability metadata without advertising aliases or tiers that it would ignore.
  models: ZCODE_MODELS,
};

/** Explicit Start profile: separate provider identity for routing and quota monitoring. */
export const zcodeStartProvider: RegistryEntry = {
  ...zcodeProvider,
  id: "zcode-start",
  alias: "zc-start",
  executor: "zcode-start",
  models: ZCODE_MODELS.map((model) => ({
    ...model,
    name: `${model.name || model.id} (Z-code Start)`,
  })),
};

/** Explicit Individual profile: separate provider identity for routing and quota monitoring. */
export const zcodeIndividualProvider: RegistryEntry = {
  ...zcodeProvider,
  id: "zcode-individual",
  alias: "zc-individual",
  executor: "zcode-individual",
  models: ZCODE_MODELS.map((model) => ({
    ...model,
    name: `${model.name || model.id} (Z-code Individual)`,
  })),
};
