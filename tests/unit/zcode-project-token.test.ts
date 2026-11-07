import { test } from "node:test";
import assert from "node:assert/strict";
import { ZcodeProjectTokenResolver } from "../../open-sse/executors/zcode/projectToken.ts";

test("resolves one existing BigModel project key and shares concurrent token issuance", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("getCustomerInfo"))
      return Response.json({
        code: 200,
        data: {
          organizations: [
            {
              organizationId: "org",
              organizationName: "默认机构",
              projects: [
                { projectId: "team", projectType: 2 },
                { projectId: "personal", projectName: "默认项目" },
              ],
            },
          ],
        },
      });
    if (url.endsWith("/api_keys"))
      return Response.json({ code: 200, data: [{ name: "zcode-api-key", apiKey: "key" }] });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer business");
    return Response.json({
      code: 200,
      data: {
        accessToken: "project",
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Date.now() / 1000 + 600,
      },
    });
  };
  const resolver = new ZcodeProjectTokenResolver(request);
  const identity = {
    connectionId: "account",
    family: "bigmodel" as const,
    accessToken: "business",
  };
  assert.deepEqual(await Promise.all([resolver.resolve(identity), resolver.resolve(identity)]), [
    "project",
    "project",
  ]);
  assert.equal(await resolver.resolve(identity), "project");
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /projects\/personal\/api_keys$/);
  assert.equal(new Headers(calls[1].init?.headers).get("authorization"), "business");
  assert.equal(calls[2].init?.method, "POST");
});

test("does not create a key or issue a token if existing key is absent", async () => {
  let calls = 0;
  const request: typeof fetch = async () =>
    ++calls === 1
      ? Response.json({
          code: 200,
          data: {
            organizations: [{ organizationId: "org", projects: [{ projectId: "personal" }] }],
          },
        })
      : Response.json({ code: 200, data: [] });
  const resolver = new ZcodeProjectTokenResolver(request);
  await assert.rejects(
    resolver.resolve({ connectionId: "account", family: "bigmodel", accessToken: "business" })
  );
  assert.equal(calls, 2);
});

test("rejects duplicate names even when one key has a malformed locator", async () => {
  let calls = 0;
  const request: typeof fetch = async () =>
    ++calls === 1
      ? Response.json({
          code: 200,
          data: {
            organizations: [{ organizationId: "org", projects: [{ projectId: "personal" }] }],
          },
        })
      : Response.json({
          code: 200,
          data: [{ name: "zcode-api-key", apiKey: "key" }, { name: "zcode-api-key" }],
        });
  const resolver = new ZcodeProjectTokenResolver(request);
  await assert.rejects(
    resolver.resolve({ connectionId: "account", family: "bigmodel", accessToken: "business" })
  );
  assert.equal(calls, 2);
});

test("isolates cached project tokens by OAuth account", async () => {
  let issued = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("getCustomerInfo"))
      return Response.json({
        code: 200,
        data: { organizations: [{ organizationId: "org", projects: [{ projectId: "personal" }] }] },
      });
    if (url.endsWith("/api_keys"))
      return Response.json({ code: 200, data: [{ name: "zcode-api-key", apiKey: "key" }] });
    issued++;
    return Response.json({
      code: 200,
      data: {
        accessToken: new Headers(init?.headers).get("authorization"),
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Date.now() / 1000 + 600,
      },
    });
  };
  const resolver = new ZcodeProjectTokenResolver(request);
  assert.equal(
    await resolver.resolve({ connectionId: "a", family: "bigmodel", accessToken: "a" }),
    "Bearer a"
  );
  assert.equal(
    await resolver.resolve({ connectionId: "b", family: "bigmodel", accessToken: "b" }),
    "Bearer b"
  );
  assert.equal(
    await resolver.resolve({ connectionId: "a", family: "bigmodel", accessToken: "new" }),
    "Bearer new"
  );
  assert.equal(issued, 3);
});

test("keeps global OAuth and project lookup on the Z.ai origin", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/api/auth/z/login")) {
      assert.equal(JSON.parse(String(init?.body)).token, "global-business");
      return Response.json({
        code: 200,
        data: { access_token: "exchanged-business", expires_in: 600 },
      });
    }
    if (url.endsWith("getCustomerInfo"))
      return Response.json({
        code: 200,
        data: { organizations: [{ organizationId: "org", projects: [{ projectId: "personal" }] }] },
      });
    if (url.endsWith("/api_keys"))
      return Response.json({ code: 200, data: [{ name: "zcode-api-key", apiKey: "key" }] });
    return Response.json({
      code: 200,
      data: {
        accessToken: "project",
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Date.now() / 1000 + 600,
      },
    });
  };
  assert.equal(
    await new ZcodeProjectTokenResolver(request).resolve({
      connectionId: "zai",
      family: "zai",
      accessToken: "global-business",
    }),
    "project"
  );
  assert.ok(calls.every((c) => c.url.startsWith("https://api.z.ai/")));
  assert.deepEqual(
    calls.map((c) => c.auth),
    [null, "exchanged-business", "Bearer exchanged-business", "Bearer exchanged-business"]
  );
});

test("normalized Z.ai business grants skip OAuth exchange", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.ok(!url.endsWith("/api/auth/z/login"));
    assert.ok(
      ["business", "Bearer business"].includes(
        new Headers(init?.headers).get("authorization") || ""
      )
    );
    if (url.endsWith("getCustomerInfo"))
      return Response.json({
        code: 200,
        data: { organizations: [{ organizationId: "org", projects: [{ projectId: "personal" }] }] },
      });
    if (url.endsWith("/api_keys"))
      return Response.json({ code: 200, data: [{ name: "zcode-api-key", apiKey: "key" }] });
    return Response.json({
      code: 200,
      data: {
        accessToken: "project",
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Date.now() / 1000 + 600,
      },
    });
  };
  const token = await new ZcodeProjectTokenResolver(request).resolve({
    connectionId: "zai-normalized",
    family: "zai",
    accessToken: "business",
    accessTokenFormat: "business",
  });
  assert.equal(token, "project");
  assert.equal(calls.length, 3);
});
