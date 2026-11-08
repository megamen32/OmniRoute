import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("installation identity survives process restart and differs between databases", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-identity-"));
  const readIdentity = (dataDir: string) => {
    const script = `import { getZcodeInstallationDeviceId } from "./src/lib/db/zcodeIdentity.ts";
      process.stdout.write("IDENTITY=" + getZcodeInstallationDeviceId() + "\\n");`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATA_DIR: dataDir },
        encoding: "utf8",
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const match = child.stdout.match(/^IDENTITY=([0-9a-f-]{36})$/m);
    assert.ok(match, "child must return a UUID identity");
    return match[1];
  };
  try {
    const first = readIdentity(join(root, "a"));
    const restarted = readIdentity(join(root, "a"));
    const other = readIdentity(join(root, "b"));
    assert.equal(first, restarted);
    assert.notEqual(first, other);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
