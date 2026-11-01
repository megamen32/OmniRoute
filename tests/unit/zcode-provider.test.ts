import test from "node:test";
import assert from "node:assert/strict";
import {
  zcodeIndividualProvider,
  ZCODE_MODELS,
  zcodeStartProvider,
} from "../../open-sse/config/providers/registry/zcode/index.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import {
  NOAUTH_PROVIDERS,
  providerAllowsOptionalApiKey,
} from "../../src/shared/constants/providers.ts";

test("ZCode registry retains model metadata for OAuth plan providers", () => {
  for (const provider of [zcodeStartProvider, zcodeIndividualProvider]) {
    assert.equal(provider.format, "openai");
    assert.equal(provider.baseUrl, "zcode://app-server/stdio");
    assert.equal(provider.authType, "oauth");
    assert.equal(provider.authHeader, "none");
  }
  assert.equal(
    ZCODE_MODELS.find((model) => model.id === "glm-5.3-flash")?.supportsVision,
    true
  );
  assert.equal(
    Boolean(ZCODE_MODELS.find((model) => model.id === "glm-5.3")?.supportsVision),
    false
  );
  assert.equal(
    ZCODE_MODELS.some((model) => model.id === "glm-5.2"),
    true
  );
  for (const alias of [
    "glm-5.3-high",
    "glm-5.3-low",
    "glm-5.3-flash-high",
    "glm-5.3-flash-low",
    "glm-5.3-flash-max",
    "glm-5.2-high",
    "glm-5.2-max",
  ]) {
    assert.equal(
      ZCODE_MODELS.some((model) => model.id === alias),
      false,
      alias
    );
  }
  assert.deepEqual(
    ZCODE_MODELS.find((model) => model.id === "glm-5.3")?.supportedThinkingEfforts,
    ["low", "medium", "max"]
  );
  assert.deepEqual(
    ZCODE_MODELS.find((model) => model.id === "glm-5.3-flash")?.supportedThinkingEfforts,
    ["low", "medium", "max"]
  );
  assert.deepEqual(
    ZCODE_MODELS.find((model) => model.id === "glm-5.2")?.supportedThinkingEfforts,
    []
  );
});

test("combo profile executors are independently identifiable to request monitoring", async () => {
  const [start, individual] = await Promise.all([
    getExecutor("zcode-start"),
    getExecutor("zcode-individual"),
  ]);
  assert.equal(start.getProvider(), "zcode-start");
  assert.equal(individual.getProvider(), "zcode-individual");
  assert.notEqual(start, individual);
});

test("ZCode Start and Individual are separate catalog routes for combo quota tracking", () => {
  assert.deepEqual(
    [
      [zcodeStartProvider.id, zcodeStartProvider.alias, zcodeStartProvider.executor],
      [zcodeIndividualProvider.id, zcodeIndividualProvider.alias, zcodeIndividualProvider.executor],
    ],
    [
      ["zcode-start", "zc-start", "zcode-start"],
      ["zcode-individual", "zc-individual", "zcode-individual"],
    ]
  );
  assert.match(
    zcodeStartProvider.models.find((model) => model.id === "glm-5.3-flash")?.name || "",
    /Z-code Start/
  );
  assert.match(
    zcodeIndividualProvider.models.find((model) => model.id === "glm-5.3-flash")?.name || "",
    /Z-code Individual/
  );
  assert.equal(
    zcodeStartProvider.models.find((model) => model.id === "glm-5.3-flash")
      ?.supportedThinkingEfforts,
    ZCODE_MODELS.find((model) => model.id === "glm-5.3-flash")?.supportedThinkingEfforts
  );
  assert.equal(NOAUTH_PROVIDERS["zcode-start"].noAuth, true);
  assert.equal(NOAUTH_PROVIDERS["zcode-individual"].noAuth, true);
  assert.equal(providerAllowsOptionalApiKey("zcode-start"), true);
  assert.equal(providerAllowsOptionalApiKey("zcode-individual"), true);
});
