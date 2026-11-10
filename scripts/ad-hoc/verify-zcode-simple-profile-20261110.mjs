import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const protectedEnv = execFileSync("sudo", ["-n", "cat", "/etc/omniroute/storage-encryption.env"], {
  encoding: "utf8",
});
const storageKey = protectedEnv
  .match(/^STORAGE_ENCRYPTION_KEY=(.+)$/m)?.[1]
  .trim()
  .replace(/^["']|["']$/g, "");
assert(storageKey, "Protected storage reference unavailable");
process.env.STORAGE_ENCRYPTION_KEY = storageKey;
const { decryptConnectionFields } = await import("../../src/lib/db/encryption.ts");
const { rowToCamel } = await import("../../src/lib/db/caseMapping.ts");
const { NativeZcodeHostManager } =
  await import("../../open-sse/executors/zcode/nativeHostManager.ts");
const { NativeZcodeHostClient } =
  await import("../../open-sse/executors/zcode/nativeHostClient.ts");
const { decodeZcodeValue } = await import("../../open-sse/executors/zcodeProtocol.ts");
const { sanitizeErrorMessage } = await import("../../open-sse/utils/error.ts");
const runId = randomUUID();
const stateRoot = resolve(".build/zcode-simple-profile-20261110/" + runId);
const summaryPath = resolve(
  "_tasks/research/2026-11-10-zcode-timeouts/simple-profile-" + runId + ".json"
);
const manager = new NativeZcodeHostManager({ stateRoot });
const results = [];
const providerId = process.argv[2] || "account:bigmodel-start-plan";
assert(
  [
    "account:bigmodel-start-plan",
    "account:bigmodel-individual-coding-plan",
    "account:zai-start-plan",
  ].includes(providerId)
);
let closed = false;
try {
  const db = new Database("/home/roomhacker/.omniroute/storage.sqlite", {
    readonly: true,
    fileMustExist: true,
  });
  let connection;
  try {
    const connectionId = providerId.startsWith("account:zai-")
      ? "9381af1f-793f-4de8-971b-1ddb672c2fc1"
      : "7ce2765a-6284-444c-89af-d5b50ae8b7ac";
    connection = decryptConnectionFields(
      rowToCamel(db.prepare("SELECT * FROM provider_connections WHERE id=?").get(connectionId))
    );
  } finally {
    db.close();
  }
  assert(connection && connection.authType === "oauth");
  const serverRoot = await manager.ensure({ ...connection, connectionId: connection.id });
  const cliConfig = {
    features: { mcp: false, subagent: false, memory: false },
    mcp: { servers: {} },
    plugins: { enabled: false },
    hooks: { enabled: false },
  };
  const cliDirectory = join(serverRoot, "..", "cli");
  await mkdir(cliDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(cliDirectory, "config.json"), JSON.stringify(cliConfig), { mode: 0o600 });
  results.push({ phase: "cli-config", config: cliConfig });
  const client = new NativeZcodeHostClient({
    serverRoot,
    startupTimeoutMs: 30000,
    requestTimeoutMs: 150000,
  });
  const consume = client.consume.bind(client);
  client.consume = (raw) => {
    const bytes = Buffer.from(raw);
    if (bytes.length >= 13 && bytes[0] === 1) {
      const header = decodeZcodeValue(bytes.subarray(13));
      if (Array.isArray(header.value) && header.value[0] === 202) {
        const payload = decodeZcodeValue(bytes.subarray(13), header.offset).value;
        let reason = String(payload?.message || "");
        for (const secret of [
          storageKey,
          connection.accessToken,
          connection.refreshToken,
          connection.idToken,
          ...(client.secretValues || []),
        ])
          if (secret) reason = reason.split(secret).join("[redacted]");
        reason = sanitizeErrorMessage(reason)
          .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url]")
          .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]")
          .replace(/[A-Za-z0-9_-]{48,}/g, "[opaque]")
          .slice(0, 400);
        results.push({ phase: "native-error", code: payload?.code, reason });
      }
    }
    consume(raw);
  };
  const call = client.call.bind(client);
  client.call = async (channel, method, args, options) => {
    const started = Date.now();
    results.push({ phase: "rpc-start", channel, method });
    try {
      return await call(channel, method, args, options);
    } finally {
      results.push({ phase: "rpc-end", channel, method, elapsedMs: Date.now() - started });
    }
  };
  const workspacePath = join(stateRoot, "empty-workspace");
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const started = Date.now();
  try {
    await client.start();
    const view = await client.call("model-selection", "getView", []);
    const model = view.providers
      .find((row) => row.providerId === providerId)
      ?.models.find((row) => row.modelId.toLowerCase() === "glm-5.3-flash");
    assert(model, "Requested native Start model is not in this account registry");
    const selection = { providerId, modelId: model.modelId, options: { reasoningLevel: "high" } };
    const nonce = "simple_profile_" + randomUUID();
    const messages = [
      {
        role: "user",
        content: "Call read_nonce once with an empty object, then return only its result verbatim.",
      },
    ];
    const tools = [
      {
        name: "read_nonce",
        description: "Read the nonce needed for the user's request.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const firstStarted = Date.now();
    const first = await client.call("zcode-agent", "generateWorkspaceText", [
      {
        workspacePath,
        workspaceIdentity: workspacePath,
        selection,
        messages,
        tools,
        querySource: "omniroute",
        maxOutputTokens: 1000,
        requestTimeoutMs: 150000,
      },
    ]);
    assert.equal(first.selection.providerId, providerId);
    assert.equal(first.selection.modelId, model.modelId);
    assert.equal(first.toolCalls?.[0]?.name, "read_nonce");
    results.push({
      phase: "tool",
      elapsedMs: Date.now() - firstStarted,
      selection: first.selection,
      finishReason: first.finishReason,
    });
    messages.push({ role: "assistant", content: first.text || "", toolCalls: first.toolCalls });
    for (const call of first.toolCalls)
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: nonce });
    const secondStarted = Date.now();
    const second = await client.call("zcode-agent", "generateWorkspaceText", [
      {
        workspacePath,
        workspaceIdentity: workspacePath,
        selection,
        messages,
        tools,
        querySource: "omniroute",
        maxOutputTokens: 1000,
        requestTimeoutMs: 150000,
      },
    ]);
    assert.equal(second.text.trim(), nonce);
    results.push({
      phase: "nonce",
      elapsedMs: Date.now() - secondStarted,
      selection: second.selection,
      nonceMatched: true,
      usage: second.usage,
    });
    const account = (await readdir(stateRoot)).find((name) => /^[a-f0-9]{64}$/.test(name));
    assert(account);
    const index = new Database(join(stateRoot, account, ".zcode/v2/tasks-index.sqlite"), {
      readonly: true,
    });
    try {
      const counts = Object.fromEntries(
        ["projects", "tasks"].map((table) => [
          table,
          index.prepare("SELECT COUNT(*) n FROM " + table).get().n,
        ])
      );
      results.push({
        phase: "profile",
        counts,
        elapsedMs: Date.now() - started,
        noMcpBridgeStarted: true,
      });
      assert.deepEqual(counts, { projects: 0, tasks: 0 });
    } finally {
      index.close();
    }
  } finally {
    await client.close();
  }
} catch (error) {
  results.push({
    phase: "error",
    name: error.name,
    code: error.code,
    providerCode: error.providerCode,
    assertion: error.name === "AssertionError" ? error.message.slice(0, 250) : undefined,
  });
  process.exitCode = 1;
} finally {
  await manager.close();
  closed = true;
  await writeFile(
    summaryPath,
    JSON.stringify({ runId, providerId, stateRoot, closed, results }, null, 2),
    { mode: 0o600 }
  );
  console.log(JSON.stringify({ summaryPath, providerId, closed, results }));
}
