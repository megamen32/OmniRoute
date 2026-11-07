import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, hkdfSync } from "node:crypto";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

process.env.STORAGE_ENCRYPTION_KEY = "test-only-zcode-http-encryption-key";
const harness = await createChatPipelineHarness("zcode-oauth-http");
const db = await import("../../src/lib/db/providers.ts");
const route = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;
test.after(async () => {
  globalThis.fetch = originalFetch;
  await harness.cleanup();
});

test("pinned individual OAuth streams text through the HTTP handler before upstream finishes", async () => {
  const account = await db.createProviderConnection({
    provider: "zcode",
    authType: "oauth",
    name: "individual fixture",
    accessToken: "individual-business",
    providerSpecificData: { family: "zai", userId: "fixture" },
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
  const iv = Buffer.alloc(12, 2),
    cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from("fixture-key"));
  const encrypted = Buffer.concat([
    iv,
    cipher.update(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let finish!: () => void;
  const source = new ReadableStream({
    start(controller) {
      const e = new TextEncoder();
      controller.enqueue(
        e.encode(
          event("message_start", {
            message: {
              id: "fixture",
              type: "message",
              role: "assistant",
              model: "GLM-5.3-Flash",
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }) +
            event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "first visible text" },
            })
        )
      );
      finish = () => {
        controller.enqueue(
          e.encode(
            event("content_block_stop", { index: 0 }) +
              event("message_delta", {
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 2 },
              }) +
              event("message_stop", {})
          )
        );
        controller.close();
      };
    },
  });
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    assert.ok(url.startsWith("https://api.z.ai/"));
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
    if (url.endsWith("/api/anthropic/v1/messages")) {
      assert.equal(new Headers(init?.headers).get("x-api-key"), token);
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    }
    throw Error("unexpected endpoint");
  };
  const response = await route.POST(
    harness.buildRequest({
      headers: { "x-omniroute-connection": account.id },
      body: {
        model: "zc-individual/glm-5.3-flash",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    })
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let output = "";
  for (let i = 0; i < 12 && !output.includes("first visible text"); i++) {
    const part = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error("stream buffered")), 2000)),
    ]);
    if (part.done) break;
    output += new TextDecoder().decode(part.value);
  }
  assert.match(output, /first visible text/);
  finish();
  while (!(await reader.read()).done) {}
  assert.equal(urls.length, 6);
});

test("encrypted Z-code account reaches the real HTTP path with its own Start JWT", async () => {
  const accounts = [];
  for (const family of ["zai", "bigmodel"]) {
    accounts.push(
      await db.createProviderConnection({
        provider: "zcode",
        authType: "oauth",
        name: family,
        accessToken: `access-${family}`,
        idToken: `jwt-${family}`,
        providerSpecificData: { family, userId: family },
      })
    );
  }
  const captured: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    assert.equal(target, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    captured.push({ url: target, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({
      id: "msg",
      type: "message",
      role: "assistant",
      model: "GLM-5.3-Flash",
      content: [{ type: "text", text: "fixture-ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  };
  for (const [i, family] of ["zai", "bigmodel"].entries()) {
    const request = harness.buildRequest({
      headers: { "x-omniroute-connection": accounts[i].id },
      body: {
        model: "zc/glm-5.3-flash",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const response = await route.POST(request);
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.choices[0].message.content, "fixture-ok");
    assert.equal(captured[i]?.authorization, `Bearer jwt-${family}`);
  }
  assert.equal(captured.length, 2);
});
