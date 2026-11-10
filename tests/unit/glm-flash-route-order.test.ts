import test from "node:test";
import assert from "node:assert/strict";

import {
  isDeclaredGlmFlashRoute,
  orderDeclaredGlmFlashTargets,
} from "../../open-sse/services/combo/glmFlashRoute.ts";

const target = (provider: string, model: string, index: number) => ({
  kind: "model" as const,
  stepId: `${provider}-${index}`,
  executionKey: `${provider}-${index}`,
  modelStr: `${provider}/${model}`,
  provider,
  providerId: provider,
  connectionId: null,
  weight: 0,
  label: provider,
});

test("GLM Flash route keeps free, Start, Individual, other, then direct GLM tiers", () => {
  const targets = [
    target("glm", "glm-5.3-flash", 6),
    target("zcode-cn-individual", "glm-5.3-flash", 5),
    target("minimax", "MiniMax-M3.1-Flash", 4),
    target("zcode-individual", "glm-5.3-flash", 3),
    target("zcode-cn-start", "glm-5.3-flash", 2),
    target("zcode-start", "glm-5.3-flash", 1),
    target("opencode-zen", "glm-5.3-flash-free", 0),
  ];

  assert.equal(isDeclaredGlmFlashRoute(targets), true);
  assert.deepEqual(
    orderDeclaredGlmFlashTargets(targets).map((entry) => entry.modelStr),
    [
      "opencode-zen/glm-5.3-flash-free",
      "zcode-start/glm-5.3-flash",
      "zcode-cn-start/glm-5.3-flash",
      "zcode-individual/glm-5.3-flash",
      "zcode-cn-individual/glm-5.3-flash",
      "minimax/MiniMax-M3.1-Flash",
      "glm/glm-5.3-flash",
    ]
  );
});

test("unrelated auto routes keep their incoming order", () => {
  const targets = [target("zcode-start", "glm-5.3-flash", 0), target("glm", "glm-5.3", 1)];
  assert.equal(isDeclaredGlmFlashRoute(targets), false);
  assert.deepEqual(orderDeclaredGlmFlashTargets(targets), targets);
});
