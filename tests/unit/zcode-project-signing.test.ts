import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac, generateKeyPairSync, hkdfSync, verify } from "node:crypto";
import { fetchSignedZcodeProject } from "../../open-sse/executors/zcode/nativeProtocol.ts";

test("rejects malformed project credentials before making a network request", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    throw new Error("unexpected request");
  };
  await assert.rejects(fetchSignedZcodeProject("bad.token.value", {}, "session", request));
  assert.equal(calls, 0);
});

test("does not send an unsigned inference request after handshake rejection", async () => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "test" })}.signature`;
  let calls = 0;
  const mock: typeof fetch = async () => {
    calls++;
    return new Response(null, { status: 403 });
  };
  await assert.rejects(fetchSignedZcodeProject(token, {}, "session", mock));
  assert.equal(calls, 1);
});

test("signs project handshake and streams the signed response without buffering", async () => {
  const id = "test-project-id",
    session = "test-session",
    version = "3.17.2";
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: id })}.signature`;
  const derive = (info: string) =>
    Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(token),
        Buffer.from("WD_CLIENT_SIGN_KDF_SALT"),
        Buffer.from(info),
        32
      )
    );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const iv = Buffer.alloc(12, 7),
    cipher = createCipheriv("aes-256-gcm", derive("ed25519_priv"), iv);
  cipher.setAAD(Buffer.from(id));
  const plaintext = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const encrypted = Buffer.concat([
    iv,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  let calls = 0,
    finish!: () => void;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      finish = () => {
        controller.enqueue(new TextEncoder().encode("last"));
        controller.close();
      };
    },
  });
  const mock: typeof fetch = async (input, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(String(input), "https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client");
      const data = JSON.parse(String(init?.body));
      assert.equal(data.accessToken, token);
      assert.equal(
        data.sig,
        createHmac("sha256", derive("getSignKey_hmac"))
          .update(["get_sign_key", id, data.ts, data.nonce].join("\n"))
          .digest("base64")
      );
      return Response.json({ code: 200, data: { privateCipher: encrypted } });
    }
    assert.equal(String(input), "https://open.bigmodel.cn/api/anthropic/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), token);
    assert.equal(headers.get("x-session-id"), session);
    assert.ok(
      verify(
        null,
        Buffer.from(
          [id, headers.get("x-client-ts"), version, session, headers.get("x-client-nonce")].join(
            "\n"
          )
        ),
        publicKey,
        Buffer.from(headers.get("x-client-sig")!, "base64")
      )
    );
    return new Response(source, { headers: { "content-type": "text/event-stream" } });
  };
  const response = await fetchSignedZcodeProject(token, { stream: true }, session, mock);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  finish();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
  assert.equal((await reader.read()).done, true);
  assert.equal(calls, 2);
});
