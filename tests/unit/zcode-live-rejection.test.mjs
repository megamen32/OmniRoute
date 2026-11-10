import assert from "node:assert/strict";
import test from "node:test";
import { wrapRouteRejection } from "../../scripts/ad-hoc/patch-zcode-rejection-live-20261110.mjs";

const blocked = "ZCode text-generation route blocked due to unusual activity";
const deps = {
  errorResponse: (status, message, extra) =>
    Response.json({ error: { message, ...extra } }, { status }),
};
test("live correction marks only our route-level 403 as a request failure", async () => {
  const wrapped = wrapRouteRejection(async () =>
    Response.json({ error: { message: blocked, code: "permission_denied" } }, { status: 403 })
  );
  const response = await wrapped(deps);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "upstream_response_failed");
  assert.equal(body.error.type, "upstream_response_failed");
});
test("live correction preserves the executor result wrapper and its context", async () => {
  const owner = { marker: "executor" },
    transformedBody = { messages: ["caller"] };
  const wrapped = wrapRouteRejection(async function () {
    assert.equal(this, owner);
    return {
      response: Response.json({ error: { message: blocked } }, { status: 403 }),
      transformedBody,
      transport: "local-zcode-model",
    };
  });
  const result = await wrapped.call(owner, deps);
  assert.equal(result.response.status, 502);
  assert.equal(result.transformedBody, transformedBody);
  assert.equal(result.transport, "local-zcode-model");
});
test("live correction preserves genuine provider authorization denials", async () => {
  const original = Response.json(
    { error: { message: "Provider account is disabled" } },
    { status: 403 }
  );
  assert.equal(await wrapRouteRejection(async () => original)(deps), original);
  assert.equal((await original.json()).error.message, "Provider account is disabled");
});
test("live correction leaves successful output and genuine quota untouched", async () => {
  for (const status of [200, 429, 502]) {
    const original = Response.json({ content: "unchanged" }, { status });
    assert.equal(await wrapRouteRejection(async () => original)(deps), original);
    assert.deepEqual(await original.json(), { content: "unchanged" });
  }
});
