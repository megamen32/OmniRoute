import test from "node:test";
import assert from "node:assert/strict";
import { ZcodeAuthCooldown } from "../../open-sse/executors/zcode/authCooldown.ts";

test("expired auth suppresses repeats and admits one recovery probe", () => {
  let now = 1000;
  const gate = new ZcodeAuthCooldown(() => now, 300_000);
  assert.equal(gate.acquire("old"), true);
  gate.settle("old", 401);
  for (let i = 0; i < 100; i++) assert.equal(gate.acquire("old"), false);
  assert.equal(gate.acquire("new-credential"), true);
  now += 300_000;
  assert.equal(gate.acquire("old"), true);
  assert.equal(gate.acquire("old"), false);
  gate.settle("old", 401);
  assert.equal(gate.acquire("old"), false);
  now += 30_000_000;
  assert.equal(gate.acquire("old"), false);
  assert.equal(gate.acquire("refreshed"), true);
  gate.settle("refreshed", 200);
  assert.equal(gate.acquire("refreshed"), true);
});

test("failed/cancelled recovery is released with bounded retry, not stuck or storming", () => {
  let now = 0;
  const gate = new ZcodeAuthCooldown(() => now);
  gate.settle("one", 401);
  now = 300_000;
  assert.equal(gate.acquire("one"), true);
  gate.settle("one", 499);
  assert.equal(gate.acquire("one"), false);
  now += 30_000;
  assert.equal(gate.acquire("one"), true);
});

test("transient status on fresh auth does not invent an auth lockout", () => {
  const gate = new ZcodeAuthCooldown();
  for (const status of [403, 404, 429, 500]) {
    gate.settle("healthy", status);
    assert.equal(gate.acquire("healthy"), true);
  }
});
