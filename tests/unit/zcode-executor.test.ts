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

test("ZCode uses native model inference and returns an OpenAI chat completion", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
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

test("ZCode buffers the model completion into OpenAI SSE when stream=true", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
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

test("ZCode forwards structured caller tools and tool results without native session execution", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
  });
  const tool = {
    type: "function",
    function: {
      name: "lookup",
      description: "Lookup status",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
  };
  const first = await executor.execute({
    model: "glm-5.3-flash",
    body: { messages: [{ role: "user", content: "Read bridge-check" }], tools: [tool] },
    stream: true,
    credentials: {},
  });
  const response = "response" in first ? first.response : first;
  const frames = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const call = frames[0].choices[0].delta.tool_calls[0];
  assert.equal(call.function.name, "lookup");
  assert.deepEqual(JSON.parse(call.function.arguments), { key: "bridge-check" });
  assert.equal(frames[1].choices[0].finish_reason, "tool_calls");
  assert.equal(frames[1].usage.prompt_tokens, 100);
  assert.equal(frames[1].usage.prompt_tokens_details.cached_tokens, 30);
  const second = await executor.execute({
    model: "glm-5.3-flash",
    body: {
      messages: [
        { role: "user", content: "Read bridge-check" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: call.id, type: "function", function: call.function }],
        },
        { role: "tool", tool_call_id: call.id, content: "the actual value" },
      ],
      tools: [tool],
    },
    stream: false,
    credentials: {},
  });
  const body = await ("response" in second ? second.response : second).json();
  assert.equal(body.choices[0].message.content, "tool result consumed");
  assert.equal(body.choices[0].finish_reason, "stop");
});

test("ZCode keeps model errors as HTTP errors rather than empty success streams", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  let closed = false;
  const executor = new ZcodeExecutor({
    clientFactory: () => ({
      async start() {},
      async close() {
        closed = true;
      },
      async call(_channel, method) {
        if (method === "initialize") return { available: true };
        if (method === "getView")
          return {
            providers: [
              {
                providerId: "account:zai-individual-coding-plan",
                models: [{ modelId: "GLM-5.3", config: {} }],
              },
            ],
          };
        throw Error("upstream refused this model request");
      },
    }),
  });
  const result = await executor.execute({
    model: "glm-5.3",
    body: requestBody(),
    stream: true,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /upstream refused/);
  assert.equal(closed, true);
});

test("ZCode rejects unsupported image content instead of silently discarding it", async () => {
  const { buildZcodeModelRequest } = await loadZcodeExecutor();
  assert.throws(
    () =>
      buildZcodeModelRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
          },
        ],
      }),
    /text input only/
  );
  assert.deepEqual(
    buildZcodeModelRequest({
      messages: [
        { role: "developer", content: "policy" },
        { role: "user", content: "question" },
      ],
      tools: [],
      max_tokens: 512,
    }),
    {
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "question" },
      ],
      tools: [],
      maxOutputTokens: 512,
    }
  );
});
