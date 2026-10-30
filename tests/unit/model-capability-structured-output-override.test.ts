import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelCapabilityEntry } from "../../src/lib/modelsDevSync.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "structured-output-override-"));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  API_KEY_SECRET: "structured-output-override-fixture-secret",
  DISABLE_SQLITE_AUTO_BACKUP: "true",
  APP_LOG_TO_FILE: "false",
});
const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, upsertSyncedCapabilities } = await import(
  "../../src/lib/modelsDevSync.ts"
);
const overrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const caps = await import("../../src/lib/modelCapabilities.ts");
const route = await import("../../src/app/api/model-capability-overrides/route.ts");

const PROVIDER = "minimax";
const MODEL = "MiniMax-M3.1-Flash";
const TARGET = PROVIDER + "/" + MODEL;

test.beforeEach(() => {
  core.resetDbInstance();
  core.getDbInstance();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function capability(patch: Partial<ModelCapabilityEntry> = {}): ModelCapabilityEntry {
  return {
    tool_call: null,
    reasoning: null,
    reasoning_efforts: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: '["text"]',
    modalities_output: '["text"]',
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...patch,
  };
}

function resolvedStructuredOutput(provider: string, model: string) {
  return caps.getResolvedModelCapabilities({ provider, model }).structuredOutput;
}

function patchOverride(body: unknown) {
  return route.PATCH(
    new Request("http://localhost/api/model-capability-overrides", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

test("structured_output override beats a synced structured_output=0 and removal restores it", () => {
  upsertSyncedCapabilities(PROVIDER, { [MODEL]: capability({ structured_output: false }) });
  assert.equal(resolvedStructuredOutput(PROVIDER, MODEL), false);

  assert.equal(overrides.setModelCapabilityOverride(TARGET, "structured_output", true), true);
  assert.equal(resolvedStructuredOutput(PROVIDER, MODEL), true);
  assert.equal(overrides.getStructuredOutputOverride(PROVIDER, MODEL), true);

  assert.equal(overrides.removeModelCapabilityOverride(TARGET, "structured_output"), true);
  assert.equal(overrides.getStructuredOutputOverride(PROVIDER, MODEL), null);
  assert.equal(resolvedStructuredOutput(PROVIDER, MODEL), false);
});

test("without an override the synced structured_output value is kept", () => {
  upsertSyncedCapabilities(PROVIDER, { [MODEL]: capability({ structured_output: true }) });
  assert.equal(resolvedStructuredOutput(PROVIDER, MODEL), true);

  upsertSyncedCapabilities(PROVIDER, { [MODEL]: capability({ structured_output: null }) });
  assert.equal(resolvedStructuredOutput(PROVIDER, MODEL), null);
});

test("catalog sync does not clear a structured_output override", () => {
  upsertSyncedCapabilities(PROVIDER, { [MODEL]: capability({ structured_output: false }) });
  assert.equal(overrides.setModelCapabilityOverride(TARGET, "structured_output", true), true);

  saveModelsDevCapabilities({ [PROVIDER]: { [MODEL]: capability({ structured_output: false }) } });

  assert.equal(overrides.getStructuredOutputOverride(PROVIDER, MODEL), true);
  assert.equal(resolvedStructuredOutput(PROVIDER, MODEL), true);
});

test("API accepts a boolean structured_output override and rejects non-boolean values", async () => {
  const accepted = await patchOverride({ target: "openai/gpt-4o", key: "structured_output", value: true });
  assert.equal(accepted.status, 200);
  const body = (await accepted.json()) as { overrides: Array<{ target: string; key: string; value: unknown }> };
  assert.ok(
    body.overrides.some(
      (entry) => entry.target === "openai/gpt-4o" && entry.key === "structured_output" && entry.value === true
    )
  );
  assert.equal(overrides.getStructuredOutputOverride("openai", "gpt-4o"), true);

  for (const value of ["true", 1, null, { value: true }]) {
    const rejected = await patchOverride({ target: "openai/gpt-4o", key: "structured_output", value });
    assert.equal(rejected.status, 400, "value " + JSON.stringify(value) + " should be rejected");
  }
  assert.equal(overrides.getStructuredOutputOverride("openai", "gpt-4o"), true);
});

