import test from "node:test";
import assert from "node:assert/strict";
import { shouldTripProviderBreakerForResult } from "../../src/sse/handlers/chatPredicates.ts";
import {
  isProviderCircuitOpenResult,
  shouldRecordProviderBreakerFailure,
} from "../../open-sse/services/combo/comboPredicates.ts";

test("local circuit 503 after the admission gate cannot count as upstream failure", () => {
  const local = new Response(JSON.stringify({ error: { code: "provider_circuit_open" } }), {
    status: 503,
    headers: { "x-omniroute-provider-breaker": "open" },
  });
  assert.equal(
    shouldTripProviderBreakerForResult({ status: 503, response: local }, false, false),
    false
  );
  assert.equal(
    shouldTripProviderBreakerForResult(
      { status: 503, errorCode: "provider_circuit_open" },
      false,
      false
    ),
    false
  );
  const protectedPrioritySkip = new Response(
    JSON.stringify({ error: { message: "Provider zcode-start circuit breaker is open" } }),
    { status: 503, headers: { "x-omniroute-provider-breaker": "open" } }
  );
  assert.equal(
    shouldTripProviderBreakerForResult(
      { status: 503, response: protectedPrioritySkip },
      false,
      false
    ),
    false
  );
  assert.equal(
    isProviderCircuitOpenResult({}, "Provider zcode-start circuit breaker is open"),
    true
  );
  assert.equal(
    shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: 503,
      sameProviderNext: false,
      providerCircuitOpen: isProviderCircuitOpenResult(
        {},
        "Provider zcode-start circuit breaker is open"
      ),
    }),
    false
  );
  assert.equal(
    shouldTripProviderBreakerForResult(
      { status: 503, errorCode: "proxy_unreachable" },
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldTripProviderBreakerForResult(
      { status: 503, response: new Response("upstream", { status: 503 }) },
      false,
      false
    ),
    true
  );
});
