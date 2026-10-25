/**
 * The round-robin combo strategy keeps its OWN provider-cooldown record.
 *
 * Live incident (server-100 router, 2026-10-25): our own SIGTERM tore the
 * provider clients down while requests were still in flight. The resulting
 * failure was recorded as provider evidence, and every later request skipped a
 * healthy provider.
 *
 * The round-robin dispatcher does not run through `executeTargetAttempt.ts` —
 * it has its own iteration loop (`open-sse/services/combo/roundRobinCombo.ts`)
 * with its own `recordProviderCooldown(...)` call. Gating the copy in
 * `executeTargetAttempt.ts` therefore left the round-robin path still cooling
 * the provider down for a failure that our own shutdown caused.
 *
 * The drain flag is driven directly through `globalThis.__omnirouteShutdown` —
 * the state `isDraining()` reads — instead of sending real signals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTempDataDir } from "../../_setup/tempDataDir.ts";

// The provider cooldown tracker is opt-in (default OFF) and the flag is read
// at module load, so it must be set before the imports below.
process.env.PROVIDER_COOLDOWN_ENABLED = "true";

const { cleanup } = createTempDataDir("omniroute-combo-drain-rr-cooldown-");
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-drain-rr-cooldown-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { getCooldownEntryCount, clearCooldownState } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

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
 * Run a ROUND-ROBIN combo whose first attempted target fails with a 502. The
 * second target succeeds, so the combo itself is a success and only the
 * provider-level cooldown differs.
 *
 * The round-robin dispatcher rotates its start index between turns, so the
 * failing target is chosen by call order instead of by model name — the
 * assertion is about the provider-level record, not about one target.
 */
async function runRoundRobinComboWithFailingFirstTarget(comboName: string) {
  let calls = 0;
  const combo = {
    name: comboName,
    strategy: "round-robin",
    config: {
      maxRetries: 0,
      retryDelayMs: 0,
      fallbackDelayMs: 0,
      targetTimeoutMs: 60_000,
    },
    models: [
      {
        kind: "model",
        provider: "codex",
        providerId: "codex",
        model: "m-a",
        connectionId: "conn-A",
        id: `${comboName}-0`,
      },
      {
        kind: "model",
        provider: "glm-cn",
        providerId: "glm-cn",
        model: "m-b",
        connectionId: "conn-B",
        id: `${comboName}-1`,
      },
    ],
  };
  const res = await handleComboChat({
    body: { model: comboName, messages: [{ role: "user", content: "ping" }], stream: false },
    combo,
    handleSingleModel: async (_b: Body, _modelStr: string) => {
      calls += 1;
      if (calls === 1) return upstreamBadGatewayResponse();
      return okResponse("recovered-after-upstream-502");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: [combo],
  });
  assert.equal(res.status, 200, "the combo must still fall over to the second target");
  assert.equal(calls, 2, "the second target must have been tried");
}

test.beforeEach(() => {
  clearCooldownState();
  setDraining(false);
});

test.after(async () => {
  clearCooldownState();
  delete globalThis.__omnirouteShutdown;
  await cleanup();
});

test("round-robin: a 502 during shutdown drain records no provider cooldown", async () => {
  setDraining(true);
  await runRoundRobinComboWithFailingFirstTarget("rr-drain-no-cooldown");

  assert.equal(
    getCooldownEntryCount(),
    0,
    "a self-inflicted shutdown failure must not record a provider cooldown in the round-robin path"
  );
});

test("round-robin: the same 502 outside a drain records the provider cooldown", async () => {
  setDraining(false);
  await runRoundRobinComboWithFailingFirstTarget("rr-no-drain-cooldown");

  assert.ok(
    getCooldownEntryCount() >= 1,
    "a genuine upstream 502 must still record a provider cooldown entry"
  );
});

test("round-robin: the drain verdict is not latched — the cooldown works again once draining ends", async () => {
  setDraining(true);
  await runRoundRobinComboWithFailingFirstTarget("rr-drain-then-live");
  assert.equal(getCooldownEntryCount(), 0, "nothing may be recorded while draining");

  clearCooldownState();
  setDraining(false);
  await runRoundRobinComboWithFailingFirstTarget("rr-drain-then-live");

  assert.ok(
    getCooldownEntryCount() >= 1,
    "draining must not disable the provider cooldown for the whole process lifetime"
  );
});
