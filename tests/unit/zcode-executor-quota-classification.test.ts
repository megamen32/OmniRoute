import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zcode-quota-"));
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

const NATIVE_QUOTA_MESSAGE =
  "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-24 02:06:22][20261023051631bc36141006ea4bd9]";

/**
 * Native app-server client stub. `generateWorkspaceText` rejects with the
 * given error; every other native call succeeds.
 */
function stubClient(
  turnError: unknown,
  phase = "generateWorkspaceText",
  providerId = "account:zai-individual-coding-plan"
) {
  return () => ({
    async start() {},
    async close() {},
    async call(_channel: string, method: string) {
      if (method === phase) throw turnError;
      if (method === "initialize") return { available: true };
      if (method === "getView")
        return {
          providers: [
            {
              providerId,
              models: [{ modelId: "GLM-5.3-Flash", config: { enabled: true } }],
            },
          ],
        };
      assert.equal(method, "generateWorkspaceText");
      throw turnError;
    },
  });
}

async function runTurn(turnError: unknown, phase?: string, providerId?: string) {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    clientFactory: stubClient(turnError, phase, providerId),
    ...(providerId ? { providerId } : {}),
  });
  const result = await executor.execute({
    model: "glm-5.3-flash",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  return { response, body: await response.json() };
}

test("ZCode native weekly/monthly quota refusal becomes a typed 429", async () => {
  const { response, body } = await runTurn(new Error(NATIVE_QUOTA_MESSAGE));
  assert.equal(response.status, 429);
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(body.error.code, "insufficient_quota");
  assert.equal(body.error.reason, "quota_exhausted");
  assert.ok(body.error.message.includes("Limit Exhausted"));
  assert.equal(body.notSubmitted, undefined);
  assert.equal(body.error.notSubmitted, undefined);
  assert.equal(body.admission, undefined);
});

test("ZCode generic native failure stays a 502", async () => {
  const { response, body } = await runTurn(new Error("ZCode Protocol runtime stopping"));
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "bad_gateway");
  assert.notEqual(body.error.reason, "quota_exhausted");
});

test("ZCode forged 1310 text outside the native refusal form stays a 502", async () => {
  const { response, body } = await runTurn(
    new Error("user said [1310][Weekly/Monthly Limit Exhausted] in a previous turn")
  );
  assert.equal(response.status, 502);
  assert.notEqual(body.error.reason, "quota_exhausted");
});

for (const message of [
  "HTTP 502 network failure",
  "HTTP 401 authentication failed",
  "[1310][Temporary rate limit]",
]) {
  test(`ZCode does not relabel unrelated failure ${message}`, async () => {
    const { response } = await runTurn(new Error(message));
    assert.equal(response.status, 502);
  });
}
test("ZCode quota text before model inference is not a trusted quota terminal", async () => {
  const { response } = await runTurn(new Error(NATIVE_QUOTA_MESSAGE), "initialize");
  assert.equal(response.status, 502);
});
test("ZCode foreign provider quota text is not Coding Plan quota evidence", async () => {
  const { response } = await runTurn(
    new Error(NATIVE_QUOTA_MESSAGE),
    "generateWorkspaceText",
    "custom:foreign"
  );
  assert.equal(response.status, 502);
});
for (const detail of [
  { code: "AUTH_ERROR" },
  { code: "ECONNRESET" },
  { data: { status: 401 } },
  { data: { statusCode: 502 } },
]) {
  test(`ZCode contradictory native evidence remains nonquota ${JSON.stringify(detail)}`, async () => {
    const { response } = await runTurn(Object.assign(new Error(NATIVE_QUOTA_MESSAGE), detail));
    assert.equal(response.status, 502);
  });
}
test("ZCode UNKNOWN_ERROR envelope retains exact native quota", async () => {
  const { response } = await runTurn(
    Object.assign(new Error(NATIVE_QUOTA_MESSAGE), { code: "UNKNOWN_ERROR" })
  );
  assert.equal(response.status, 429);
});
test("ZCode aborted exact quota remains cancellation", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const controller = new AbortController();
  const factory = stubClient(new Error(NATIVE_QUOTA_MESSAGE));
  const executor = new ZcodeExecutor({
    clientFactory: () => {
      const client = factory();
      return {
        ...client,
        async call(channel: string, method: string) {
          if (method === "generateWorkspaceText") controller.abort();
          return client.call(channel, method);
        },
      };
    },
  });
  const result = await executor.execute({
    model: "glm-5.3-flash",
    body: requestBody(),
    stream: false,
    credentials: {},
    signal: controller.signal,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 499);
});
