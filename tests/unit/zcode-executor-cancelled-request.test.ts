/**
 * ZCode attempt-level cancellation must stay a plain upstream failure status
 * (never 499) and must be tagged request-scoped, so the combo does not lock the
 * model out or cool the provider down for an attempt the ZCode server itself
 * dropped while the provider kept serving other requests.
 *
 * The cancellation is matched NARROWLY: the ZCode server's own structured code
 * (`model_request_cancelled`) or its exact sentence. Every other wording that
 * merely mentions "cancel" — including the transport-level "Request was
 * cancelled." DOMException and the protocol's own "ZCode RPC request canceled" —
 * keeps today's behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zcode-cancelled-"));
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

const CANCELLED_MESSAGE = "Model request was cancelled.";
const CANCELLED_CODE = "upstream_request_cancelled";
const NATIVE_QUOTA_MESSAGE =
  "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-24 02:06:22][20261023051631bc36141006ea4bd9]";

/**
 * Native app-server client stub. `generateWorkspaceText` rejects with the
 * given error; every other native call succeeds.
 */
function stubClient(turnError: unknown, providerId = "account:zai-individual-coding-plan") {
  return () => ({
    async start() {},
    async close() {},
    async call(_channel: string, method: string) {
      if (method === "generateWorkspaceText") throw turnError;
      if (method === "initialize") return { available: true };
      if (method === "getView") {
        return {
          providers: [
            {
              providerId,
              models: [{ modelId: "GLM-5.3-Flash", config: { enabled: true } }],
            },
          ],
        };
      }
      assert.fail(`unexpected native call ${method}`);
    },
  });
}

async function runTurn(turnError: unknown, providerId?: string) {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    clientFactory: stubClient(turnError, providerId),
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

test("ZCode cancelled model request stays 502 and is tagged request-scoped", async () => {
  const { response, body } = await runTurn(new Error(CANCELLED_MESSAGE));
  assert.notEqual(response.status, 499, "a cancelled attempt must never stop the combo loop");
  assert.equal(response.status, 502, "the combo must be able to fall through to the next leg");
  assert.equal(body.error.code, CANCELLED_CODE);
  assert.equal(body.error.type, CANCELLED_CODE);
  assert.ok(body.error.message.includes(CANCELLED_MESSAGE));
});

test("ZCode structured model_request_cancelled code is tagged request-scoped", async () => {
  const { response, body } = await runTurn(
    Object.assign(new Error("native turn aborted"), { code: "model_request_cancelled" })
  );
  assert.equal(response.status, 502);
  assert.equal(body.error.code, CANCELLED_CODE);
});

test("ZCode structured model_request_cancelled code in the error data is tagged request-scoped", async () => {
  const { response, body } = await runTurn(
    Object.assign(new Error("native turn aborted"), {
      data: { code: "model_request_cancelled", message: CANCELLED_MESSAGE },
    })
  );
  assert.equal(response.status, 502);
  assert.equal(body.error.code, CANCELLED_CODE);
});

test("ZCode quota refusal stays a typed 429 and is not a cancellation", async () => {
  const { response, body } = await runTurn(new Error(NATIVE_QUOTA_MESSAGE));
  assert.equal(response.status, 429);
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(body.error.code, "insufficient_quota");
  assert.equal(body.error.reason, "quota_exhausted");
  assert.notEqual(body.error.code, CANCELLED_CODE);
});

for (const message of [
  // The ZCode server's transport-level abort (fetch DOMException) — NOT the
  // model-request cancellation.
  "Request was cancelled.",
  // The ZCode app-server cancelling the RPC itself.
  "ZCode RPC request canceled",
  // A genuine failure that merely mentions cancellation in another sense.
  "upstream cancelled the stream after 200 OK",
]) {
  test(`ZCode near-miss wording is not a cancellation: ${message}`, async () => {
    const { response, body } = await runTurn(new Error(message));
    assert.equal(response.status, 502);
    assert.notEqual(body.error.code, CANCELLED_CODE);
  });
}

test("ZCode generic native failure stays a plain 502", async () => {
  const { response, body } = await runTurn(new Error("ZCode Protocol runtime stopping"));
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "bad_gateway");
  assert.notEqual(body.error.code, CANCELLED_CODE);
});

test("the cancellation matcher accepts only the model-request cancellation", async () => {
  const { isZcodeRequestCancelled } = await loadZcodeExecutor();

  assert.equal(isZcodeRequestCancelled(new Error(CANCELLED_MESSAGE)), true);
  assert.equal(
    isZcodeRequestCancelled(
      Object.assign(new Error("aborted"), { code: "model_request_cancelled" })
    ),
    true
  );
  assert.equal(
    isZcodeRequestCancelled(
      Object.assign(new Error("aborted"), { data: { code: "MODEL_REQUEST_CANCELLED" } })
    ),
    true
  );

  // Near misses: the transport-level abort, the protocol-level cancel, a
  // genuine failure that mentions cancellation, and a quota refusal.
  assert.equal(isZcodeRequestCancelled(new Error("Request was cancelled.")), false);
  assert.equal(isZcodeRequestCancelled(new Error("ZCode RPC request canceled")), false);
  assert.equal(
    isZcodeRequestCancelled(new Error("upstream cancelled the stream after 200 OK")),
    false
  );
  assert.equal(isZcodeRequestCancelled(new Error(NATIVE_QUOTA_MESSAGE)), false);
  assert.equal(isZcodeRequestCancelled(new Error("ZCode Protocol runtime stopping")), false);
});
