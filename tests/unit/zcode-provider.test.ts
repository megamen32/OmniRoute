import test from "node:test";
import assert from "node:assert/strict";
import { zcodeProvider } from "../../open-sse/config/providers/registry/zcode/index.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.ts";
import { CLI_TOOL_IDS } from "../../src/shared/services/cliRuntime.ts";
import { getProviderById } from "../../src/shared/constants/providers.ts";
import { getAgentById } from "../../src/lib/acp/registry.ts";

test("ZCode provider registry exposes a local no-auth GLM Coding Plan backend", () => {
  assert.equal(zcodeProvider.id, "zcode");
  assert.equal(zcodeProvider.alias, "zc");
  assert.equal(zcodeProvider.executor, "zcode");
  assert.equal(zcodeProvider.format, "openai");
  assert.equal(zcodeProvider.baseUrl, "zcode://app-server/stdio");
  assert.equal(zcodeProvider.authType, "none");
  assert.equal(zcodeProvider.authHeader, "none");
  assert.equal(zcodeProvider.models.some((model) => model.id === "glm-5.2"), true);
  assert.equal(CLI_TOOLS.zcode?.defaultCommand, "zcode");
  assert.equal(CLI_TOOLS.zcode?.acpSpawnable, false);
  assert.equal(CLI_TOOL_IDS.includes("zcode"), true);
  assert.equal(getRegistryEntry("zcode")?.executor, "zcode");
  assert.equal(getExecutor("zcode").constructor.name, "ZcodeExecutor");
  assert.equal(getProviderById("zcode")?.id, "zcode");

  const acpEntry = getAgentById("zcode");
  assert.equal(acpEntry?.providerAlias, "zcode");
  assert.deepEqual(acpEntry?.spawnArgs, ["app-server"]);
  assert.equal(acpEntry?.protocol, "stdio");
});
