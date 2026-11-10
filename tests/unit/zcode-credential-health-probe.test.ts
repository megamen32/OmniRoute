import test from "node:test";
import assert from "node:assert/strict";

import {
  isNativeZcodeProvider,
  NATIVE_ZCODE_PROVIDER_IDS,
  testOAuthConnection,
} from "../../src/app/api/providers/[id]/test/route.ts";

test("native ZCode profiles skip the generic OAuth credential probe", async () => {
  assert.deepEqual(
    [...NATIVE_ZCODE_PROVIDER_IDS],
    ["zcode", "zcode-start", "zcode-individual", "zcode-cn-start", "zcode-cn-individual"]
  );
  assert.equal(isNativeZcodeProvider("zcode-cn-individual"), true);
  assert.equal(isNativeZcodeProvider("glm"), false);

  const result = await testOAuthConnection({
    provider: "zcode-cn-individual",
    accessToken: "oauth-token",
  });
  assert.equal(result.valid, false);
  assert.equal(result.skipped, true);
  assert.equal(result.error, "Provider test not supported");
  assert.equal(result.diagnosis?.code, "unsupported");
});
