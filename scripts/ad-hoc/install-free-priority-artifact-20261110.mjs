import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runReleaseAdmin } from "/home/roomhacker/agents-projects/.fleet-candidate/releases/1fcac12e511d17d203ab8a08fb662f2a1f7b46b1/dist/project-release-admin.js";

const root = "/home/roomhacker/agents-projects/omniroute-zcode";
const candidate = "30bae46b378adbb72911306c065d182c607668ee";
const expectedLive = "d93440481f";
const oldPackage = root + "/.claude/worktrees/zcode-start-final-20261108";
const stage = root + "/.build/free-priority-30bae46b37";
const unit = "omniroute@20128.service";
const pointerDir = "/etc/systemd/system/" + unit + ".d";
const pointers = [
  "10-omniroute-runtime.conf",
  "zz-zcode-native-text-20261108.conf",
  "zzz-zcode-start-final-20261108.conf",
];
const ledger = "/home/roomhacker/.local/state/agent-herder/project-release-leases.json";
const owner = {
  hostId: hostname(),
  harness: "codex",
  nativeSessionId: process.env.CODEX_THREAD_ID,
};
assert.equal(owner.hostId, "roomhacker-server-100");
assert(owner.nativeSessionId, "Native session identity unavailable");
assert.equal(process.env.OMNIROUTE_DEPLOY_LOCK_HELD, "1", "Run under the canonical deploy flock");
assert.equal(resolve(process.cwd()), root);
const mode = process.argv[2] || "prepare";
assert(["prepare", "apply"].includes(mode));
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const readSha = async (pkg) => (await readFile(pkg + "/dist/BUILD_SHA", "utf8")).trim();
const mainPid = () => Number(run("systemctl", ["show", unit, "-p", "MainPID", "--value"]));
const confirmedStopped = () =>
  mainPid() === 0 &&
  ["inactive", "failed"].includes(
    run("systemctl", ["show", unit, "-p", "ActiveState", "--value"])
  ) &&
  run("ss", ["-H", "-ltn", "sport", "=", ":20128"]) === "";
async function activePackage() {
  const data = await readFile("/proc/" + mainPid() + "/environ", "utf8");
  return data
    .split("\0")
    .find((item) => item.startsWith("OMNIROUTE_PKG="))
    ?.slice(14);
}
async function health(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "follow" })).status;
  } catch {
    return 0;
  }
}
async function ready(seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if ((await health("http://127.0.0.1:20128/readyz")) === 200) return true;
    if (run("systemctl", ["show", unit, "-p", "ActiveState", "--value"]) === "failed") return false;
    await delay(2_000);
  }
  return false;
}

// The build is imported as a complete artifact; this script never builds on server100.
assert.equal(await readSha(stage), candidate.slice(0, 10));
for (const file of ["server.js", ".build/next/BUILD_ID", "package.json"])
  await access(stage + "/dist/" + file);
assert(!(await readFile(stage + "/dist/server.js", "utf8")).includes("stage/next"));
assert.equal(
  JSON.parse(await readFile(stage + "/dist/package.json", "utf8")).version,
  JSON.parse(await readFile(root + "/package.json", "utf8")).version
);
run("git", ["merge-base", "--is-ancestor", candidate, "origin/main"]);
// Ignore unrelated tests/helpers, but refuse any change to the production source inputs.
run("git", [
  "diff",
  "--quiet",
  candidate,
  "--",
  "src",
  "open-sse",
  "bin",
  "package.json",
  "package-lock.json",
]);
assert.equal(await activePackage(), oldPackage);
assert.equal(await readSha(oldPackage), expectedLive);
assert.equal(
  await health("http://127.0.0.1:20130/api/health"),
  200,
  "Frozen local standby unavailable"
);
console.log(JSON.stringify({ phase: "prepared", candidate, expectedLive, stage, oldPackage }));
if (mode === "prepare") process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = root + "/.build/release-backups/" + stamp + "-30bae46b37";
const evidence = root + "/_tasks/research/2026-11-10-final-routing";
const proofPath = "/home/roomhacker/.local/state/omniroute-release-" + stamp + ".json";
await mkdir(backup + "/systemd", { recursive: true, mode: 0o700 });
await mkdir(evidence, { recursive: true, mode: 0o700 });
const result = {
  candidate,
  expectedLive,
  startedAt: new Date().toISOString(),
  backup,
  previousMainPid: mainPid(),
};
const save = async () =>
  writeFile(evidence + "/deployment.json", JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const admin = (request, proofOut) =>
  runReleaseAdmin({
    ledger,
    authorityHost: hostname(),
    request,
    ...(proofOut ? { proofOut } : {}),
  });
let proof;
let stopped = false;
let artifactMoved = false;
let pointerChanged = false;
try {
  const acquired = await admin(
    { action: "acquire", cwd: root, owner, ttlSeconds: 1800 },
    proofPath
  );
  result.leaseAcquired = acquired.acquired;
  proof = JSON.parse(await readFile(proofPath, "utf8"));
  result.releaseFence = proof.fence;
  assert.equal(acquired.acquired, true);
  const request = { cwd: root, owner, token: proof.token, fence: proof.fence };
  const checked = await admin({ action: "check", ...request });
  assert.equal(checked.fence, proof.fence);
  assert.equal(checked.project, proof.project);
  assert.deepEqual(checked.owner, proof.owner);
  // Re-read immediately before the first mutation while both release locks are held.
  assert.equal(await activePackage(), oldPackage);
  assert.equal(await readSha(oldPackage), expectedLive);
  for (const name of pointers)
    run("sudo", ["-n", "cp", "-a", pointerDir + "/" + name, backup + "/systemd/" + name]);
  const pointer = backup + "/canonical-runtime.conf";
  await writeFile(
    pointer,
    '[Service]\nEnvironment="OMNIROUTE_PKG=' +
      root +
      '"\nEnvironment="ZCODE_TRANSPORT=native-host"\n',
    { mode: 0o644 }
  );
  await save();
  stopped = true;
  run("sudo", ["-n", "systemctl", "stop", unit]);
  assert(confirmedStopped(), "Primary stop not confirmed; artifact was not moved");
  if (await exists(root + "/dist")) await rename(root + "/dist", backup + "/canonical-dist-before");
  await rename(stage + "/dist", root + "/dist");
  artifactMoved = true;
  pointerChanged = true;
  run("sudo", ["-n", "install", "-m", "0644", pointer, pointerDir + "/" + pointers[0]]);
  for (const name of pointers.slice(1))
    run("sudo", ["-n", "mv", pointerDir + "/" + name, backup + "/systemd/" + name + ".disabled"]);
  run("sudo", ["-n", "systemctl", "daemon-reload"]);
  run("sudo", ["-n", "systemctl", "start", unit]);
  console.log(JSON.stringify({ phase: "started", candidate, newMainPid: mainPid() }));
  assert(await ready(480), "Primary readiness timed out");
  assert.equal(await activePackage(), root);
  assert.equal(await readSha(root), candidate.slice(0, 10));
  assert.notEqual(mainPid(), result.previousMainPid);
  result.newMainPid = mainPid();
  result.localHealth = await health("http://127.0.0.1:20128/api/health");
  result.publicHealth = await health("https://omniroute.bezrabotnyi.com/api/health");
  assert.equal(result.localHealth, 200);
  assert.equal(result.publicHealth, 200);
  result.installed = true;
  console.log(
    JSON.stringify({
      phase: "installed",
      candidate,
      localHealth: result.localHealth,
      publicHealth: result.publicHealth,
    })
  );
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 500) };
  if (stopped) {
    try {
      // Never roll back a different owner's later release.
      assert(
        !artifactMoved || (await readSha(root)) === candidate.slice(0, 10),
        "Rollback refused: runtime artifact changed"
      );
      const failures = (result.rollbackFailures = []);
      const attempt = async (label, action) => {
        try {
          await action();
        } catch (failure) {
          failures.push({
            label,
            name: failure.name,
            message: String(failure.message).slice(0, 300),
          });
        }
      };
      await attempt("stop candidate", () => run("sudo", ["-n", "systemctl", "stop", unit]));
      const stoppedForRollback = confirmedStopped();
      if (pointerChanged)
        for (const name of pointers)
          await attempt("restore " + name, () =>
            run("sudo", ["-n", "cp", "-a", backup + "/systemd/" + name, pointerDir + "/" + name])
          );
      if (artifactMoved && stoppedForRollback)
        await attempt("retain failed artifact", () =>
          rename(root + "/dist", backup + "/failed-candidate-dist")
        );
      if (stoppedForRollback && (await exists(backup + "/canonical-dist-before")))
        await attempt("restore previous canonical artifact", () =>
          rename(backup + "/canonical-dist-before", root + "/dist")
        );
      await attempt("reload previous pointers", () =>
        run("sudo", ["-n", "systemctl", "daemon-reload"])
      );
      assert(stoppedForRollback, "Candidate stop unconfirmed; artifact moves and restart skipped");
      await attempt("start previous primary", () =>
        run("sudo", ["-n", "systemctl", "start", unit])
      );
      assert(await ready(480), "Previous primary readiness timed out");
      assert.equal(await activePackage(), oldPackage);
      assert.equal(await readSha(oldPackage), expectedLive);
      result.rolledBack = true;
      if (failures.length) result.rollbackFailures = failures;
    } catch (rollbackError) {
      result.rollbackFailure = {
        name: rollbackError.name,
        message: String(rollbackError.message).slice(0, 500),
      };
    }
  }
  process.exitCode = 1;
} finally {
  try {
    if (proof) {
      const released = await admin({
        action: "release",
        cwd: root,
        owner,
        token: proof.token,
        fence: proof.fence,
      });
      result.leaseReleased = released.released;
    }
  } catch (releaseError) {
    result.releaseFailure = {
      name: releaseError.name,
      message: "Release admin failed; protected proof retained",
    };
    process.exitCode = 1;
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await save();
    } catch (saveError) {
      result.evidenceFailure = { name: saveError.name };
      process.exitCode = 1;
    }
    console.log(JSON.stringify(result));
  }
}
