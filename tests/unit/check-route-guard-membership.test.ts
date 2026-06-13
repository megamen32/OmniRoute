import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  routeFileToApiPath,
  findUnclassifiedSpawnRoutes,
  isSpawnCapableSource,
  findSpawnCapableRoutes,
  KNOWN_UNCLASSIFIED_SOURCE_SPAWN,
} from "../../scripts/check/check-route-guard-membership.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Synthetic isLocalOnlyPath: classifies anything under the three spawn-capable
// prefixes via startsWith. Mirrors the real predicate's prefix semantics without
// importing routeGuard.ts (keeps this test DB-free / pure).
const SYNTHETIC_PREFIXES = ["/api/mcp/", "/api/cli-tools/runtime/", "/api/services/"];
const isLocalOnly = (path: string): boolean =>
  SYNTHETIC_PREFIXES.some((p) => path === p || path.startsWith(p));

test("routeFileToApiPath maps a Next App Router route.ts to its URL path", () => {
  assert.equal(
    routeFileToApiPath("src/app/api/services/9router/install/route.ts"),
    "/api/services/9router/install"
  );
});

test("routeFileToApiPath resolves dynamic [param] segments to a concrete placeholder", () => {
  assert.equal(
    routeFileToApiPath("src/app/api/services/[name]/logs/route.ts"),
    "/api/services/_name_/logs"
  );
  assert.equal(
    routeFileToApiPath("src/app/api/cli-tools/runtime/[toolId]/route.ts"),
    "/api/cli-tools/runtime/_toolId_"
  );
});

test("no unclassified routes when every spawn-capable route is local-only", () => {
  const routes = [
    "/api/mcp/tools",
    "/api/services/9router/start",
    "/api/cli-tools/runtime/_toolId_",
  ];
  assert.deepEqual(findUnclassifiedSpawnRoutes(routes, isLocalOnly, {}), []);
});

test("flags a spawn-capable route that is NOT classified local-only (RCE-via-tunnel gap)", () => {
  // Synthetic predicate that forgot to cover /api/services/ — the exact regression
  // this gate guards against.
  const leaky = (path: string): boolean => path.startsWith("/api/mcp/");
  assert.deepEqual(
    findUnclassifiedSpawnRoutes(
      ["/api/mcp/tools", "/api/services/cliproxy/install"],
      leaky,
      {}
    ),
    ["/api/services/cliproxy/install"]
  );
});

test("allowlisted routes are not flagged (frozen pre-existing exceptions)", () => {
  const leaky = (path: string): boolean => path.startsWith("/api/mcp/");
  assert.deepEqual(
    findUnclassifiedSpawnRoutes(
      ["/api/mcp/tools", "/api/services/legacy/route"],
      leaky,
      { "/api/services/legacy/route": "frozen pre-existing exception" }
    ),
    []
  );
});

test("flags multiple unclassified routes, preserves input order", () => {
  const leaky = (): boolean => false;
  assert.deepEqual(
    findUnclassifiedSpawnRoutes(["/api/services/a", "/api/mcp/b", "/api/services/c"], leaky, {}),
    ["/api/services/a", "/api/mcp/b", "/api/services/c"]
  );
});

// --- 6A.8: new subcheck — source-based spawn detection ---

test("6A.8 isSpawnCapableSource: detects child_process import in route source", () => {
  const src = `import { execFile } from "child_process";\nexport async function GET() {}`;
  assert.ok(isSpawnCapableSource(src), "should detect child_process import");
});

test("6A.8 isSpawnCapableSource: detects node:child_process import", () => {
  const src = `import { execFileSync } from "node:child_process";\nexport async function GET() {}`;
  assert.ok(isSpawnCapableSource(src), "should detect node:child_process import");
});

test("6A.8 isSpawnCapableSource: detects worker_threads import", () => {
  const src = `import { Worker } from "worker_threads";\nexport async function GET() {}`;
  assert.ok(isSpawnCapableSource(src), "should detect worker_threads import");
});

test("6A.8 isSpawnCapableSource: detects spawn( in source", () => {
  const src = `const { spawn } = require("child_process");\nspawn("npm", ["install"]);`;
  assert.ok(isSpawnCapableSource(src), "should detect spawn(");
});

test("6A.8 isSpawnCapableSource: returns false for normal route source", () => {
  const src = `import { NextResponse } from "next/server";\nexport async function GET() { return NextResponse.json({}); }`;
  assert.ok(!isSpawnCapableSource(src), "should not flag normal route");
});

test("6A.8 findSpawnCapableRoutes: detects real spawn-capable route.ts files", () => {
  // system/version and db-backups/exportAll are known spawn-capable outside SPAWN_CAPABLE_ROUTE_ROOTS
  const knownSpawnRoutes = [
    "src/app/api/system/version/route.ts",
    "src/app/api/db-backups/exportAll/route.ts",
  ];
  const found = findSpawnCapableRoutes(repoRoot);
  for (const r of knownSpawnRoutes) {
    assert.ok(found.includes(r), `expected ${r} in spawn-capable routes, found: ${found.join(", ")}`);
  }
});

test("6A.8: KNOWN_UNCLASSIFIED_SOURCE_SPAWN freezes the pre-existing spawn-capable routes outside protected roots", () => {
  // These routes were discovered by 6A.8's source-scan (direct child_process/worker_threads
  // imports) and are known security debt. TODO(6A.8): add to LOCAL_ONLY_API_PREFIXES.
  // Note: cli-tools/antigravity-mitm/route.ts uses child_process via INDIRECT dynamic
  // import (not a direct import) so it is NOT captured by the source-scan.
  const preExisting = [
    "src/app/api/system/version/route.ts",
    "src/app/api/db-backups/exportAll/route.ts",
  ];
  for (const r of preExisting) {
    assert.ok(
      r in KNOWN_UNCLASSIFIED_SOURCE_SPAWN,
      `expected KNOWN_UNCLASSIFIED_SOURCE_SPAWN to contain pre-existing: ${r}`
    );
  }
  assert.equal(Object.keys(KNOWN_UNCLASSIFIED_SOURCE_SPAWN).length, 2, "expected exactly 2 frozen entries");
});

test("6A.8: spawn-capable routes in SPAWN_CAPABLE_ROUTE_ROOTS are still all classified local-only", async () => {
  // The original subcheck (SPAWN_CAPABLE_ROUTE_ROOTS) must still pass.
  // This test is a regression guard — the new source-scan does not break the old check.
  const { isLocalOnlyPath } = await import("../../src/server/authz/routeGuard.ts");
  const rootPrefixes = ["/api/services/", "/api/mcp/", "/api/cli-tools/runtime/"];
  for (const prefix of rootPrefixes) {
    assert.ok(isLocalOnlyPath(prefix + "test"), `expected ${prefix} to be local-only`);
  }
});
