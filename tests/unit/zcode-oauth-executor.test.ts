import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, hkdfSync } from "node:crypto";

test("individual OAuth delivers text before upstream completes", async (t) => {
  const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.ts");
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "test-key" })}.sig`;
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
  const iv = Buffer.alloc(12, 1),
    cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from("test-key"));
  const encrypted = Buffer.concat([
    iv,
    cipher.update(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const sse = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let finish!: () => void;
  const source = new ReadableStream({
    start(controller) {
      const e = new TextEncoder();
      controller.enqueue(
        e.encode(
          sse("message_start", {
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              model: "GLM-5.3-Flash",
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }) +
            sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            sse("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "hello stream" },
            })
        )
      );
      finish = () => {
        controller.enqueue(
          e.encode(
            sse("content_block_stop", { index: 0 }) +
              sse("message_delta", {
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 2 },
              }) +
              sse("message_stop", {})
          )
        );
        controller.close();
      };
    },
  });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    urls.push(url);
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
    if (url.endsWith("/api/anthropic/v1/messages"))
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    throw Error("unexpected endpoint");
  });
  const result = await new ZcodeExecutor({
    provider: "zcode-individual",
    providerId: "account:zai-individual-coding-plan",
  }).execute({
    model: "glm-5.3-flash",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: {
      connectionId: "test-stream",
      accessToken: "oauth",
      providerSpecificData: { family: "zai" },
    },
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let text = "";
  for (let i = 0; i < 8 && !text.includes("hello stream"); i++) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error("stream buffered")), 1500)),
    ]);
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  assert.match(text, /hello stream/);
  assert.ok(urls.every((u) => u.startsWith("https://api.z.ai/")));
  finish();
  while (!(await reader.read()).done) {}
});

test("individual OAuth selection never silently falls back to Start for unsupported region", async (t) => {
  const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.ts");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  const result = await new ZcodeExecutor({
    provider: "zcode-individual",
    providerId: "account:zai-individual-coding-plan",
  }).execute({
    model: "glm-5.3-flash",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {
      accessToken: "oauth",
      idToken: "start-jwt",
      connectionId: "a",
      providerSpecificData: { family: "unknown" },
    },
  });
  assert.equal(("response" in result ? result.response : result).status, 401);
  assert.equal(calls, 0);
});

test("each ZCode Start account sends its own ZCode JWT and identity", async (t) => {
  const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.ts");
  const calls: { url: string; authorization: string | null; device: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    const metadata = JSON.parse(body.metadata.user_id);
    assert.equal(metadata.session_id, "");
    assert.equal(
      new Headers(init.headers).get("x-api-key"),
      new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "")
    );
    calls.push({
      url: String(input),
      authorization: new Headers(init.headers).get("authorization"),
      device: metadata.device_id,
    });
    return Response.json({
      id: "msg",
      type: "message",
      role: "assistant",
      model: "GLM-5.3-Flash",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  const executor = new ZcodeExecutor();
  for (const [family, userId] of [
    ["zai", "a"],
    ["bigmodel", "b"],
  ]) {
    const result = await executor.execute({
      model: "glm-5.3-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {
        accessToken: `oauth-${userId}`,
        idToken: `start-jwt-${userId}`,
        connectionId: userId,
        providerSpecificData: { family, userId },
      },
    });
    assert.equal(("response" in result ? result.response : result).status, 200);
  }
  assert.match(calls[0].device, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].device, calls[1].device);
  assert.notEqual(calls[0].device, "a");
  assert.notEqual(calls[1].device, "b");
  assert.deepEqual(
    calls.map(({ device: _device, ...call }) => call),
    [
      {
        url: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
        authorization: "Bearer start-jwt-a",
      },
      {
        url: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
        authorization: "Bearer start-jwt-b",
      },
    ]
  );
});

test("reports the provider security refusal without calling it quota exhaustion", async (t) => {
  const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.ts");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: 3012, msg: "request has been blocked due to unusual activity." },
      { status: 405 }
    )
  );
  const result = await new ZcodeExecutor().execute({
    model: "glm-5.3-flash",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { accessToken: "oauth", idToken: "jwt", connectionId: "a" },
  });
  assert.ok(result instanceof Response);
  assert.equal(result.status, 405);
  const body = await result.text();
  assert.match(body, /3012/);
  assert.match(body, /unusual activity/);
});

test("preserves a provider's diagnostic msg and numeric code", async (t) => {
  const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.ts");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: 3001, msg: "authorization expired" }, { status: 401 })
  );
  const result = await new ZcodeExecutor().execute({
    model: "glm-5.3-flash",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { accessToken: "oauth", idToken: "jwt", connectionId: "a" },
  });
  assert.ok(result instanceof Response);
  const body = await result.text();
  assert.match(body, /3001/);
  assert.match(body, /authorization expired/);
});
