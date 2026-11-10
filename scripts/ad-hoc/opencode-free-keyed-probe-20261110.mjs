import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { decrypt } from "../../src/lib/db/encryption.ts";

const evidence = new URL("../../_tasks/research/2026-11-10-free-route/", import.meta.url);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const secretFile = execFileSync("sudo", ["-n", "cat", "/etc/omniroute/storage-encryption.env"], {
  encoding: "utf8",
});
const match = secretFile.match(/^STORAGE_ENCRYPTION_KEY=(.+)$/m);
if (!match) throw new Error("Storage encryption key is unavailable");
process.env.STORAGE_ENCRYPTION_KEY = match[1].trim().replace(/^["']|["']$/g, "");
const db = new Database("/home/roomhacker/.omniroute/storage.sqlite", {
  readonly: true,
  fileMustExist: true,
});
db.pragma("query_only=ON");
const accounts = db
  .prepare(
    "SELECT id, name, api_key FROM provider_connections WHERE provider = ? AND is_active = 1"
  )
  .all("opencode-zen");
const receipts = [];
for (const account of accounts) {
  const key = decrypt(account.api_key, { quiet: true });
  if (!key || key.includes("****") || key.startsWith("enc:"))
    throw new Error("Account key unavailable");
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const receipt = { accountId: account.id, accountName: account.name, requestId, startedAt };
  try {
    const response = await fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
        "user-agent": "OmniRoute/3.8.53",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        model: "glm-5.3-flash-free",
        stream: false,
        max_tokens: 128,
        reasoning_effort: "low",
        messages: [{ role: "user", content: "For a connectivity check, reply FREE_ROUTE_OK." }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    receipt.http = response.status;
    receipt.retryAfter = response.headers.get("retry-after");
    const body = await response.json();
    receipt.error = body.error
      ? { type: body.error.type, code: body.error.code, message: body.error.message }
      : undefined;
    receipt.model = body.model;
    receipt.usage = body.usage;
    receipt.content = body.choices?.[0]?.message?.content?.slice(0, 300);
  } catch (error) {
    receipt.transportError = error?.name || "Error";
    receipt.transportCode = error?.cause?.code || null;
  }
  receipt.finishedAt = new Date().toISOString();
  receipts.push(receipt);
  await writeFile(
    new URL("keyed-probes.json", evidence),
    JSON.stringify(receipts, null, 2) + "\n",
    { mode: 0o600 }
  );
  console.log(JSON.stringify(receipt));
}
db.close();
