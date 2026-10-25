/**
 * A graceful shutdown must not poison the model lockout.
 *
 * Live incident (server-100 router, 2026-10-25): our own SIGTERM disposed the
 * ZCode protocol client while three requests were still in flight. The failure
 * surfaced as a 502 upstream error, and 502 is in the model-lockout error-code
 * list — so the model was locked out of every combo for minutes even though it
 * was healthy the whole time.
 *
 * Both model-lockout recording sites in the combo layer gate on
 * `shouldRecordModelLockoutForComboFailure`. While the instance is draining,
 * that predicate must answer `false` for every status: a failure observed
 * during our own shutdown is evidence about the shutdown, not about the model.
 *
 * The drain flag is driven directly through `globalThis.__omnirouteShutdown` —
 * the state `isDraining()` reads — instead of sending real signals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTempDataDir } from "../../_setup/tempDataDir.ts";

const { cleanup } = createTempDataDir("omniroute-combo-drain-lockout-");
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-drain-lockout-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { clearAllModelLockouts, isModelLocked } =
  await import("../../../open-sse/services/accountFallback.ts");
const { shouldRecordModelLockoutForComboFailure } =
  await import("../../../open-sse/services/combo/comboPredicates.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

/** Model lockout is disabled by default — the operator turns it on explicitly. */
const MODEL_LOCKOUT_SETTINGS = {
  modelLockout: {
    enabled: true,
    errorCodes: [403, 404, 429, 502, 503, 504],
    baseCooldownMs: 120_000,
    maxCooldownMs: 1_800_000,
    useExponentialBackoff: false,
  },
};

function upstreamBadGatewayResponse() {
  return new Response(
    JSON.stringify({
      error: { message: "Bad Gateway", type: "server_error", code: "bad_gateway" },
    }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  );
}

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The exact shape `isDraining()` reads (src/lib/gracefulShutdown.ts). */
function setDraining(shuttingDown: boolean) {
  globalThis.__omnirouteShutdown = { init: false, shuttingDown, activeRequests: 0 };
}

/**
 * Run a two-target combo whose first target fails with a 502. Returns whether
 * the first model ended up locked out.
 */
async function runComboWithFailingFirstTarget() {
  let observed: { provider: string; connectionId: string; model: string } | null = null;

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ping" }] },
    combo: {
      name: "shutdown-drain-lockout",
      strategy: "priority",
      models: ["openai/gpt-4o-mini", "anthropic/claude-3-5-haiku"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        targetTimeoutMs: 60_000,
      },
    },
    handleSingleModel: async (_b: Body, modelStr: string, target) => {
      if (modelStr === "openai/gpt-4o-mini") {
        const provider = (target as { provider?: string } | undefined)?.provider ?? "openai";
        const connectionId = (target as { connectionId?: string } | undefined)?.connectionId ?? "";
        observed = { provider, connectionId, model: "gpt-4o-mini" };
        return upstreamBadGatewayResponse();
      }
      return okResponse("recovered-after-upstream-502");
    },
    isModelAvailable: async () => true,
    log,
    settings: MODEL_LOCKOUT_SETTINGS,
    allCombos: null,
  });

  assert.equal(res.status, 200, "the combo must still fall over to the second target");
  assert.ok(observed, "the failing target must have been dispatched");
  return observed;
}

test.beforeEach(() => {
  clearAllModelLockouts();
  setDraining(false);
});

test.after(async () => {
  clearAllModelLockouts();
  delete globalThis.__omnirouteShutdown;
  await cleanup();
});

test("combo: a 502 during shutdown drain does NOT record a model lockout", async () => {
  setDraining(true);
  const { provider, connectionId, model } = await runComboWithFailingFirstTarget();
  assert.equal(
    isModelLocked(provider, connectionId, model),
    false,
    "a self-inflicted shutdown failure must not lock the model out of every later combo"
  );
});

test("combo: the same 502 outside a drain still records the model lockout", async () => {
  setDraining(false);
  const { provider, connectionId, model } = await runComboWithFailingFirstTarget();
  assert.equal(
    isModelLocked(provider, connectionId, model),
    true,
    "a genuine upstream 502 must keep locking the model out"
  );
});

test("combo: the drain verdict is not latched — the lockout works again once draining ends", async () => {
  setDraining(true);
  const duringDrain = await runComboWithFailingFirstTarget();
  assert.equal(
    isModelLocked(duringDrain.provider, duringDrain.connectionId, duringDrain.model),
    false
  );

  clearAllModelLockouts();
  setDraining(false);
  const afterDrain = await runComboWithFailingFirstTarget();
  assert.equal(
    isModelLocked(afterDrain.provider, afterDrain.connectionId, afterDrain.model),
    true,
    "draining must not disable the model lockout for the whole process lifetime"
  );
});

test("combo: the lockout predicate itself refuses every status while draining", () => {
  setDraining(true);
  for (const requestScopedFailure of [false, true]) {
    assert.equal(
      shouldRecordModelLockoutForComboFailure(requestScopedFailure, {
        code: "bad_gateway",
        type: "server_error",
      }),
      false,
      "no failure may be recorded as a model lockout while draining"
    );
    assert.equal(
      shouldRecordModelLockoutForComboFailure(requestScopedFailure, {
        code: "combo_target_timeout",
        type: "combo_target_timeout",
      }),
      false,
      "not even a locally timed-out model may be locked out while draining"
    );
  }

  setDraining(false);
  assert.equal(
    shouldRecordModelLockoutForComboFailure(false, { code: "bad_gateway", type: "server_error" }),
    true,
    "outside a drain an upstream 502 is still lockout-worthy"
  );
});
