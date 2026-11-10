import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-strict-context-routing-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { setModelContextOverride } = await import("../../src/lib/db/modelContextOverrides.ts");
const { getModelContextLimit } = await import("../../src/lib/modelCapabilities.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");

const log = { info() {}, warn() {}, error() {}, debug() {} };
const FREE = "opencode-zen/glm-5.3-flash-free";
const ZCODE = "zcode-start/glm-5.3-flash";
const MINIMAX = "minimax/MiniMax-M3.1-Flash";
const ZCODE_PROVIDERS = [
  "zcode-start",
  "zcode-cn-start",
  "zcode-individual",
  "zcode-cn-individual",
];

function spec(window: number, output: number) {
  return {
    tool_call: true,
    reasoning: false,
    attachment: false,
    structured_output: true,
    temperature: true,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: false,
    limit_context: window,
    limit_input: null,
    limit_output: output,
    interleaved_field: null,
  };
}

function contextBody(estimatedInputTokens: number, maxTokens?: number) {
  return {
    messages: [{ role: "user", content: "x".repeat(estimatedInputTokens * 4) }],
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
}

function setupCapabilities() {
  saveModelsDevCapabilities({
    "opencode-zen": { "glm-5.3-flash-free": spec(200_000, 32_000) },
    minimax: { "MiniMax-M3.1-Flash": spec(1_000_000, 524_288) },
  });
  for (const provider of ZCODE_PROVIDERS) {
    setModelContextOverride(provider, "glm-5.3-flash", 1_000_000, "manual");
  }
}

async function route(
  body: Record<string, unknown>,
  overrides: {
    strict?: boolean;
    available?: string[];
    models?: string[];
    outputLimitAdvisory?: boolean;
  } = {}
) {
  const attempted: string[] = [];
  const result = await handleComboChat({
    body,
    combo: {
      name: "test-free-first-context-routing",
      strategy: "priority",
      models: overrides.models ?? [FREE, ZCODE, MINIMAX],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        strictRequestContextRouting: overrides.strict ?? true,
        outputLimitAdvisory: overrides.outputLimitAdvisory ?? true,
        disableSessionStickiness: true,
      },
    },
    handleSingleModel: async (_request, model) => {
      attempted.push(model);
      return new Response(JSON.stringify({ model }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    isModelAvailable: async (model) =>
      overrides.available === undefined || overrides.available.includes(model),
    log,
  });
  return { status: result.status, attempted, body: await result.text() };
}

test.after(() => {
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(() => {
  clearModelsDevCapabilities();
  setupCapabilities();
});

test("all four ZCode provider variants advertise their operator-verified million-token window", () => {
  for (const provider of ZCODE_PROVIDERS) {
    assert.equal(getModelContextLimit(provider, "glm-5.3-flash"), 1_000_000);
  }
});

test("small request stays on free before larger alternatives", async () => {
  const out = await route(contextBody(70_000, 8_000));
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempted, [FREE]);
});

test("strict context routing does not restore a larger target without caller tools", async () => {
  saveModelsDevCapabilities({
    "opencode-zen": { "glm-5.3-flash-free": spec(200_000, 32_000) },
    minimax: { "MiniMax-M3.1-Flash": { ...spec(1_000_000, 32_000), tool_call: false } },
  });

  const out = await route(
    {
      ...contextBody(230_000, 8_000),
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
    },
    { models: [FREE, MINIMAX] }
  );

  assert.equal(out.status, 400);
  assert.deepEqual(out.attempted, []);
  assert.match(out.body, /capability_mismatch|supports tool calling/i);
});

test("strict context routing keeps free first when a later target is too small", async () => {
  saveModelsDevCapabilities({
    "opencode-zen": { "glm-5.3-flash-free": spec(200_000, 32_000) },
    minimax: { "MiniMax-M3.1-Flash": spec(64_000, 32_000) },
  });

  const out = await route(contextBody(70_000, 8_000));

  assert.equal(out.status, 200);
  assert.deepEqual(out.attempted, [FREE]);
});

test("large request skips free and uses first available 1M ZCode model", async () => {
  const out = await route(contextBody(230_000, 8_000));
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempted, [ZCODE]);
});

test("output reserve triggers switch before free window is completely filled", async () => {
  const out = await route(contextBody(180_000, 24_000));
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempted, [ZCODE]);
});

test("oversized free does not return via last-resort compatibility fallback", async () => {
  const out = await route(contextBody(230_000, 8_000), { available: [FREE] });
  assert.equal(out.status, 503);
  assert.deepEqual(out.attempted, []);
});

test("all-too-small or unknown-context candidates fail closed without upstream dispatch", async () => {
  const out = await route(contextBody(230_000, 8_000), {
    models: [FREE, "unit-no-context/unknown"],
  });
  assert.equal(out.status, 400);
  assert.deepEqual(out.attempted, []);
  assert.match(out.body, /context_length_exceeded|context window/i);
});

test("when disabled, old advisory fallback semantics stay unchanged", async () => {
  const out = await route(contextBody(230_000, 8_000), {
    strict: false,
    models: [FREE],
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempted, [FREE]);
});

test("outputLimitAdvisory uses provider-capped output reserve for free", async () => {
  const out = await route(contextBody(130_000, 128_000));
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempted, [FREE]);
});
