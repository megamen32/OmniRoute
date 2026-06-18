import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type LockPackage = { version?: string };
type PackageLock = { packages?: Record<string, LockPackage> };

function readElectronPackageLock(): PackageLock {
  return JSON.parse(readFileSync("electron/package-lock.json", "utf8")) as PackageLock;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part));
  const right = b.split(".").map((part) => Number(part));

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;

    if (leftPart !== rightPart) return leftPart - rightPart;
  }

  return 0;
}

test("Electron package lock keeps audit-fixed dependency versions", () => {
  const lock = readElectronPackageLock();

  assert.ok(lock.packages, "electron/package-lock.json must include package entries");

  const formData = lock.packages["node_modules/form-data"]?.version;
  const jsYaml = lock.packages["node_modules/js-yaml"]?.version;

  assert.ok(formData, "form-data must be present in electron/package-lock.json");
  assert.ok(jsYaml, "js-yaml must be present in electron/package-lock.json");

  assert.ok(
    compareVersions(formData, "4.0.4") >= 0,
    `form-data must stay on the audit-fixed line; found ${formData}`
  );
  assert.ok(
    compareVersions(jsYaml, "4.2.0") >= 0,
    `js-yaml must stay on the audit-fixed line; found ${jsYaml}`
  );
});
