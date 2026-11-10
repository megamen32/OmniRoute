import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getCliToken, CLI_TOKEN_HEADER } from "../../bin/cli/utils/cliToken.mjs";

// L33: names only. No credential, subscription, activation, or routing writes.
const root = resolve(import.meta.dirname, "../..");
const directory = resolve(root, "_tasks/research/2026-11-10-provider-account-names");
const base = "http://127.0.0.1:20128";
const mode = process.argv[2] || "preview";
assert(["preview", "apply", "verify"].includes(mode), "Unknown mode");
const stamp = () => new Date().toISOString();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = async (name) => JSON.parse(await fs.readFile(resolve(directory, name), "utf8"));
async function save(name, value, exclusive = false) {
  await fs.writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: exclusive ? "wx" : "w",
  });
}
const token = await getCliToken();
assert(token, "CLI authentication unavailable");
async function request(path, body) {
  if (body !== undefined) {
    assert.deepEqual(Object.keys(body), ["name"], "Only name may be submitted");
    assert(typeof body.name === "string" && body.name.length <= 200);
  }
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "PUT",
    headers: { [CLI_TOKEN_HEADER]: token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Management API HTTP ${response.status}`);
  return response.json();
}
async function connections() {
  const result = await request("/api/providers");
  assert(Array.isArray(result.connections));
  assert.equal(result.total, result.connections.length, "Incomplete account inventory");
  return result.connections;
}
const nameView = (c) => ({
  id: c.id,
  provider: c.provider,
  name: c.name ?? null,
  displayName: c.displayName ?? null,
});
function fullEmail(value) {
  return typeof value === "string" &&
    !/[*•…\s]/.test(value) &&
    /^[A-Za-z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
    ? value
    : null;
}
function slug(value) {
  return String(value)
    .replace(/\b20\d{2}[-/]\d{2}[-/]\d{2}\b/g, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}.@+-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 85);
}
function identity(c) {
  const p = c.providerSpecificData || {};
  for (const [source, value] of [
    ["connection.email", c.email],
    ["providerSpecificData.email", p.email],
    ["original.displayName", c.displayName],
  ]) {
    if (fullEmail(value)) return { value, email: value, source };
  }
  const original = c.name || "";
  // These two existing labels concatenate a known provider annotation to gmail.com.
  const annotated = original.replace(/(@gmail\.com)(?:opencode|zai)$/i, "$1");
  const candidates =
    annotated.match(/[A-Za-z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  if (candidates.length === 1 && fullEmail(candidates[0])) {
    return {
      value: candidates[0],
      email: candidates[0],
      source:
        annotated === original ? "original.name" : "original.name:provider-annotation-removed",
    };
  }
  const label =
    c.provider === "zcode" && p.family === "bigmodel"
      ? `BigModel-${p.userId || c.id.slice(0, 8)}`
      : slug(original) || `${slug(c.provider)}-${c.id.slice(0, 8)}`;
  return {
    value: `no-email-${label}`,
    email: null,
    source: "existing-account-identifier",
    ...(p.email ? { observedMaskedEmail: p.email } : {}),
    reason: "Полная почта не подтверждена; скрытый адрес не восстанавливался догадкой.",
  };
}
function plan(c) {
  const p = c.providerSpecificData || {};
  if (c.provider === "zcode")
    return { value: "Max", source: "explicit-owner-instruction:both-ZCode-accounts" };
  if (c.provider === "codex" && p.workspacePlanType) {
    const labels = { promax: "ProMax", plus: "Plus", pro: "Pro", free: "Free" };
    return {
      value: labels[p.workspacePlanType] || slug(p.workspacePlanType),
      source: "providerSpecificData.workspacePlanType",
      observed: p.workspacePlanType,
    };
  }
  if (c.provider === "claude" && p.organizationType === "claude_pro") {
    return {
      value: "Pro",
      source: "providerSpecificData.organizationType",
      observed: p.organizationType,
    };
  }
  return {
    value: "unknown",
    source: "unconfirmed",
    reason: "Тип API-ключа и фильтр бесплатных моделей не подтверждают тариф или PAYG.",
  };
}
function method(c) {
  const p = c.providerSpecificData || {};
  if (p.authMode === "pat")
    return {
      value: p.transport === "qodercli" ? "PAT-CLI" : "PAT",
      source: "providerSpecificData.authMode/transport",
    };
  if (c.provider === "chatgpt-web")
    return { value: "web-session", source: "provider-route:browser-storage-state-or-cookie" };
  return {
    value:
      { oauth: "OAuth", apikey: "apiKey", noauth: "noAuth" }[String(c.authType).toLowerCase()] ||
      slug(c.authType || "unknown"),
    source: "connection.authType",
  };
}
function unique(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.provider}:${e.after.name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      e.after.name = `${e.identity.value}_${e.plan.value}_${e.method.value}-${e.id.slice(0, 8)}`;
      e.collisionSuffix = e.id.slice(0, 8);
    }
  }
  assert.equal(
    new Set(entries.map((e) => `${e.provider}:${e.after.name.toLowerCase()}`)).size,
    entries.length
  );
  for (const e of entries) {
    assert(e.after.name.length <= 200);
    assert(!/\b20\d{2}-\d{2}-\d{2}\b/.test(e.after.name));
    assert(!e.after.name.includes("*"));
  }
}
const db = new Database(resolve(homedir(), ".omniroute/storage.sqlite"), {
  readonly: true,
  fileMustExist: true,
});
db.pragma("query_only = ON");
const statement = db.prepare("SELECT * FROM provider_connections WHERE id = ?");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}
function fingerprints(id) {
  const row = statement.get(id);
  assert(row, "Missing stored account");
  const metadata = JSON.parse(row.provider_specific_data || "{}");
  return {
    id,
    fields: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, digest(v)])),
    metadata: {
      hash: digest(canonical(metadata)),
      fields: Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [key, digest(canonical(value))])
      ),
    },
  };
}
function changed(before, after) {
  return [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].filter(
    (k) => before.fields[k] !== after.fields[k]
  );
}
const ledger = async (entry) =>
  fs.appendFile(
    resolve(directory, "operations.jsonl"),
    JSON.stringify({ at: stamp(), ...entry }) + "\n",
    { mode: 0o600 }
  );
try {
  if (mode === "preview") {
    const rows = await connections();
    const before = await read("before.json");
    assert.equal(rows.length, before.connections.length);
    const entries = rows.map((c) => {
      const original = before.connections.find((e) => e.id === c.id);
      assert.deepEqual(nameView(c), original, "Account names changed since original backup");
      const item = {
        id: c.id,
        provider: c.provider,
        before: original,
        identity: identity(c),
        plan: plan(c),
        method: method(c),
        importFreeModelsOnly: c.providerSpecificData?.importFreeModelsOnly ?? null,
      };
      return {
        ...item,
        after: {
          name: `${item.identity.value}_${item.plan.value}_${item.method.value}`,
          displayName: original.displayName,
        },
        payload: null,
      };
    });
    unique(entries);
    for (const e of entries) e.payload = { name: e.after.name };
    await save(
      "manifest.json",
      {
        createdAt: stamp(),
        task: "L33",
        endpoint: base,
        allowedWrites: ["name"],
        displayNamePolicy: "preserve: dashboard prefers name; update schema accepts name",
        entries,
      },
      true
    );
    await save(
      "protected-fingerprints-before.json",
      {
        capturedAt: stamp(),
        source: "read-only SQLite; SHA256 per stored column; no credential values",
        connections: rows.map((c) => fingerprints(c.id)),
      },
      true
    );
    console.log(
      JSON.stringify(
        {
          mode,
          total: entries.length,
          emailKnown: entries.filter((e) => e.identity.email).length,
          planKnown: entries.filter((e) => e.plan.value !== "unknown").length,
          entries: entries.map((e) => ({ id: e.id, provider: e.provider, name: e.after.name })),
        },
        null,
        2
      )
    );
  }
  if (mode === "apply") {
    const manifest = await read("manifest.json");
    const initial = await connections();
    assert.deepEqual(initial.map((c) => c.id).sort(), manifest.entries.map((e) => e.id).sort());
    let completed = 0;
    for (const e of manifest.entries) {
      const live = (await request(`/api/providers/${encodeURIComponent(e.id)}`)).connection;
      if (live.name === e.after.name) {
        await ledger({ id: e.id, event: "already-observed", name: live.name });
        completed++;
        continue;
      }
      assert.equal(live.name ?? null, e.before.name, "Foreign name change; mutation refused");
      assert.equal(live.displayName ?? null, e.before.displayName);
      const rawBefore = fingerprints(e.id);
      await ledger({
        id: e.id,
        event: "intent",
        method: "PUT",
        path: `/api/providers/${e.id}`,
        payload: e.payload,
        storedBefore: rawBefore,
      });
      let requestStatus = "accepted";
      try {
        await request(`/api/providers/${encodeURIComponent(e.id)}`, e.payload);
      } catch (error) {
        requestStatus = /^Management API HTTP \d+$/.test(error.message)
          ? error.message
          : "transport-unknown";
      }
      // A timeout never triggers a blind retry: establish the actual stored name first.
      const after = (await request(`/api/providers/${encodeURIComponent(e.id)}`)).connection;
      const rawAfter = fingerprints(e.id);
      const differences = changed(rawBefore, rawAfter);
      const metadataValuesPreserved = rawBefore.metadata.hash === rawAfter.metadata.hash;
      await ledger({
        id: e.id,
        event: "readback",
        requestStatus,
        observed: nameView(after),
        changedStoredColumns: differences,
        metadataValuesPreserved,
        storedAfter: rawAfter,
      });
      assert.equal(after.name, e.after.name, "Rename not confirmed; inspect ledger before retry");
      assert.equal(after.displayName ?? null, e.before.displayName);
      assert(
        differences.every(
          (k) =>
            ["name", "updated_at"].includes(k) ||
            (k === "provider_specific_data" && metadataValuesPreserved)
        ),
        `Additional stored changes observed: ${differences.join(",")}`
      );
      completed++;
      console.log(
        JSON.stringify({ completed, total: manifest.entries.length, id: e.id, name: after.name })
      );
    }
    console.log(JSON.stringify({ mode, completed, total: manifest.entries.length }));
  }
  if (mode === "verify") {
    const manifest = await read("manifest.json");
    const rows = await connections();
    const initial = await read("protected-fingerprints-before.json");
    assert.deepEqual(rows.map((c) => c.id).sort(), manifest.entries.map((e) => e.id).sort());
    const after = {
      capturedAt: stamp(),
      source: "authenticated management GET /api/providers",
      total: rows.length,
      connections: rows.map(nameView),
    };
    await save("after.json", after);
    const results = manifest.entries.map((e) => {
      const row = rows.find((c) => c.id === e.id);
      const differences = changed(
        initial.connections.find((c) => c.id === e.id),
        fingerprints(e.id)
      );
      return {
        id: e.id,
        provider: e.provider,
        nameMatches: row.name === e.after.name,
        displayNamePreserved: (row.displayName ?? null) === e.before.displayName,
        importFreeModelsOnlyPreserved:
          (row.providerSpecificData?.importFreeModelsOnly ?? null) === e.importFreeModelsOnly,
        changedStoredColumns: differences,
      };
    });
    const checks = {
      allAccountsPresent: true,
      allNamesMatch: results.every((e) => e.nameMatches),
      displayNamesPreserved: results.every((e) => e.displayNamePreserved),
      freeModelFiltersPreserved: results.every((e) => e.importFreeModelsOnlyPreserved),
      namesUniqueWithinProvider:
        new Set(rows.map((c) => `${c.provider}:${c.name.toLowerCase()}`)).size === rows.length,
      storedColumnsOnlyNamesAndTimestamps: results.every((e) =>
        e.changedStoredColumns.every((k) => ["name", "updated_at"].includes(k))
      ),
    };
    const report = {
      verifiedAt: stamp(),
      task: "L33",
      total: rows.length,
      checks,
      knownEmails: manifest.entries.filter((e) => e.identity.email).length,
      unknownIdentities: manifest.entries
        .filter((e) => !e.identity.email)
        .map((e) => ({ id: e.id, provider: e.provider, identity: e.identity })),
      unknownPlans: manifest.entries
        .filter((e) => e.plan.value === "unknown")
        .map((e) => ({ id: e.id, provider: e.provider, name: e.after.name })),
      results,
    };
    await save("verification.json", report);
    console.log(
      JSON.stringify(
        {
          mode,
          total: rows.length,
          checks,
          unknownIdentities: report.unknownIdentities.length,
          unknownPlans: report.unknownPlans.length,
        },
        null,
        2
      )
    );
    assert(Object.values(checks).every(Boolean), "Verification requires investigation");
  }
} finally {
  db.close();
}
