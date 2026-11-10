import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { getCliToken } from "../../bin/cli/utils/cliToken.mjs";
import { decrypt } from "../../src/lib/db/encryption.ts";

const base = "http://127.0.0.1:20128";
const comboId = "7a4a012a-ee6a-4553-8d78-18279dc79885";
const mode = process.argv[2];
const leg = process.argv[3] || "cn-individual";
assert(["configure", "probe", "tools", "combo"].includes(mode));
const dir = new URL("../../_tasks/research/2026-11-10-final-routing/", import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
const save = (name, value) =>
  writeFile(new URL(name, dir), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const headers = {
  "x-omniroute-cli-token": await getCliToken(),
  "content-type": "application/json",
};
async function management(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert(response.ok, "Management HTTP " + response.status + ": " + JSON.stringify(data));
  return data;
}

if (mode === "configure") {
  const before = await management("/api/combos/" + comboId);
  await save("combo-before.json", before);
  const config = {
    ...before.config,
    strictRequestContextRouting: true,
    outputLimitAdvisory: true,
    disableSessionStickiness: true,
  };
  await save("combo-patch-intent.json", { strategy: "priority", config });
  await management("/api/combos/" + comboId, "PUT", { strategy: "priority", config });
  const after = await management("/api/combos/" + comboId);
  assert.equal(after.strategy, "priority");
  assert.equal(after.config.strictRequestContextRouting, true);
  assert.equal(after.config.disableSessionStickiness, true);
  assert.deepEqual(after.models, before.models);
  await save("combo-after.json", after);
  console.log(JSON.stringify({ configured: true, name: after.name, strategy: after.strategy }));
} else {
  const secretEnv = execFileSync("sudo", ["-n", "cat", "/etc/omniroute/storage-encryption.env"], {
    encoding: "utf8",
  });
  const match = secretEnv.match(/^STORAGE_ENCRYPTION_KEY=(.+)$/m);
  assert(match, "Encryption key unavailable");
  process.env.STORAGE_ENCRYPTION_KEY = match[1].trim().replace(/^["']|["']$/g, "");
  const db = new Database("/home/roomhacker/.omniroute/storage.sqlite", {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only=ON");
  const client = db
    .prepare("SELECT key FROM api_keys WHERE name = ? AND is_active = 1 AND revoked_at IS NULL")
    .get("opencode-100");
  assert(client, "Consumer key unavailable");
  const apiKey = decrypt(client.key, { quiet: true });
  assert(apiKey && !apiKey.startsWith("enc:"), "Consumer key unavailable");
  const definitions = {
    start: ["zcode-start", "9381af1f-793f-4de8-971b-1ddb672c2fc1"],
    "cn-start": ["zcode-cn-start", "7ce2765a-6284-444c-89af-d5b50ae8b7ac"],
    individual: ["zcode-individual", "9381af1f-793f-4de8-971b-1ddb672c2fc1"],
    "cn-individual": ["zcode-cn-individual", "7ce2765a-6284-444c-89af-d5b50ae8b7ac"],
  };
  const startedAt = new Date().toISOString();
  const receipt = { mode, leg, startedAt, requests: [], trace: [] };
  const receiptName = mode + "-" + leg + "-" + startedAt.replace(/[:.]/g, "-") + ".json";
  let temporary;
  let requestedModel;
  try {
    if (mode === "combo") {
      requestedModel = (await management("/api/combos/" + comboId)).name;
    } else {
      assert(definitions[leg], "Unknown native leg");
      const [provider, connectionId] = definitions[leg];
      const name = "repair-native-20261110-" + leg + "-" + randomUUID().slice(0, 8);
      const input = {
        name,
        strategy: "priority",
        models: [
          { kind: "model", model: provider + "/glm-5.3-flash", providerId: provider, connectionId },
        ],
        config: {
          maxRetries: 0,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          disableSessionStickiness: true,
        },
      };
      receipt.temporaryComboIntent = input;
      await save(receiptName, receipt);
      temporary = await management("/api/combos", "POST", input);
      requestedModel = temporary.name;
      receipt.temporaryComboId = temporary.id;
    }
    receipt.requestedModel = requestedModel;
    async function request(messages, tools) {
      const intent = {
        startedAt: new Date().toISOString(),
        correlationId: randomUUID(),
        requestedModel,
        tools: Boolean(tools),
      };
      receipt.requests.push(intent);
      await save(receiptName, receipt);
      const response = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json",
          "x-correlation-id": intent.correlationId,
        },
        body: JSON.stringify({
          model: requestedModel,
          messages,
          max_tokens: 1024,
          stream: false,
          ...(tools ? { tools } : {}),
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const text = await response.text();
      intent.http = response.status;
      intent.finishedAt = new Date().toISOString();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { nonJsonBody: text.slice(0, 1000) };
      }
      intent.body = body;
      await save(receiptName, receipt);
      return body;
    }
    if (mode === "tools") {
      const messages = [
        {
          role: "user",
          content: "Call caller_probe once, then reply with exactly its returned random value.",
        },
      ];
      const tools = [
        {
          type: "function",
          function: {
            name: "caller_probe",
            description: "Get a random value from the caller.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ];
      const first = await request(messages, tools);
      assert.equal(receipt.requests.at(-1).http, 200);
      const assistant = first.choices?.[0]?.message;
      const calls = assistant?.tool_calls;
      assert.equal(calls?.length, 1);
      assert.equal(calls[0].function.name, "caller_probe");
      const marker = "CALLER_RESULT_" + randomUUID();
      receipt.callerResult = marker;
      const final = await request(
        [...messages, assistant, { role: "tool", tool_call_id: calls[0].id, content: marker }],
        tools
      );
      assert.equal(receipt.requests.at(-1).http, 200);
      assert.equal(final.choices?.[0]?.message?.content?.trim(), marker);
      receipt.toolRoundtrip = true;
    } else {
      const marker = "ROUTE_OK_" + randomUUID().slice(0, 8);
      receipt.expectedMarker = marker;
      await request([
        { role: "user", content: "Reply with exactly " + marker + ". Do not use tools." },
      ]);
    }
  } catch (error) {
    receipt.failure = { name: error.name, message: String(error.message).slice(0, 700) };
  } finally {
    if (requestedModel) {
      // Include only this caller's requests, even when the public combo is busy.
      await delay(2_000);
      const trace = db.prepare(
        "SELECT id,timestamp,provider,model,connection_id,status,requested_model,combo_name,error_summary,correlation_id FROM call_logs WHERE correlation_id = ? ORDER BY timestamp"
      );
      receipt.trace = receipt.requests.flatMap((item) => trace.all(item.correlationId));
    }
    if (temporary?.id) {
      try {
        await management("/api/combos/" + temporary.id, "DELETE");
        receipt.temporaryComboRemoved = true;
      } catch (error) {
        receipt.cleanupFailure = String(error.message).slice(0, 300);
      }
    }
    receipt.finishedAt = new Date().toISOString();
    await save(receiptName, receipt);
    db.close();
  }
  console.log(JSON.stringify({ evidence: new URL(receiptName, dir).pathname, ...receipt }));
  if (receipt.failure || receipt.cleanupFailure) process.exitCode = 1;
}
