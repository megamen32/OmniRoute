import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncZcodeModels } from "../../scripts/ops/sync-zcode-opencode-models.mjs";

test("adds an undiscovered pinned model once and leaves manual entries and config symlink intact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auto-catalog-"));
  t.after(() => rm(dir, { recursive: true }));
  const actual = join(dir, "settings.jsonc");
  const configFile = join(dir, "opencode.jsonc");
  const original = JSON.stringify(
    {
      model: "original",
      providers: {
        omniroute: {
          models: {
            "opencode-glm-5.3-native-api": { name: "Manual entry" },
          },
        },
      },
    },
    null,
    2
  );
  await writeFile(actual, "// preserve comment\n" + original, { mode: 0o600 });
  await symlink(actual, configFile);
  let created = 0;
  let combo;
  let unavailable = false;
  const request = async (path, body) => {
    if (path.includes("catalog=zcode-individual")) {
      assert(path.includes("/selected/"));
      if (unavailable) throw new Error("catalog unavailable");
      return {
        provider: "zcode-individual",
        connectionId: "selected",
        models: [
          { id: "glm-5.3", name: "GLM-5.3" },
          { id: "glm-future", name: "GLM-Future", contextLength: 1000000, maxOutputTokens: 128000 },
          { id: "conflict", name: "Conflict" },
        ],
      };
    }
    if (path.startsWith("/api/combos?"))
      return {
        combos: [{ name: "opencode-conflict-native-api", models: [{ model: "glm/conflict" }] }],
        total: 1,
      };
    if (path === "/api/combos") {
      created++;
      combo = body;
      return { id: "new-combo" };
    }
    assert.equal(path, "/api/combos/new-combo");
    return combo;
  };
  const params = { connectionId: "selected", configFile, request };
  const first = await syncZcodeModels(params);
  assert.deepEqual(first.added, ["opencode-glm-future-native-api"]);
  assert.deepEqual(first.conflicts, ["opencode-conflict-native-api"]);
  assert.equal(combo.models[0].connectionId, "selected");
  assert.equal(combo.models[0].model, "zcode-individual/glm-future");
  const changed = await readFile(configFile, "utf8");
  assert.match(changed, /preserve comment/);
  assert.match(changed, /Manual entry/);
  assert.match(changed, /"model": "original"/);
  assert.match(changed, /"output": 128000/);
  assert.deepEqual((await syncZcodeModels(params)).added, []);
  assert.equal(created, 1);
  unavailable = true;
  await assert.rejects(syncZcodeModels(params), /catalog unavailable/);
  assert.equal(await readFile(actual, "utf8"), changed);
});
