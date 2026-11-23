import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncZcodeModels } from "../../scripts/ops/sync-zcode-opencode-models.mjs";

test("publishes live models pinned to the selected account and keeps the last catalog on error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auto-catalog-"));
  t.after(() => rm(dir, { recursive: true }));
  const manifest = join(dir, "models.json");
  const route = "zcode-native/glm-future";
  const conflictName = "zcode-native/conflict";
  const combos = [
    { name: "opencode-glm-5.3-native-api", models: [{ model: "zcode-start/glm-5.3" }] },
    { name: conflictName, models: [{ model: "glm/conflict" }] },
  ];
  let created = 0;
  let unavailable = false;
  let models = [
    { id: "glm-future", name: "GLM-Future", contextLength: 1000000, maxOutputTokens: 128000 },
    { id: "conflict", name: "Conflict" },
  ];
  const request = async (path, body) => {
    if (path.includes("catalog=zcode-individual")) {
      assert(path.includes("/selected/"));
      if (unavailable) throw new Error("catalog unavailable");
      return { provider: "zcode-individual", connectionId: "selected", models };
    }
    if (path.startsWith("/api/combos?")) return { combos, total: combos.length };
    if (path === "/api/combos") {
      created++;
      combos.push(body);
      return { id: "new-combo" };
    }
    assert.equal(path, "/api/combos/new-combo");
    return combos.at(-1);
  };
  const params = { connectionId: "selected", manifest, request };
  const first = await syncZcodeModels(params);
  assert.deepEqual(first.added, [route]);
  assert.deepEqual(first.conflicts, [conflictName]);
  assert.equal(combos.at(-1).models[0].connectionId, "selected");
  assert.equal(combos.at(-1).models[0].model, "zcode-individual/glm-future");
  const snapshot = await readFile(manifest, "utf8");
  assert.deepEqual(JSON.parse(snapshot), [
    {
      id: route,
      name: "GLM-Future · ZCode Individual",
      limit: { context: 1000000, output: 128000 },
    },
  ]);
  const { ino } = await stat(manifest);
  assert.deepEqual((await syncZcodeModels(params)).added, []);
  assert.equal((await stat(manifest)).ino, ino);
  assert.equal(created, 1);
  unavailable = true;
  await assert.rejects(syncZcodeModels(params), /catalog unavailable/);
  assert.equal(await readFile(manifest, "utf8"), snapshot);
  unavailable = false;
  models = [{ id: "conflict", name: "Conflict" }];
  await syncZcodeModels(params);
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), []);
  assert.equal(combos[0].models[0].model, "zcode-start/glm-5.3");
});
