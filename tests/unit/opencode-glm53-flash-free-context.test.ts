import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-glm-free-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { getTokenLimit } = await import("../../open-sse/services/contextManager.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { OpencodeExecutor } = await import("../../open-sse/executors/opencode.ts");
const { _setOpencodeFreeModelsForTests } =
  await import("../../open-sse/executors/opencodeFreeTierContract.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  _setOpencodeFreeModelsForTests(null);
  resetDbInstance();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("OpenCode GLM-5.3-Flash Free uses the published 200K context and 32K output", () => {
  const model = REGISTRY["opencode-zen"].models.find((entry) => entry.id === "glm-5.3-flash-free");
  assert.equal(model?.contextLength, 200_000);
  assert.equal(model?.maxOutputTokens, 32_000);
  const capabilities = getResolvedModelCapabilities({
    provider: "opencode-zen",
    model: "glm-5.3-flash-free",
  });
  assert.equal(capabilities.contextWindow, 200_000);
  assert.equal(capabilities.maxOutputTokens, 32_000);
  assert.equal(getTokenLimit("opencode-zen", "glm-5.3-flash-free"), 200_000);
});

test("OpenCode GLM-5.3-Flash Free uses the current published OpenAI endpoint", () => {
  _setOpencodeFreeModelsForTests(["glm-5.3-flash-free"]);
  const executor = new OpencodeExecutor("opencode-zen");
  assert.equal(
    executor.buildUrl("glm-5.3-flash-free", true),
    "https://opencode.ai/inference/openai/v1/chat/completions"
  );
});
