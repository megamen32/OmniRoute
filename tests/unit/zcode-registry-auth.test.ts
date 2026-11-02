import test from "node:test";
import assert from "node:assert/strict";
import {
  zcodeStartProvider,
  zcodeIndividualProvider,
} from "../../open-sse/config/providers/registry/zcode/index.ts";
test("both native plan providers retain their identity and OAuth contract", () => {
  for (const [entry, id] of [
    [zcodeStartProvider, "zcode-start"],
    [zcodeIndividualProvider, "zcode-individual"],
  ] as const) {
    assert.equal(entry.id, id);
    assert.equal(entry.executor, id);
    assert.equal(entry.authType, "oauth");
    assert.equal(entry.authHeader, "none");
    assert.ok(entry.models.length > 0);
  }
});
