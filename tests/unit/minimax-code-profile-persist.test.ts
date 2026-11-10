import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistProfileCredential,
  readAuthProfile,
} from "../../open-sse/executors/minimaxCodeGateway.ts";
import { resolvePublicCred } from "../../open-sse/utils/publicCreds.ts";

test("profile persistence preserves records and backups and advances the CLI state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minimax-persist-"));
  const path = join(dir, "auth.json");
  const statePath = join(dir, "auth-state.json");
  try {
    const first = { accessToken: "old", refreshToken: "old-refresh", generation: 2, extra: "kept" };
    const backup = { accessToken: "older", generation: 3 };
    const other = { accessToken: "other", generation: 10 };
    await writeFile(
      path,
      JSON.stringify({ extra: true, records: { first, "first\u0000previous": backup, other } })
    );
    await writeFile(statePath, JSON.stringify({ generation: 20, status: "expired", extra: true }));
    const result = await persistProfileCredential({ path, accessToken: "new", expiresAtMs: 12345 });
    const doc = JSON.parse(await readFile(path, "utf8"));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(result.replacedAccount, true);
    assert.equal(result.generation, 21);
    assert.equal(result.clientId, resolvePublicCred("minimax_id"));
    assert.equal((await readAuthProfile(path))?.accessToken, "new");
    assert.equal(doc.records.first.refreshToken, undefined);
    assert.equal(doc.records.first.extra, "kept");
    assert.deepEqual(doc.records["first\u0000previous"], backup);
    assert.deepEqual(doc.records["first\u0000previous\u0000previous"], first);
    assert.deepEqual(doc.records.other, other);
    assert.deepEqual(state, {
      generation: 21,
      status: "authenticated",
      extra: true,
      expiresAtMs: 12345,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent sign-ins advance generations and preserve each replaced credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minimax-persist-"));
  const path = join(dir, "auth.json");
  try {
    const [first, second] = await Promise.all([
      persistProfileCredential({ path, accessToken: "one" }),
      persistProfileCredential({ path, accessToken: "two" }),
    ]);
    assert.equal(second.generation, first.generation + 1);
    const doc = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(
      Object.values(doc.records).map((record) => (record as { accessToken: string }).accessToken),
      ["two", "one"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
