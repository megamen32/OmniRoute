import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs gate module has no type declarations
import { findUnapprovedDeps, discoverManifests } from "../../scripts/check/check-deps.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("no unapproved deps when all are allowlisted", () => {
  assert.deepEqual(findUnapprovedDeps(["react", "next"], new Set(["react", "next", "zod"])), []);
});

test("flags a dependency not on the allowlist (potential slopsquat)", () => {
  assert.deepEqual(
    findUnapprovedDeps(["react", "reactt-router"], new Set(["react"])),
    ["reactt-router"]
  );
});

test("flags multiple new deps, preserves order, de-dupes", () => {
  assert.deepEqual(
    findUnapprovedDeps(["a", "b", "a", "c"], new Set(["a"])),
    ["b", "c"]
  );
});

// --- 6A.8: automatic workspace discovery ---

test("6A.8: discoverManifests finds root and workspace package.json files", () => {
  const manifests = discoverManifests(repoRoot);
  // Must include the root
  assert.ok(manifests.includes("package.json"), "root package.json must be included");
  // Must include known workspaces
  assert.ok(manifests.includes("electron/package.json"), "electron/package.json must be included");
  assert.ok(manifests.includes("open-sse/package.json"), "open-sse/package.json must be included");
  assert.ok(
    manifests.includes("@omniroute/opencode-plugin/package.json"),
    "@omniroute/opencode-plugin/package.json must be included"
  );
  assert.ok(
    manifests.includes("@omniroute/opencode-provider/package.json"),
    "@omniroute/opencode-provider/package.json must be included"
  );
});

test("6A.8: discoverManifests does NOT include node_modules, .next, or deep reference dirs", () => {
  const manifests = discoverManifests(repoRoot);
  for (const m of manifests) {
    assert.ok(!m.includes("node_modules"), `should not include node_modules: ${m}`);
    assert.ok(!m.includes(".next"), `should not include .next: ${m}`);
    assert.ok(!m.includes("_references"), `should not include _references: ${m}`);
    assert.ok(!m.includes("_mono_repo"), `should not include _mono_repo: ${m}`);
    assert.ok(!m.includes(".build"), `should not include .build: ${m}`);
    assert.ok(!m.includes(".claude"), `should not include .claude: ${m}`);
    assert.ok(!m.includes("dist-electron"), `should not include dist-electron: ${m}`);
  }
});

test("6A.8: all workspace package deps are in the allowlist (gate exits 0 with expanded scope)", () => {
  const allowlistPath = path.join(repoRoot, "dependency-allowlist.json");
  const allowlist = new Set(JSON.parse(fs.readFileSync(allowlistPath, "utf8")).allowed || []);
  const manifests = discoverManifests(repoRoot);
  const allDeps: string[] = [];
  for (const rel of manifests) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const pkg = JSON.parse(fs.readFileSync(abs, "utf8"));
    allDeps.push(
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {})
    );
  }
  const unapproved = findUnapprovedDeps(allDeps, allowlist);
  assert.deepEqual(unapproved, [], `expected all deps to be approved, got: ${unapproved.join(", ")}`);
});

// --- 6A.8: stale-allowlist enforcement ---
// @ts-expect-error — reportStaleEntries from mjs
import { reportStaleEntries } from "../../scripts/check/lib/allowlist.mjs";

test("6A.8 stale: a dep removed from all manifests is detected as stale in allowlist", () => {
  // Simulate: allowlist has "removed-lib" but no manifest uses it.
  const stale = (reportStaleEntries as (a: string[], b: string[], c: string) => string[])(
    ["removed-lib", "react"],
    ["react"], // only "react" is live
    "check-deps"
  );
  assert.deepEqual(stale, ["removed-lib"]);
});
