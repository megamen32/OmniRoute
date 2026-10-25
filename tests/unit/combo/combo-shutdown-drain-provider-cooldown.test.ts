/**
 * A graceful shutdown must not poison provider-level resilience state either.
 *
 * Live incident (server-100 router, 2026-10-25): our own SIGTERM tore provider
 * clients down while requests were still in flight. The resulting 502 was
 * recorded as an upstream error, and it opened the whole-provider circuit
 * breaker AND recorded a provider cooldown — so every later request skipped a
 * healthy provider. With the MiniMax managed gateway as the transport, a
 * gateway call that dies during a restart is exactly such a 502.
 *
 * Both provider-level records live in `executeTargetAttempt.ts`:
 *   - the provider circuit breaker (`recordProviderFailure`)
 *   - the provider cooldown tracker (`recordProviderCooldown`)
 * Both are now gated on the shared shutdown-drain seam, so a failure raised by
 * our own shutdown is never recorded as provider evidence.
 *
 * The drain flag is driven directly through `globalThis.__omnirouteShutdown` —
 * the state `isDraining()` reads — instead of sending real signals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTempDataDir } from "../../_setup/tempDataDir.ts";

// Both knobs are read at module load, so they must be set before the imports
// below. The provider cooldown tracker is opt-in (default OFF), and the
// provider-level cooldown needs N failures inside the window before the
// provider actually cools down (default 15 for API-key providers).
process.env.PROVIDER_COOLDOWN_ENABLED = "true";
process.env.OMNIROUTE_PROVIDER_BREAKER_API_KEY_FAILURE_THRESHOLD = "2";

const { cleanup } = createTempDataDir("omniroute-combo-drain-provider-cooldown-");
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-drain-provider-cooldown-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { getProviderBreakerState } = await import("../../../open-sse/services/accountFallback.ts");
const { isProviderInCooldown, getCooldownEntryCount, clearCooldownState } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

const FAILING_PROVIDER = "openai";

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
 * Run a combo whose first target fails with a 502. The second target succeeds,
 * so the combo itself is a success and only the provider-level records differ.
 */
async function runComboWithFailingFirstTarget() {
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ping" }] },
    combo: {
      name: "shutdown-drain-provider-cooldown",
      strategy: "priority",
      models: ["openai/gpt-4o-mini", "anthropic/claude-3-5-haiku"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        targetTimeoutMs: 60_000,
      },
    },
    handleSingleModel: async (_b: Body, modelStr: string) => {
      if (modelStr === "openai/gpt-4o-mini") return upstreamBadGatewayResponse();
      return okResponse("recovered-after-upstream-502");
    },
    isModelAvailable: async () => true,
    log,
    // settings: null keeps the model lockout disabled (its default) so this
    // file asserts the PROVIDER-level records only — the model lockout has its
    // own file (combo-shutdown-drain-model-lockout.test.ts).
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200, "the combo must still fall over to the second target");
}

function providerBreakerFailures(): number {
  return getProviderBreakerState(FAILING_PROVIDER)?.failureCount ?? 0;
}

function providerIsCoolingDown(): boolean {
  return isProviderInCooldown(FAILING_PROVIDER, undefined);
}

test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
  setDraining(false);
});

test.after(async () => {
  resetAllCircuitBreakers();
  clearCooldownState();
  delete globalThis.__omnirouteShutdown;
  await cleanup();
});

test("provider records: a 502 during shutdown drain opens neither the circuit nor the cooldown", async () => {
  setDraining(true);
  await runComboWithFailingFirstTarget();
  await runComboWithFailingFirstTarget();

  assert.equal(
    providerBreakerFailures(),
    0,
    "a self-inflicted shutdown failure must not open the provider circuit breaker"
  );
  assert.equal(
    getCooldownEntryCount(),
    0,
    "a self-inflicted shutdown failure must not record a provider cooldown"
  );
  assert.equal(
    providerIsCoolingDown(),
    false,
    "the provider must not be in cooldown after a shutdown-induced failure"
  );
});

test("provider records: the same 502 outside a drain opens the circuit and records the cooldown", async () => {
  setDraining(false);
  await runComboWithFailingFirstTarget();
  await runComboWithFailingFirstTarget();

  assert.ok(
    providerBreakerFailures() >= 1,
    "a genuine upstream 502 must still record a provider breaker failure"
  );
  assert.ok(
    getCooldownEntryCount() >= 1,
    "a genuine upstream 502 must still record a provider cooldown entry"
  );
  assert.equal(
    providerIsCoolingDown(),
    true,
    "a genuine upstream 502 must still cool the provider down"
  );
});

test("provider records: the drain verdict is not latched — both records work again once draining ends", async () => {
  setDraining(true);
  await runComboWithFailingFirstTarget();
  assert.equal(providerBreakerFailures(), 0, "nothing may be recorded while draining");
  assert.equal(getCooldownEntryCount(), 0, "no cooldown entry while draining");

  // The drain flag went back off (the seam reads the flag live, never latched).
  resetAllCircuitBreakers();
  clearCooldownState();
  setDraining(false);
  await runComboWithFailingFirstTarget();
  await runComboWithFailingFirstTarget();

  assert.ok(
    providerBreakerFailures() >= 1,
    "draining must not disable the provider breaker for the whole process lifetime"
  );
  assert.ok(
    getCooldownEntryCount() >= 1,
    "draining must not disable the provider cooldown for the whole process lifetime"
  );
  assert.equal(providerIsCoolingDown(), true, "the provider must cool down again after the drain");
});
