import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readZcodeIndividualCodingPlanApiKey,
  readZcodePlanGatewayProfile,
  resolveZcodeGatewayProviderOrder,
} from "../../open-sse/executors/zcode/profileAuth.ts";

const individualKey = "individual-profile.synthetic-secret";
const startKey = "header.payload.signature";

async function makeConfig(
  options: {
    individualEnabled?: boolean;
    individualBaseURL?: string;
    individualApiKey?: string;
    startEnabled?: boolean;
    startBaseURL?: string;
    startApiKey?: string;
  } = {}
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-profile-auth-"));
  const path = join(dir, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      provider: {
        "builtin:zai-coding-plan": {
          enabled: options.individualEnabled ?? true,
          kind: "anthropic",
          options: {
            apiKey: options.individualApiKey ?? individualKey,
            baseURL: options.individualBaseURL ?? "https://api.z.ai/api/anthropic/v1",
          },
        },
        "builtin:zai-start-plan": {
          enabled: options.startEnabled ?? true,
          kind: "anthropic",
          options: {
            apiKey: options.startApiKey ?? startKey,
            baseURL: options.startBaseURL ?? "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
          },
        },
      },
    }),
    { mode: 0o600 }
  );
  return { dir, path };
}

test("Start and Individual resolve to their own endpoint and authorization scheme", async () => {
  const { dir, path } = await makeConfig();
  try {
    const start = await readZcodePlanGatewayProfile("account:zai-start-plan", path);
    assert.deepEqual(
      {
        plan: start.plan,
        apiKey: start.apiKey,
        messagesUrl: start.messagesUrl,
        authScheme: start.authScheme,
      },
      {
        plan: "start",
        apiKey: startKey,
        messagesUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
        authScheme: "bearer",
      }
    );

    const individual = await readZcodePlanGatewayProfile(
      "account:zai-individual-coding-plan",
      path
    );
    assert.deepEqual(
      {
        plan: individual.plan,
        apiKey: individual.apiKey,
        messagesUrl: individual.messagesUrl,
        authScheme: individual.authScheme,
      },
      {
        plan: "individual",
        apiKey: individualKey,
        messagesUrl: "https://api.z.ai/api/anthropic/v1/messages",
        authScheme: "x-api-key",
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Individual profile accepts ZCode's canonical unversioned base URL and appends /v1/messages", async () => {
  const { dir, path } = await makeConfig({
    individualBaseURL: "https://api.z.ai/api/anthropic",
  });
  try {
    const individual = await readZcodePlanGatewayProfile(
      "account:zai-individual-coding-plan",
      path
    );
    assert.equal(individual.messagesUrl, "https://api.z.ai/api/anthropic/v1/messages");
    assert.equal(individual.authScheme, "x-api-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway defaults to Start then Individual while an explicit profile stays pinned", () => {
  assert.deepEqual(resolveZcodeGatewayProviderOrder(), [
    "account:zai-start-plan",
    "account:zai-individual-coding-plan",
  ]);
  assert.deepEqual(resolveZcodeGatewayProviderOrder("account:zai-individual-coding-plan"), [
    "account:zai-individual-coding-plan",
  ]);
  assert.deepEqual(resolveZcodeGatewayProviderOrder("account:zai-start-plan"), [
    "account:zai-start-plan",
  ]);
});

test("the Individual compatibility helper remains pinned to the Individual profile", async () => {
  const { dir, path } = await makeConfig();
  try {
    assert.equal(
      await readZcodeIndividualCodingPlanApiKey("account:zai-individual-coding-plan", path),
      individualKey
    );
    await assert.rejects(
      readZcodeIndividualCodingPlanApiKey("account:zai-start-plan", path),
      /only the explicitly selected Individual Plan/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile auth rejects disabled profiles, untrusted origins and malformed Start tokens", async () => {
  const disabled = await makeConfig({ startEnabled: false });
  try {
    await assert.rejects(
      readZcodePlanGatewayProfile("account:zai-start-plan", disabled.path),
      /profile is not enabled/
    );
  } finally {
    await rm(disabled.dir, { recursive: true, force: true });
  }

  const wrongOrigin = await makeConfig({
    startBaseURL: "https://attacker.example/api/v1/zcode-plan/anthropic",
  });
  try {
    await assert.rejects(
      readZcodePlanGatewayProfile("account:zai-start-plan", wrongOrigin.path),
      /unsupported API origin/
    );
  } finally {
    await rm(wrongOrigin.dir, { recursive: true, force: true });
  }

  const malformedToken = await makeConfig({ startApiKey: "not-a-signed-token" });
  try {
    await assert.rejects(
      readZcodePlanGatewayProfile("account:zai-start-plan", malformedToken.path),
      /invalid signed credential format/
    );
  } finally {
    await rm(malformedToken.dir, { recursive: true, force: true });
  }

  const wrongIndividualOrigin = await makeConfig({
    individualBaseURL: "https://attacker.example/api/anthropic",
  });
  try {
    await assert.rejects(
      readZcodePlanGatewayProfile("account:zai-individual-coding-plan", wrongIndividualOrigin.path),
      /unsupported API origin/
    );
  } finally {
    await rm(wrongIndividualOrigin.dir, { recursive: true, force: true });
  }
});

test("profile auth rejects unrelated provider IDs and over-permissive configs", async () => {
  const { dir, path } = await makeConfig();
  try {
    await assert.rejects(readZcodePlanGatewayProfile("custom:other", path), /Unsupported/);
    if (process.platform !== "win32") {
      await chmod(path, 0o640);
      await assert.rejects(
        readZcodePlanGatewayProfile("account:zai-start-plan", path),
        /permissions are too broad/
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
