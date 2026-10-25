/**
 * A graceful shutdown must not poison the model lockout.
 *
 * Live incident (server-100 router, 2026-10-25): our own SIGTERM disposed the
 * ZCode protocol client while three requests were still in flight. The failure
 * surfaced as a 502 upstream error, and 502 is in the model-lockout error-code
 * list — so the model was locked out of every combo for minutes even though it
 * was healthy the whole time.
 *
 * The fix: while the instance is draining, the ZCode executor answers 499
 * (client_disconnected) instead of 502. 499 is in neither the model-lockout
 * error-code list nor the transient-retry list, so it can neither lock the
 * model out nor be retried as an upstream fault.
 *
 * The drain flag is driven directly through `globalThis.__omnirouteShutdown` —
 * the state `isDraining()` reads — instead of sending real signals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zcode-shutdown-drain-"));
process.env.DATA_DIR = TEST_DATA_DIR;

test.after(() => cleanupTempDataDir(TEST_DATA_DIR));

/** The exact shape `isDraining()` reads (src/lib/gracefulShutdown.ts). */
function setDraining(shuttingDown: boolean) {
  globalThis.__omnirouteShutdown = { init: false, shuttingDown, activeRequests: 0 };
}

test.beforeEach(() => setDraining(false));

test.after(() => {
  delete globalThis.__omnirouteShutdown;
});

async function loadZcodeExecutor() {
  return import("../../open-sse/executors/zcode.ts");
}

/**
 * Native app-server client stub. `generateWorkspaceText` rejects with the given
 * error — the shape of the live "ZCode Protocol client disposed" failure.
 */
function stubClient(turnError: unknown) {
  return () => ({
    async start() {},
    async close() {},
    async call(_channel: string, method: string) {
      if (method === "generateWorkspaceText") throw turnError;
      if (method === "initialize") return { available: true };
      if (method === "getView")
        return {
          providers: [
            {
              providerId: "account:zai-individual-coding-plan",
              models: [{ modelId: "GLM-5.3-Flash", config: { enabled: true } }],
            },
          ],
        };
      throw turnError;
    },
  });
}

async function runTurn(turnError: unknown) {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    clientFactory: stubClient(turnError),
    providerId: "account:zai-individual-coding-plan",
  });
  const result = await executor.execute({
    model: "glm-5.3-flash",
    body: {
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "Reply with a short status." },
      ],
    },
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  return { response, body: await response.json() };
}

const DISPOSED_CLIENT_ERROR = new Error("ZCode Protocol client disposed");

test("ZCode executor: a failure during shutdown drain is answered 499, not 502", async () => {
  setDraining(true);
  const { response, body } = await runTurn(DISPOSED_CLIENT_ERROR);
  assert.equal(response.status, 499, "a self-inflicted shutdown failure must not be a 502");
  assert.equal(
    body.error.type,
    "client_disconnected",
    "499 must carry the client-disconnected error type"
  );
  assert.equal(body.error.code, "client_disconnected");
});

test("ZCode executor: the same failure outside a drain is still 502", async () => {
  setDraining(false);
  const { response, body } = await runTurn(DISPOSED_CLIENT_ERROR);
  assert.equal(response.status, 502, "a genuine upstream failure must stay a 502");
  assert.equal(body.error.type, "server_error");
});

test("ZCode executor: the drain verdict is not latched — it follows the live flag", async () => {
  setDraining(true);
  const duringDrain = await runTurn(DISPOSED_CLIENT_ERROR);
  assert.equal(duringDrain.response.status, 499);

  // The drain flag went back off (flag read live, never latched).
  setDraining(false);
  const afterDrain = await runTurn(DISPOSED_CLIENT_ERROR);
  assert.equal(
    afterDrain.response.status,
    502,
    "a later failure must be classified as upstream again"
  );
});
