import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as helper from "../../scripts/ad-hoc/patch-zcode-timeout-artifact-20261110.mjs";

const account = "a".repeat(64),
  other = "b".repeat(64);
const prefs = {
  providerFamilyDomain: "zai",
  providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
};
const grantFiles = ["cipher-secret", "account.json", ".zcode/v2/credentials.json"];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "zcode-profile-helper-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "native-state"),
    archive = join(directory, "archives", "one-reset");
  mkdirSync(root, { mode: 0o700 });
  for (const name of [account, other]) {
    mkdirSync(join(root, name, ".zcode", "v2"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, name, ".zcode", "v2", "setting.json"),
      JSON.stringify({ ...prefs, mcpServers: { old: {} }, plugins: ["old"] }),
      { mode: 0o600 }
    );
    for (const file of grantFiles)
      writeFileSync(
        join(root, name, file),
        Buffer.from(`${name}:${file}\n\u0000native-refreshed-grant`),
        { mode: 0o600 }
      );
    writeFileSync(join(root, name, ".zcode/v2/telemetry-state.json"), '{"install":"fixture"}\n', {
      mode: 0o600,
    });
    writeFileSync(join(root, name, ".zcode/v2/tasks-index.sqlite"), "old tasks");
  }
  const s = statSync(root);
  return { directory, root, archive, expectedInode: `${s.dev}:${s.ino}` };
}
function reset(f, checkStopped = () => {}) {
  const state = helper.planNativeProfileReset(f);
  helper.moveNativeProfiles(state, checkStopped);
  return state;
}
test("reset requires stopped service and keeps all bytes and root inode in private external archive", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      reset(f, () => {
        throw Error("still running");
      }),
    /still running/
  );
  assert.equal(readdirSync(f.root).length, 2);
  assert.equal(readdirSync(f.directory).length, 1);
  const state = reset(f);
  assert.deepEqual(readdirSync(f.root).sort(), [account, other]);
  const s = statSync(f.root);
  assert.equal(`${s.dev}:${s.ino}`, f.expectedInode);
  assert.equal(statSync(f.archive).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.archive, "reset.json")).mode & 0o777, 0o600);
  for (const name of [account, other]) {
    assert.match(
      readFileSync(join(f.archive, "profiles", name, ".zcode/v2/setting.json"), "utf8"),
      /mcpServers/
    );
    for (const file of [...grantFiles, ".zcode/v2/telemetry-state.json"]) {
      assert.deepEqual(
        readFileSync(join(f.root, name, file)),
        readFileSync(join(f.archive, "profiles", name, file))
      );
      assert.equal(statSync(join(f.root, name, file)).mode & 0o777, 0o600);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, name, ".zcode/v2/setting.json"))), prefs);
    assert.deepEqual(readdirSync(join(f.root, name, ".zcode/v2")).sort(), [
      "credentials.json",
      "setting.json",
      "telemetry-state.json",
    ]);
  }
  assert.equal(state.phase, "seeded");
  assert.equal(state.entries.length, 2);
});
test("rollback restores only journaled own moves with CAS and does not replay", (t) => {
  const f = fixture(t),
    state = reset(f);
  assert.equal(helper.rollbackNativeProfiles(state, () => {}).restored, true);
  assert.deepEqual(readdirSync(f.root).sort(), [account, other]);
  assert.equal(helper.rollbackNativeProfiles(state, () => {}).restored, true);
  assert.match(readFileSync(join(f.root, account, ".zcode/v2/setting.json"), "utf8"), /mcpServers/);
  assert.equal(
    readFileSync(join(f.root, account, ".zcode/v2/tasks-index.sqlite"), "utf8"),
    "old tasks"
  );
});
test("rollback preserves unknown new profiles and unchanged archive on conflict", (t) => {
  const f = fixture(t),
    state = reset(f);
  writeFileSync(join(f.root, account, "new-state"), "keep");
  writeFileSync(join(f.root, "unknown"), "keep-too");
  const result = helper.rollbackNativeProfiles(state, () => {});
  assert.equal(result.restored, false);
  assert.deepEqual(
    result.conflicts.map((c) => c.name),
    [account]
  );
  assert.equal(readFileSync(join(f.root, account, "new-state"), "utf8"), "keep");
  assert.equal(readFileSync(join(f.root, "unknown"), "utf8"), "keep-too");
  assert.match(
    readFileSync(join(f.archive, "profiles", account, ".zcode/v2/setting.json"), "utf8"),
    /mcpServers/
  );
  assert.equal(statSync(join(f.root, other)).isDirectory(), true);
});
test("rollback refuses changed archived content instead of restoring it", (t) => {
  const f = fixture(t),
    state = reset(f);
  writeFileSync(join(f.archive, "profiles", account, ".zcode", "v2", "setting.json"), "changed");
  const result = helper.rollbackNativeProfiles(state, () => {});
  assert.equal(result.restored, false);
  assert.deepEqual(
    result.conflicts.map((c) => c.name),
    [account]
  );
  assert.equal(
    readFileSync(join(f.root, account, "cipher-secret"), "utf8").includes("native-refreshed-grant"),
    true
  );
});
test("reset refuses root inode drift, symlink root, archive inside bind root and unknown root entries", (t) => {
  const f = fixture(t);
  assert.throws(() => helper.planNativeProfileReset({ ...f, expectedInode: "0:0" }), /inode/);
  assert.throws(
    () => helper.planNativeProfileReset({ ...f, archive: join(f.root, "archive") }),
    /outside/
  );
  const link = join(f.directory, "link");
  symlinkSync(f.root, link);
  assert.throws(() => helper.planNativeProfileReset({ ...f, root: link }), /canonical/);
  writeFileSync(join(f.root, "unknown"), "keep");
  assert.throws(() => reset(f), /account/);
  assert.equal(readFileSync(join(f.root, "unknown"), "utf8"), "keep");
});
test("reset journals partial movement and rollback recovers a rename before acknowledgement", (t) => {
  const f = fixture(t),
    state = helper.planNativeProfileReset(f);
  let checks = 0;
  assert.throws(
    () =>
      helper.moveNativeProfiles(state, () => {
        if (++checks === 3) throw Error("stop guard changed");
      }),
    /stop guard changed/
  );
  const pending = state.entries.find((e) => e.status === "pending");
  if (pending) renameSync(join(f.root, pending.name), join(f.archive, "profiles", pending.name));
  const recovered = JSON.parse(readFileSync(join(f.archive, "reset.json"), "utf8"));
  assert.equal(helper.rollbackNativeProfiles(recovered, () => {}).restored, true);
  assert.deepEqual(readdirSync(f.root).sort(), [account, other]);
});
test("production reset roots are fixed per instance and require distinct inode", () => {
  assert.equal(
    helper.nativeProfileResetTarget("primary"),
    "/home/roomhacker/.omniroute/zcode-native"
  );
  assert.equal(
    helper.nativeProfileResetTarget("standby"),
    "/home/roomhacker/.omniroute-standby/native-state"
  );
  assert.throws(() => helper.nativeProfileResetTarget("prepare"));
});
test("executor overlay maps existing body helpers while preserving all non-native bytes", () => {
  const require = createRequire(import.meta.url),
    { parse } = require("acorn");
  const source =
    'function C(a){return a}function z(){return 32}async function execute(a,b,c){if(transport==="native-host"){return {url:"zcode://native-host/session"};}return "other";}';
  const ast = parse(source, { ecmaVersion: "latest" });
  const node = ast.body.at(-1).body.body[0].consequent;
  const base = {
    sha256: helper.sha256(source),
    branchSha256: helper.sha256(source.slice(node.start, node.end)),
    dependencies: {},
    coverage: ["ZcodeExecutor.native-host"],
  };
  const entry = helper.extendExecutorBindings(source, parse, base);
  assert.equal(entry.dependencies.buildZcodeModelRequest, "C");
  assert.equal(entry.dependencies.resolveZcodeMaxTokens, "z");
  const { after } = helper.patchExecutorBranch(source, parse, entry, "fixture.cjs");
  assert.equal(after.slice(0, node.start), source.slice(0, node.start));
  assert(after.endsWith(source.slice(node.end)));
  assert.throws(() => helper.extendExecutorBindings(source + " ", parse, base));
});
test("Individual-only overlay leaves Start on the original branch and isolates the native account", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zcode-individual-overlay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const require = createRequire(import.meta.url),
    { parse } = require("acorn");
  const source =
    'const transport="native-host";async function execute(a,b,c){if(transport==="native-host"){return {route:"legacy",connectionId:a.credentials.connectionId,url:"zcode://native-host/session"};}return "other";}module.exports={execute};';
  const block = parse(source, { ecmaVersion: "latest" }).body[1].body.body[0].consequent;
  const entry = {
    sha256: helper.sha256(source),
    branchSha256: helper.sha256(source.slice(block.start, block.end)),
    dependencies: {},
    coverage: ["ZcodeExecutor.native-host"],
    individualOnly: true,
  };
  const { after } = helper.patchExecutorBranch(source, parse, entry, "fixture.cjs");
  assert(after.includes(source.slice(block.start + 1, block.end - 1)));
  writeFileSync(
    join(directory, "fixture.cjs"),
    'exports.runNativeExecutor=async function(d,input){return {route:"individual",connectionId:input.credentials.connectionId}};'
  );
  writeFileSync(join(directory, "candidate.cjs"), after);
  const { execute } = require(join(directory, "candidate.cjs"));
  const input = { credentials: { connectionId: "original", authType: "oauth" } };
  for (const provider of ["zcode-start", "zcode-cn-start"]) {
    assert.deepEqual(await execute.call({ options: { provider } }, input), {
      route: "legacy",
      connectionId: "original",
      url: "zcode://native-host/session",
    });
  }
  for (const provider of ["zcode-individual", "zcode-cn-individual"]) {
    assert.deepEqual(await execute.call({ options: { provider } }, input), {
      route: "individual",
      connectionId: "original:plain-individual",
    });
  }
  assert.equal(input.credentials.connectionId, "original");
});
test("fresh profile never carries a refreshed grant from DB and does not carry config/tasks/MCP", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, account, ".zcode/v2/config.json"), '{"apiKey":"old-config"}');
  mkdirSync(join(f.root, account, ".config"));
  writeFileSync(join(f.root, account, ".config/mcp.json"), "old MCP");
  const before = Object.fromEntries(
    grantFiles.map((file) => [file, readFileSync(join(f.root, account, file))])
  );
  const state = reset(f);
  assert.equal(state.retainedNativeGrant, true);
  for (const [file, bytes] of Object.entries(before))
    assert.deepEqual(readFileSync(join(f.root, account, file)), bytes);
  assert.deepEqual(readdirSync(join(f.root, account)).sort(), [
    ".zcode",
    "account.json",
    "cipher-secret",
  ]);
  assert.deepEqual(readdirSync(join(f.root, account, ".zcode/v2")).sort(), [
    "credentials.json",
    "setting.json",
    "telemetry-state.json",
  ]);
});
test("reset refuses missing or symlinked native grant before archiving any account", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, other, "cipher-secret"));
  assert.throws(() => reset(f));
  assert.deepEqual(readdirSync(f.root).sort(), [account, other]);
  symlinkSync(join(f.root, account, "cipher-secret"), join(f.root, other, "cipher-secret"));
  assert.throws(() => reset(f), /canonical/);
  assert.deepEqual(readdirSync(f.root).sort(), [account, other]);
});
test("rollback preserves native OAuth refreshed after reset", (t) => {
  const f = fixture(t),
    state = reset(f);
  writeFileSync(join(f.root, account, ".zcode/v2/credentials.json"), "newer-native-grant");
  assert.equal(helper.rollbackNativeProfiles(state, () => {}).restored, false);
  assert.equal(
    readFileSync(join(f.root, account, ".zcode/v2/credentials.json"), "utf8"),
    "newer-native-grant"
  );
  assert.match(
    readFileSync(join(f.archive, "profiles", account, ".zcode/v2/credentials.json"), "utf8"),
    /native-refreshed-grant/
  );
});
test("partial native grant seeding recovers acknowledged and unacknowledged renames", (t) => {
  const f = fixture(t),
    state = helper.planNativeProfileReset(f);
  let checks = 0;
  assert.throws(
    () =>
      helper.moveNativeProfiles(state, () => {
        if (++checks === 5) throw Error("fixture stop");
      }),
    /fixture stop/
  );
  const pending = state.entries.find((e) => e.seedStatus === "pending");
  assert(pending);
  renameSync(join(f.archive, "new-profiles", pending.name), join(f.root, pending.name));
  const recovered = JSON.parse(readFileSync(join(f.archive, "reset.json"), "utf8"));
  assert.equal(helper.rollbackNativeProfiles(recovered, () => {}).restored, true);
  assert.equal(
    readFileSync(join(f.root, account, ".zcode/v2/tasks-index.sqlite"), "utf8"),
    "old tasks"
  );
  assert.equal(
    readFileSync(join(f.root, other, ".zcode/v2/tasks-index.sqlite"), "utf8"),
    "old tasks"
  );
});
test("unrecognized provider preferences are not carried into fresh profile", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, account, ".zcode/v2/setting.json"),
    '{"providerFamilyDomain":"foreign","mcpServers":{}}'
  );
  reset(f);
  assert.deepEqual(readdirSync(join(f.root, account, ".zcode/v2")).sort(), [
    "credentials.json",
    "telemetry-state.json",
  ]);
});
test("native wrapper allows dynamic mkdir inside branch and refuses all edits outside it", () => {
  const { parse } = createRequire(import.meta.url)("acorn");
  const header =
    "const fallbackMaxTokens=128000;function boundMaxOutputTokens(a,b){a.maxOutputTokens=Math.min(a.maxOutputTokens,b);}async function execute(input,request,resolution){";
  const before =
    header +
    'if(transport==="native-host"){return {url:"zcode://native-host/session"};}return "unchanged";}';
  const after =
    header +
    'if(transport==="native-host"){const {mkdir}=await import("node:fs/promises");await mkdir("fixture");boundMaxOutputTokens(request,32??fallbackMaxTokens);return client.call("zcode-agent","generateWorkspaceText",[request]);}return "unchanged";}';
  const wrapped = helper.nativeExecutorSource(before, after, parse, { client: "fixture" });
  assert(wrapped.includes('import("node:fs/promises")'));
  assert(wrapped.includes("function boundMaxOutputTokens(a,b)"));
  assert(wrapped.includes("const fallbackMaxTokens=128000;"));
  assert.throws(
    () =>
      helper.nativeExecutorSource(
        before,
        after.replace('return "unchanged"', 'return "mutated"'),
        parse,
        {}
      ),
    /outside/
  );
  assert.throws(
    () =>
      helper.nativeExecutorSource(
        before,
        'import {mkdir} from "node:fs/promises";' + after,
        parse,
        {}
      ),
    /outside/
  );
});
const nativeCleanupImports = [
  'import { createHash } from "node:crypto";',
  'import { homedir } from "node:os";',
  'import { tmpdir } from "node:os";',
  'import { NativeZcodeSessionBridge, NativeSessionError } from "./zcode/nativeSession.ts";',
  "const nativeBridges = /* @__PURE__ */ new Map();",
];
const nativeCleanupDeletions = [
  [nativeCleanupImports[0] + "\n", ""],
  [nativeCleanupImports[2] + "\n", ""],
  [nativeCleanupImports[3], 'import { NativeSessionError } from "./zcode/nativeSession.ts";'],
  [nativeCleanupImports[4] + "\n", ""],
];
function nativeCleanupFixture(deletions = nativeCleanupDeletions) {
  const header = nativeCleanupImports.join("\n") + "\nfunction sharedHelper(){return 42;}\n";
  const oldBranch =
    '{nativeBridges.get(createHash("sha256"));tmpdir();new NativeZcodeSessionBridge();return {url:"zcode://native-host/session"};}';
  const newBranch = '{return client.call("zcode-agent","generateWorkspaceText",[request]);}';
  const execute =
    'async function execute(input,request,resolution){if(transport==="native-host")' +
    oldBranch +
    'return "app-server";}';
  const previous = header + execute;
  let candidate = previous.replace(oldBranch, newBranch);
  for (const [from, to] of deletions) candidate = candidate.replace(from, to);
  return { previous, candidate };
}
test("outside guard allows only the four approved unused native deletions, separately or together", () => {
  const { parse } = createRequire(import.meta.url)("acorn");
  for (const deletions of [
    nativeCleanupDeletions,
    ...nativeCleanupDeletions.map((deletion) => [deletion]),
  ]) {
    const { previous, candidate } = nativeCleanupFixture(deletions);
    assert(
      helper.nativeExecutorSource(previous, candidate, parse, {}).includes("generateWorkspaceText")
    );
  }
});
test("outside guard still refuses app-server, shared helper, token bound and other import changes", () => {
  const { parse } = createRequire(import.meta.url)("acorn");
  const { previous, candidate } = nativeCleanupFixture();
  const badCandidates = [
    candidate.replace('return "app-server"', 'return "mutated"'),
    candidate.replace("return 42", "return 43"),
    candidate.replace('import { homedir } from "node:os";\n', ""),
    candidate.replace("NativeSessionError }", "NativeSessionError as SessionError }"),
    candidate.replace('import { NativeSessionError } from "./zcode/nativeSession.ts";', ""),
    candidate.replace("./zcode/nativeSession.ts", "./zcode/otherSession.ts"),
    'import { mkdir } from "node:fs/promises";\n' + candidate,
    'import "extra-side-effect";\n' + candidate,
    candidate + "\nconst additionalCache = new Map();",
  ];
  for (const value of badCandidates)
    assert.throws(() => helper.nativeExecutorSource(previous, value, parse, {}), /outside/);
});
test("outside normalization cannot hide new imports, aliases, cache mutations or nonempty Map removal", () => {
  const { parse } = createRequire(import.meta.url)("acorn");
  const { previous, candidate } = nativeCleanupFixture();
  const cleanedPrevious = nativeCleanupDeletions.reduce(
    (text, [from, to]) => text.replace(from, to),
    previous
  );
  assert.throws(
    () =>
      helper.nativeExecutorSource(
        cleanedPrevious,
        nativeCleanupImports[0] + "\n" + candidate,
        parse,
        {}
      ),
    /outside/
  );
  assert.throws(
    () =>
      helper.nativeExecutorSource(
        previous.replace("{ createHash }", "{ createHash as digest }"),
        candidate,
        parse,
        {}
      ),
    /outside/
  );
  assert.throws(
    () =>
      helper.nativeExecutorSource(
        previous.replace("new Map();", "new Map([[1,2]]);"),
        candidate,
        parse,
        {}
      ),
    /outside/
  );
  const retained = nativeCleanupFixture(nativeCleanupDeletions.slice(0, 3));
  assert.throws(
    () =>
      helper.nativeExecutorSource(
        retained.previous,
        retained.candidate.replace("new Map();", "new WeakMap();"),
        parse,
        {}
      ),
    /outside/
  );
});
test("unused cleanup refuses to remove bindings still referenced by code outside native block", () => {
  const { parse } = createRequire(import.meta.url)("acorn");
  const { previous, candidate } = nativeCleanupFixture();
  for (const name of ["createHash", "tmpdir", "NativeZcodeSessionBridge", "nativeBridges"])
    assert.throws(
      () =>
        helper.nativeExecutorSource(
          previous.replace("return 42", "return " + name),
          candidate.replace("return 42", "return " + name),
          parse,
          {}
        ),
      /outside/
    );
});
// Handwritten JS fixture only: product TS remains unfrozen and is never compiled
// or imported by this preparation suite. The installed overlay will run this
// same smoke against its actual source-backed native block on server44.
async function directExecutorFixture(deps, input, _request, resolution) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new deps.NativeSessionError("timeout", 504)),
    this.turnTimeoutMs()
  );
  const onAbort = () => controller.abort(new deps.NativeSessionError("cancelled", 499));
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  let client;
  try {
    controller.signal.throwIfAborted();
    const serverRoot = await deps.nativeZcodeHosts.ensure(input.credentials);
    const directory = deps.join(serverRoot, "..", "cli");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      deps.join(directory, "config.json"),
      JSON.stringify({
        features: { mcp: false, memory: false, subagent: false },
        mcp: { servers: {} },
        plugins: { enabled: false },
        hooks: { enabled: false },
      })
    );
    client = new deps.NativeZcodeHostClient({ serverRoot });
    const budget = () => ({ timeoutMs: this.turnTimeoutMs(), signal: controller.signal });
    await client.start(budget());
    const view = await client.call("model-selection", "getView", [], budget());
    const nativeRequest = deps.buildZcodeModelRequest(input.body);
    nativeRequest.maxOutputTokens = Math.min(
      nativeRequest.maxOutputTokens,
      deps.resolveZcodeMaxTokens(view) ?? 128000
    );
    const workspacePath = deps.join(deps.tmpdir(), "empty");
    mkdirSync(workspacePath, { recursive: true });
    const result = await client.call(
      "zcode-agent",
      "generateWorkspaceText",
      [
        {
          ...nativeRequest,
          workspacePath,
          workspaceIdentity: workspacePath,
          selection: deps.resolveZcodeSelection(view),
          querySource: "omniroute",
          requestTimeoutMs: this.turnTimeoutMs(),
        },
      ],
      budget()
    );
    return {
      url: "zcode://native-host/model",
      response: deps.modelResponse(resolution.model, result),
    };
  } catch (error) {
    return deps.errorResponse(error.status || 502, error.message);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    await client?.close();
  }
}
class FixtureError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
const smokeRuntime = () => {
  const require = createRequire(import.meta.url);
  return {
    assert,
    fs: require("node:fs"),
    path: require("node:path"),
    os: require("node:os"),
    crypto: require("node:crypto"),
  };
};
test("direct executor smoke verifies caller tools, isolated workspace, cancellation, deadline and quota", async () => {
  const result = await helper.smokeNativeExecutor(
    directExecutorFixture,
    FixtureError,
    smokeRuntime()
  );
  for (const check of [
    "generateWorkspaceText",
    "callerTools",
    "noAgentSessions",
    "isolatedWorkspace",
    "cancellation",
    "deadlinePassed",
    "quotaPreserved",
  ])
    assert.equal(result[check], true);
});
test("direct executor smoke rejects agent session bridge and project/MCP RPC", async () => {
  await assert.rejects(
    helper.smokeNativeExecutor(
      async function (deps) {
        return new deps.NativeZcodeSessionBridge();
      },
      FixtureError,
      smokeRuntime()
    ),
    /bridge is forbidden/
  );
  await assert.rejects(
    helper.smokeNativeExecutor(
      async function (deps) {
        const client = new deps.NativeZcodeHostClient({});
        await client.call("zcode-agent", "createSession", [], {
          timeoutMs: 10,
          signal: new AbortController().signal,
        });
      },
      FixtureError,
      smokeRuntime()
    ),
    /Session\/project\/MCP RPC is forbidden/
  );
});
