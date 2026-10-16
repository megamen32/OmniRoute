import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zcode-"));
process.env.DATA_DIR = TEST_DATA_DIR;

test.after(() => cleanupTempDataDir(TEST_DATA_DIR));

async function loadZcodeExecutor() {
  return import("../../open-sse/executors/zcode.ts");
}

function requestBody() {
  return {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Reply with a short status." },
    ],
  };
}

test("ZCode selects exact native Coding Plan IDs and required reasoning without a custom-provider fallback", async () => {
  const { resolveZcodeSelection } = await loadZcodeExecutor();
  const view = {
    providers: [
      { providerId: "custom", models: [{ modelId: "glm-5.3-flash", config: {} }] },
      {
        providerId: "account:zai-individual-coding-plan",
        models: [
          {
            modelId: "GLM-5.3-Flash",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
          },
        ],
      },
    ],
  };
  assert.deepEqual(resolveZcodeSelection(view, "glm-5.3-flash"), {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high" },
  });
  assert.throws(
    () => resolveZcodeSelection({ providers: [view.providers[0]] }, "glm-5.3-flash"),
    /not enabled/
  );
  assert.throws(() => resolveZcodeSelection(view, "glm-5.3-flash", "missing"), /not enabled/);
  assert.deepEqual(
    resolveZcodeSelection(
      {
        providers: [
          { providerId: "builtin:zai-coding-plan", models: [{ modelId: "glm-5.2", config: {} }] },
        ],
      },
      "glm-5.2"
    ),
    {
      providerId: "builtin:zai-coding-plan",
      modelId: "glm-5.2",
    }
  );
});

test("ZCode accepts GLM Coding Plan models and rejects unsafe/unknown ids", async () => {
  const { resolveZcodeModel } = await loadZcodeExecutor();
  assert.deepEqual(resolveZcodeModel("glm-5.2"), { ok: true, model: "glm-5.2" });
  assert.equal(resolveZcodeModel("glm-5.2-high").ok, false);
  assert.equal(resolveZcodeModel("glm-5.3-low").ok, false);
  assert.equal(resolveZcodeModel("-unexpected").ok, false);
  assert.equal(resolveZcodeModel("unknown-model").ok, false);
});

test("ZCode runs a local app-server turn and returns an OpenAI chat completion", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    pollIntervalMs: 1,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "glm-5.2");
  assert.equal(body.choices?.[0]?.message?.role, "assistant");
  assert.equal(body.choices?.[0]?.message?.content, "fake zcode response");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
});

test("ZCode buffers the completed turn into OpenAI SSE when stream=true", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    pollIntervalMs: 1,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: true,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(text, /fake zcode response/);
  assert.match(text, /data: \[DONE\]/);
});
