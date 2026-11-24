import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { markServerStarting, markServerStopping } from "../../src/lib/serverLifecycle.ts";

// The shutdown sequence closes the database and the process keeps running for a
// moment. A lingering callback (batch flush, scheduler tick) used to re-open
// the connection through getDbInstance(), which re-ran the whole startup path
// (migrations check, cache size, health check) on a multi-GB database while
// the instance was stopping. The instance then stayed alive until systemd
// killed it after TimeoutStopUSec, leaving the port closed for the whole
// window — the fleet saw "connection refused".

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  NEXT_PHASE: process.env.NEXT_PHASE,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  APPDATA: process.env.APPDATA,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function cleanupGlobalDb() {
  try {
    if (globalThis.__omnirouteDb?.open) globalThis.__omnirouteDb.close();
  } catch {}
  delete globalThis.__omnirouteDb;
}

test("the database is not re-opened once the instance is stopping", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-shutdown-no-reopen-"));
  const file = path.join(dir, "storage.sqlite");
  const raw = new Database(file);
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

  const previousPhase = globalThis.__omnirouteServerLifecycle;
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  markServerStarting();

  // Load the module fresh so it picks up the temporary DATA_DIR.
  const coreUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "../../src/lib/db/core.ts")
  ).href;
  const core = await import(`${coreUrl}?shutdown_no_reopen=${Date.now()}`);

  try {
    const opened = core.getDbInstance();
    assert.equal(opened.open, true, "the database opens normally while running");

    // Simulate the shutdown: the connection is closed and the handle dropped.
    core.closeDbInstance();
    assert.equal(globalThis.__omnirouteDb, undefined, "the handle is released on close");

    // A lingering callback now asks for the database again.
    markServerStopping();
    assert.throws(
      () => core.getDbInstance(),
      /closed during shutdown/i,
      "the database must stay closed while the instance is stopping"
    );
    assert.equal(
      globalThis.__omnirouteDb,
      undefined,
      "no new connection is created during shutdown"
    );
  } finally {
    cleanupGlobalDb();
    markServerStarting();
    if (previousPhase === undefined) delete globalThis.__omnirouteServerLifecycle;
    else globalThis.__omnirouteServerLifecycle = previousPhase;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    restoreEnv();
    try {
      raw.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
