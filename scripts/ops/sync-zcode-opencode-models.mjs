import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const require = createRequire(join(process.cwd(), "package.json"));
const jsonc = require("jsonc-parser");

/** Keep the existing short aliases and a unique stable name for long provider IDs. */
function comboName(id) {
  const name = "opencode-" + id + "-native-api";
  if (name.length <= 100) return name;
  return name.slice(0, 83) + "-" + createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function modelEntry(model, alias) {
  const entry = { modelID: alias, name: model.name + " · ZCode Individual" };
  if (
    Number.isSafeInteger(model.contextLength) &&
    model.contextLength > 0 &&
    Number.isSafeInteger(model.maxOutputTokens) &&
    model.maxOutputTokens > 0
  ) {
    entry.limit = { context: model.contextLength, output: model.maxOutputTokens };
  }
  return entry;
}

async function listCombos(request) {
  const result = new Map();
  let offset = 0;
  for (;;) {
    const { combos, total } = await request("/api/combos?limit=200&offset=" + offset);
    assert(
      Array.isArray(combos) && Number.isSafeInteger(total) && total >= 0,
      "Invalid combo list"
    );
    for (const combo of combos) result.set(combo.name, combo);
    offset += combos.length;
    if (offset >= total) return result;
    assert(combos.length > 0, "Incomplete combo list");
  }
}

function matches(combo, target) {
  const [actual] = combo?.models || [];
  return (
    combo?.isActive !== false &&
    combo?.models?.length === 1 &&
    actual?.model === target.model &&
    actual?.providerId === target.providerId &&
    actual?.connectionId === target.connectionId
  );
}

export async function syncZcodeModels({ connectionId, configFile, request }) {
  const catalog = await request(
    "/api/providers/" + encodeURIComponent(connectionId) + "/models?catalog=zcode-individual"
  );
  assert.equal(catalog.connectionId, connectionId);
  assert(["zcode-individual", "zcode-cn-individual"].includes(catalog.provider));
  assert(Array.isArray(catalog.models) && catalog.models.length > 0, "ZCode catalog is empty");
  const configPath = await realpath(configFile);
  const original = await readFile(configPath, "utf8");
  const errors = [];
  const config = jsonc.parse(original, errors);
  assert.deepEqual(errors, [], "Invalid OpenCode JSONC");
  const models = config.providers?.omniroute?.models;
  assert(
    models && typeof models === "object" && !Array.isArray(models),
    "OpenCode's OmniRoute provider is missing"
  );
  let updated = original;
  let combos;
  const discovered = new Set();
  const added = [];
  const conflicts = [];
  for (const model of catalog.models) {
    assert(/^[a-z0-9][a-z0-9._-]{0,119}$/.test(model.id), "Invalid ZCode model ID");
    assert(
      typeof model.name === "string" && model.name.toLowerCase() === model.id,
      "Invalid ZCode model name"
    );
    if (discovered.has(model.id)) continue;
    discovered.add(model.id);
    const alias = comboName(model.id);
    if (Object.hasOwn(models, alias)) continue;
    combos ??= await listCombos(request);
    const target = {
      kind: "model",
      providerId: catalog.provider,
      model: catalog.provider + "/" + model.id,
      connectionId,
      weight: 1,
    };
    let combo = combos.get(alias);
    if (combo && !matches(combo, target)) {
      conflicts.push(alias);
      continue;
    }
    if (!combo) {
      const created = await request("/api/combos", {
        name: alias,
        displayName: modelEntry(model, alias).name,
        description: "Discovered from the selected ZCode Individual account.",
        strategy: "priority",
        ...(Number.isSafeInteger(model.contextLength) && model.contextLength > 0
          ? { context_length: model.contextLength }
          : {}),
        models: [target],
        config: { maxRetries: 0, maxSetRetries: 0, disableSessionStickiness: true },
      });
      assert(typeof created.id === "string" && created.id, "OmniRoute did not return a combo ID");
      combo = await request("/api/combos/" + encodeURIComponent(created.id));
      assert.equal(combo.name, alias);
      assert(matches(combo, target), "OmniRoute did not persist the selected account/model");
      combos.set(alias, combo);
    }
    const entry = modelEntry(model, alias);
    updated = jsonc.applyEdits(
      updated,
      jsonc.modify(updated, ["providers", "omniroute", "models", alias], entry, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    );
    models[alias] = entry;
    added.push(alias);
  }
  if (added.length) {
    assert.deepEqual(jsonc.parse(updated), config, "OpenCode config did not round-trip");
    const mode = (await lstat(configPath)).mode & 0o777;
    const temporary = configPath + ".zcode-" + randomUUID();
    try {
      await writeFile(temporary, updated, { mode, flag: "wx" });
      assert.equal(
        await readFile(configPath, "utf8"),
        original,
        "OpenCode configuration changed during sync"
      );
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return {
    at: new Date().toISOString(),
    provider: catalog.provider,
    discovered: [...discovered],
    added,
    conflicts,
  };
}

async function main() {
  const data = join(homedir(), ".omniroute");
  const { values } = parseArgs({
    options: {
      policy: { type: "string" },
      config: { type: "string", default: join(homedir(), ".config/opencode/opencode.jsonc") },
      port: { type: "string", default: "20128" },
      receipt: { type: "string" },
    },
  });
  assert(values.policy, "--policy is required");
  assert(
    /^[1-9][0-9]{0,4}$/.test(values.port) && Number(values.port) <= 65535,
    "Invalid loopback port"
  );
  const { max } = JSON.parse(await readFile(values.policy, "utf8"));
  assert(
    typeof max === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(max),
    "Invalid ZCode connection ID"
  );
  const { OMNIROUTE_API_KEY } = parseEnv(await readFile(join(data, ".env"), "utf8"));
  assert(OMNIROUTE_API_KEY, "OmniRoute management credential unavailable");
  const origin = "http://127.0.0.1:" + values.port;
  const request = async (path, body) => {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: { authorization: "Bearer " + OMNIROUTE_API_KEY, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    assert(
      r.ok,
      "OmniRoute " +
        path.replace(/\/providers\/[^/]+/, "/providers/<account>") +
        " returned HTTP " +
        r.status
    );
    return r.json();
  };
  const result = await syncZcodeModels({ connectionId: max, configFile: values.config, request });
  if (values.receipt) {
    await mkdir(dirname(values.receipt), { recursive: true, mode: 0o700 });
    const temp = values.receipt + "." + process.pid;
    await writeFile(temp, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, values.receipt);
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("ZCode catalog sync failed:", error.message);
    process.exitCode = 1;
  });
}
