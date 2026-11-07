import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, hkdfSync } from "node:crypto";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

// Handoff 05-astra-plan.md, step 3 HTTP acceptance: after an Individual 429
// on the shared OAuth connection, a Start request on the SAME connection must
// still reach the upstream exactly once, and the model-locked Individual
// retry must not reach it at all. The old behavior wrote a connection-wide
// cooldown, which blocked Start before its own model lock was consulted.
// Fully offline: every upstream call is served by this mock (no external
// transport), mirroring tests/integration/zcode-oauth-http.test.ts.

process.env.ZCODE_TRANSPORT = "gateway";
process.env.STORAGE_ENCRYPTION_KEY = "test-only-zcode-tariff-isolation-key";
const harness = await createChatPipelineHarness("zcode-tariff-isolation-http");
const db = await import("../../src/lib/db/providers.ts");
const route = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  await harness.cleanup();
});

const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "fixture-key" })}.sig`;
const { privateKey } = generateKeyPairSync("ed25519");
const secret = Buffer.from(
  hkdfSync(
    "sha256",
    Buffer.from(token),
    Buffer.from("WD_CLIENT_SIGN_KDF_SALT"),
    Buffer.from("ed25519_priv"),
    32
  )
);
const iv = Buffer.alloc(12, 2);
const cipher = createCipheriv("aes-256-gcm", secret, iv);
cipher.setAAD(Buffer.from("fixture-key"));
const encrypted = Buffer.concat([
  iv,
  cipher.update(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")),
  cipher.final(),
  cipher.getAuthTag(),
]).toString("base64");

test("Start reaches the upstream after an Individual 429; the locked Individual retry does not", async () => {
  const account = await db.createProviderConnection({
    provider: "zcode",
    authType: "oauth",
    name: "tariff isolation fixture",
    accessToken: "individual-business",
    idToken: "jwt-start-fixture",
    providerSpecificData: { family: "zai", userId: "fixture" },
  });

  let individualInferenceCalls = 0;
  let startUpstreamCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/anthropic/v1/messages")) {
      // Individual (signed gateway) inference: fail with the 1310 quota text.
      individualInferenceCalls += 1;
      return Response.json(
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            code: "1310",
            message: "1310 Weekly/Monthly Limit Exhausted",
          },
        },
        { status: 429 }
      );
    }
    if (url.includes("/api/v1/zcode-plan/anthropic/v1/messages")) {
      // Start (Z-code plan gateway) inference: a complete Anthropic response
      // body (the request is stream:false — mirror zcode-oauth-http.test.ts).
      startUpstreamCalls += 1;
      return Response.json({
        id: "msg-start",
        type: "message",
        role: "assistant",
        model: "GLM-5.3-Flash",
        content: [{ type: "text", text: "start tariff text" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    }
    if (url.endsWith("/api/auth/z/login"))
      return Response.json({ code: 200, data: { access_token: "business", expires_in: 600 } });
    if (url.endsWith("getCustomerInfo"))
      return Response.json({
        code: 200,
        data: { organizations: [{ organizationId: "o", projects: [{ projectId: "p" }] }] },
      });
    if (url.endsWith("/api_keys"))
      return Response.json({ code: 200, data: [{ name: "zcode-api-key", apiKey: "k" }] });
    if (url.endsWith("/access_tokens"))
      return Response.json({
        code: 200,
        data: {
          accessToken: token,
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        },
      });
    if (url.endsWith("/api/paas/c1f3a7e2/v2/client"))
      return Response.json({ code: 200, data: { privateCipher: encrypted } });
    throw Error("unexpected endpoint: " + url);
  };

  // 1) Individual on the shared OAuth connection fails with 429/1310.
  const individualResponse = await route.POST(
    harness.buildRequest({
      headers: { "x-omniroute-connection": account.id },
      body: {
        model: "zc-individual/glm-5.3-flash",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  );
  assert.ok(individualResponse.status >= 400, "the Individual request surfaces its 429");
  assert.equal(
    individualInferenceCalls,
    1,
    "Individual reached the inference upstream exactly once"
  );

  // The shared OAuth connection stays active — no connection-wide cooldown.
  const row = await db.getProviderConnectionById(account.id);
  assert.ok(row, "connection row exists");
  // The connection view omits absent fields: testStatus/rateLimitedUntil must
  // be absent (no connection-wide cooldown), and the tariff-scoped light
  // update must be present.
  const r = row as {
    testStatus?: string;
    test_status?: string;
    rateLimitedUntil?: string | null;
    rate_limited_until?: string | null;
    lastErrorType?: string;
  };
  const status = r.testStatus ?? r.test_status;
  assert.notEqual(status, "unavailable", "no connection-wide unavailable state");
  assert.equal(r.rateLimitedUntil ?? r.rate_limited_until ?? null, null, "no rateLimitedUntil");
  assert.equal(r.lastErrorType, "quota_exhausted", "tariff-scoped light update recorded");

  // 2) Start on the SAME connection must still be served.
  const startResponse = await route.POST(
    harness.buildRequest({
      headers: { "x-omniroute-connection": account.id },
      body: {
        model: "zc/glm-5.3-flash",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  );
  assert.equal(startResponse.status, 200, "Start is served despite the Individual 429");
  const startJson = await startResponse.json();
  assert.equal(startJson.choices?.[0]?.message?.content, "start tariff text");
  assert.equal(startUpstreamCalls, 1, "Start reached the upstream exactly once");

  // 3) The model-locked Individual retry must not reach the inference upstream.
  const callsBeforeRetry = individualInferenceCalls;
  const retryResponse = await route.POST(
    harness.buildRequest({
      headers: { "x-omniroute-connection": account.id },
      body: {
        model: "zc-individual/glm-5.3-flash",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  );
  assert.ok(retryResponse.status >= 400, "the locked Individual retry is refused");
  assert.equal(
    individualInferenceCalls,
    callsBeforeRetry,
    "the model-locked Individual retry made zero inference calls"
  );
});

test("Individual reaches the upstream after a Start 429; the locked Start retry does not", async () => {
  const account = await db.createProviderConnection({
    provider: "zcode",
    authType: "oauth",
    name: "tariff isolation fixture",
    accessToken: "individual-business",
    idToken: "jwt-start-fixture",
    providerSpecificData: { family: "zai", userId: "fixture" },
  });

  let individualInferenceCalls = 0;
  let startUpstreamCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/anthropic/v1/messages")) {
      // Individual (signed gateway) inference: fail with the 1310 quota text.
      individualInferenceCalls += 1;
      return Response.json({
        id: "msg-individual",
        type: "message",
        role: "assistant",
        model: "GLM-5.3-Flash",
        content: [{ type: "text", text: "individual tariff text" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    }
    if (url.includes("/api/v1/zcode-plan/anthropic/v1/messages")) {
      // Start (Z-code plan gateway) inference: a complete Anthropic response
      // body (the request is stream:false — mirror zcode-oauth-http.test.ts).
      startUpstreamCalls += 1;
      return Response.json(
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            code: "1310",
            message: "1310 Weekly/Monthly Limit Exhausted",
          },
        },
        { status: 429 }
      );
    }
    if (url.endsWith("/api/auth/z/login"))
      return Response.json({ code: 200, data: { access_token: "business", expires_in: 600 } });
    if (url.endsWith("getCustomerInfo"))
      return Response.json({
        code: 200,
        data: { organizations: [{ organizationId: "o", projects: [{ projectId: "p" }] }] },
      });
    if (url.endsWith("/api_keys"))
      return Response.json({ code: 200, data: [{ name: "zcode-api-key", apiKey: "k" }] });
    if (url.endsWith("/access_tokens"))
      return Response.json({
        code: 200,
        data: {
          accessToken: token,
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        },
      });
    if (url.endsWith("/api/paas/c1f3a7e2/v2/client"))
      return Response.json({ code: 200, data: { privateCipher: encrypted } });
    throw Error("unexpected endpoint: " + url);
  };

  const request = (model: string) =>
    route.POST(
      harness.buildRequest({
        headers: { "x-omniroute-connection": account.id },
        body: { model, stream: false, messages: [{ role: "user", content: "hi" }] },
      })
    );
  const failed = await request("zc-start/glm-5.3-flash");
  assert.ok(failed.status >= 400);
  assert.equal(startUpstreamCalls, 1);
  const row = await db.getProviderConnectionById(account.id);
  assert.notEqual(row?.testStatus, "unavailable");
  assert.equal(row?.rateLimitedUntil ?? null, null);
  const sibling = await request("zc-individual/glm-5.3-flash");
  assert.equal(sibling.status, 200);
  assert.equal((await sibling.json()).choices?.[0]?.message?.content, "individual tariff text");
  assert.equal(individualInferenceCalls, 1);
  const retry = await request("zc/glm-5.3-flash");
  assert.ok(retry.status >= 400);
  assert.equal(startUpstreamCalls, 1, "locked Start retry made no upstream call");
});

test("locks are isolated by account, plan and model; auth and provider errors stay global", async () => {
  const { markAccountUnavailable } = await import("../../src/sse/services/auth.ts");
  const { isModelLocked } = await import("../../open-sse/services/accountFallback.ts");
  const { isZcodeTariffQuota429 } = await import("../../open-sse/handlers/chatCore/keyHealth.ts");
  const createAccount = () =>
    db.createProviderConnection({
      provider: "zcode",
      authType: "oauth",
      name: "isolation",
      accessToken: "fixture",
      idToken: "fixture",
    });
  const a = await createAccount();
  const b = await createAccount();
  await markAccountUnavailable(
    a.id,
    429,
    "1310 Weekly/Monthly Limit Exhausted",
    "zc",
    "glm-5.3-flash"
  );
  assert.equal(isModelLocked("zc", a.id, "glm-5.3-flash"), true);
  assert.equal(isModelLocked("zcode-start", a.id, "glm-5.3-flash"), true);
  assert.equal(isModelLocked("zc", b.id, "glm-5.3-flash"), false);
  assert.equal(isModelLocked("zcode-individual", a.id, "glm-5.3-flash"), false);
  assert.equal(isModelLocked("zc", a.id, "glm-5.3"), false);
  for (const [status, message] of [
    [401, "invalid token"],
    [403, "account banned"],
    [500, "provider error"],
    [429, "account banned"],
    [429, "invalid token"],
    [429, "provider overloaded"],
  ] as const) {
    assert.equal(
      isZcodeTariffQuota429("zcode", "oauth", status, message),
      false,
      `${status} ${message}`
    );
    const c = await createAccount();
    await markAccountUnavailable(c.id, status, message, "zc", "glm-5.3-flash");
    assert.equal(
      isModelLocked("zc", c.id, "glm-5.3-flash"),
      false,
      `${status} ${message} must not become a tariff lock`
    );
    const row = await db.getProviderConnectionById(c.id);
    assert.ok(
      row?.rateLimitedUntil || row?.testStatus === "banned" || row?.testStatus === "expired",
      `${status} ${message} must affect connection`
    );
  }
  assert.equal(isZcodeTariffQuota429("zcode", "apikey", 429, "rate limit"), false);
});
