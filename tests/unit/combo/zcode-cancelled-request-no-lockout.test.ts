/**
 * A cancelled upstream attempt must not lock the model out or cool the provider
 * down — it is a property of ONE attempt, not of the model and not of the
 * provider (the ZCode server keeps serving other requests in parallel).
 *
 * The decision seam is the same composition handleComboChat uses:
 *   isComboRequestScopedFailure → shouldRecordProviderBreakerFailure(requestScopedFailure)
 *   → shouldRecordModelLockoutForComboFailure(requestScopedFailure)
 *   → recordProviderCooldown(!requestScopedFailure)
 * The orchestration is exercised through the public handleComboChat with an
 * injected handleSingleModel (not private mocks), so the assertions cover the
 * real failover path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "../../../open-sse/services/combo/attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-zcode-cancelled-combo-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "zcode-cancelled-combo-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const {
  clearAllModelLockouts,
  clearProviderFailure,
  getModelLockoutInfo,
  getProviderBreakerState,
} = await import("../../../open-sse/services/accountFallback.ts");
const { clearCooldownState, isProviderInCooldown } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const { getCircuitBreaker, resetAllCircuitBreakers } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { connectionCircuitBreakerName } =
  await import("../../../open-sse/services/connectionCircuitBreaker.ts");
const { resolveProviderId } = await import("../../../src/shared/constants/providers.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

const PROVIDER = "zcode";
const BREAKER_PROVIDER = resolveProviderId(PROVIDER);
const MODEL = "glm-5.3-flash";
const CONNECTION_ID = "conn-zcode-cancelled";
const CANCELLED_CODE = "upstream_request_cancelled";

const resilienceSettings = {
  providerCooldown: {
    enabled: true,
    minRetryCooldownMs: 5_000,
    maxRetryCooldownMs: 300_000,
  },
} as unknown as Parameters<typeof isProviderInCooldown>[2];

const settings = {
  modelLockout: {
    enabled: true,
    errorCodes: [502],
    baseCooldownMs: 60_000,
    maxCooldownMs: 120_000,
  },
  resilienceSettings,
};

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The ZCode app-server's attempt-level cancellation, as the executor re-tags it. */
function cancelledResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Model request was cancelled.",
        type: CANCELLED_CODE,
        code: CANCELLED_CODE,
      },
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "x-omniroute-selected-connection-id": CONNECTION_ID,
      },
    }
  );
}

/** A genuine upstream 502 from the same provider — not a cancellation. */
function genuineFailureResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Upstream service returned an invalid response",
        type: "server_error",
        code: "bad_gateway",
      },
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "x-omniroute-selected-connection-id": CONNECTION_ID,
      },
    }
  );
}

/** A near-miss: mentions "cancel" but is not the model-request cancellation. */
function nearMissCancellationResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Request was cancelled.",
        type: "api_error",
        code: "bad_gateway",
      },
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "x-omniroute-selected-connection-id": CONNECTION_ID,
      },
    }
  );
}

async function runCombo(firstLeg: () => Response) {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ping" }] },
    combo: {
      name: "zcode-cancelled-failover",
      strategy: "priority",
      models: ["zcode/glm-5.3-flash", "openai/gpt-4o-mini"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        targetTimeoutMs: 60_000,
      },
    },
    handleSingleModel: async (_b: Body, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "zcode/glm-5.3-flash") return firstLeg();
      return okResponse("recovered-after-cancelled-attempt");
    },
    isModelAvailable: async () => true,
    log,
    settings,
    allCombos: null,
  });
  return { res, calls };
}

/**
 * A failure that carries a connection id is recorded against the
 * connection-scoped breaker (one connection's failures must not open the
 * breaker for every account of the provider).
 */
function providerBreakerFailureCount(): number {
  const name = connectionCircuitBreakerName(BREAKER_PROVIDER, CONNECTION_ID);
  return getCircuitBreaker(name).getStatus().failureCount;
}

test.beforeEach(() => {
  resetAllCircuitBreakers();
  // recordProviderFailure dedups rapid failures per provider:connection for 5s,
  // so the dedup entries must be cleared too — otherwise the second test that
  // expects a breaker failure would be silently deduped by the first one.
  clearProviderFailure(BREAKER_PROVIDER);
  clearCooldownState();
  clearAllModelLockouts();
});

test("cancelled attempt falls through to the next leg without answering 499", async () => {
  const { res, calls } = await runCombo(cancelledResponse);

  assert.deepEqual(calls, ["zcode/glm-5.3-flash", "openai/gpt-4o-mini"]);
  assert.equal(
    res.status,
    200,
    "the combo must continue to the next leg after a cancelled attempt"
  );
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0].message.content, "recovered-after-cancelled-attempt");
});

test("cancelled attempt records no model lockout", async () => {
  await runCombo(cancelledResponse);

  assert.equal(
    getModelLockoutInfo(PROVIDER, CONNECTION_ID, MODEL),
    null,
    "a cancelled attempt must not lock the model out of every combo"
  );
});

test("cancelled attempt records no provider breaker failure", async () => {
  await runCombo(cancelledResponse);

  assert.equal(
    providerBreakerFailureCount(),
    0,
    "a cancelled attempt must not trip the whole-provider circuit breaker"
  );
  assert.equal(
    getProviderBreakerState(BREAKER_PROVIDER)?.failureCount ?? 0,
    0,
    "a cancelled attempt must not trip the provider-level circuit breaker either"
  );
});

test("cancelled attempt records no provider cooldown", async () => {
  await runCombo(cancelledResponse);

  assert.equal(
    isProviderInCooldown(PROVIDER, CONNECTION_ID, resilienceSettings),
    false,
    "a cancelled attempt must not cool the provider down"
  );
});

test("genuine upstream 502 still records the model lockout and the provider breaker failure", async () => {
  const { res, calls } = await runCombo(genuineFailureResponse);

  assert.deepEqual(calls, ["zcode/glm-5.3-flash", "openai/gpt-4o-mini"]);
  assert.equal(res.status, 200, "a genuine failure still falls through to the next leg");

  const lockout = getModelLockoutInfo(PROVIDER, CONNECTION_ID, MODEL);
  assert.ok(lockout, "a genuine upstream 502 must keep locking the model out");
  assert.ok(lockout.remainingMs > 0);

  assert.ok(
    (providerBreakerFailureCount() ?? 0) >= 1,
    "a genuine upstream 502 must keep recording a provider breaker failure"
  );
});

test("near-miss cancellation wording keeps today's recording behaviour", async () => {
  await runCombo(nearMissCancellationResponse);

  assert.ok(
    getModelLockoutInfo(PROVIDER, CONNECTION_ID, MODEL),
    "a genuine failure mentioning 'cancelled' must still lock the model out"
  );
  assert.ok(
    providerBreakerFailureCount() >= 1,
    "a genuine failure mentioning 'cancelled' must still record a provider breaker failure"
  );
});

test("cancelled attempt does not poison the connection — a same-provider leg is still tried", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ping" }] },
    combo: {
      name: "zcode-cancelled-same-provider",
      strategy: "priority",
      models: ["zcode/glm-5.3-flash", "zcode/glm-5.2"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        targetTimeoutMs: 60_000,
      },
    },
    handleSingleModel: async (_b: Body, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "zcode/glm-5.3-flash") return cancelledResponse();
      return okResponse("recovered-after-cancelled-attempt");
    },
    isModelAvailable: async () => true,
    log,
    settings,
    allCombos: null,
  });

  assert.deepEqual(
    calls,
    ["zcode/glm-5.3-flash", "zcode/glm-5.2"],
    "a cancelled attempt must not mark the connection exhausted (#1731v2) — the next leg must run"
  );
  assert.equal(res.status, 200);
});

// ── Attempt-level: the #1731v2 same-connection skip ─────────────────────────

function attemptState(overrides: Partial<AttemptLoopState> = {}): AttemptLoopState {
  return {
    orderedTargets: [],
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map([[0, new AbortController()]]),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    requestScopedFailureSeen: false,
    observeFailure() {},
    ...overrides,
  };
}

function attemptDeps(overrides: Partial<AttemptLoopDeps> = {}): AttemptLoopDeps {
  return {
    strategy: "priority",
    combo: { id: "combo-zcode-cancelled", name: "t", models: [] },
    config: {},
    log: { info: noop, warn: noop, debug: noop, error: noop },
    settings: null,
    resilienceSettings: {
      providerCooldown: { enabled: true, minRetryCooldownMs: 5_000, maxRetryCooldownMs: 300_000 },
    } as AttemptLoopDeps["resilienceSettings"],
    sticky: { targets: [], messageHash: null, stuck: false },
    effectiveSessionId: null,
    preScreenMap: new Map(),
    quotaCutoffResetWindowConfig: {} as AttemptLoopDeps["quotaCutoffResetWindowConfig"],
    maxRetries: 0,
    traceInvocationId: "inv-zcode-cancelled",
    clientRequestedStream: false,
    handleSingleModelWithTimeout: async () => {
      throw new Error("handleSingleModel must be stubbed");
    },
    body: { messages: [{ role: "user", content: "hi" }] },
    startTime: Date.now(),
    releaseStickyPinOnFailure() {},
    clearStaleLKGP() {},
    ...overrides,
  };
}

function attemptTarget(overrides: Partial<ResolvedComboTarget> = {}): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: "s1",
    executionKey: "ek-1",
    modelStr: "zcode/glm-5.3-flash",
    provider: "zcode",
    providerId: null,
    connectionId: CONNECTION_ID,
    weight: 1,
    label: null,
    ...overrides,
  };
}

test("cancelled attempt does not mark the connection exhausted (#1731v2)", async () => {
  const { executeTargetAttempt } =
    await import("../../../open-sse/services/combo/executeTargetAttempt.ts");
  const first = attemptTarget();
  const second = attemptTarget({ executionKey: "ek-2", modelStr: "zcode/glm-5.2" });
  const state = attemptState({ orderedTargets: [first, second] });
  const deps = attemptDeps({
    handleSingleModelWithTimeout: async () => cancelledResponse(),
  });

  await executeTargetAttempt({
    index: 0,
    state,
    deps,
    targetForAttempt: first,
    profile: {},
    protectedPriorityTarget: false,
  });

  assert.equal(
    state.exhaustedConnections.size,
    0,
    "a cancelled attempt must not mark the provider:connection exhausted — the remaining same-connection legs would be skipped"
  );
  assert.equal(state.exhaustedProviders.size, 0);
});
