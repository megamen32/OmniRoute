import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { runReleaseAdmin } from "/home/roomhacker/agents-projects/.fleet-candidate/releases/1fcac12e511d17d203ab8a08fb662f2a1f7b46b1/dist/project-release-admin.js";

const root = "/home/roomhacker/agents-projects/omniroute-zcode";
const standby = "/home/roomhacker/.omniroute-standby";
const sha = "30bae46b37";
const source =
  "/home/roomhacker/ServersAdministartion/templates/server100-omniroute-opencode/standby-native-isolation.conf";
const target = "/etc/systemd/system/omniroute@20130.service.d/zz-native-isolation-20261110.conf";
const ledger = "/home/roomhacker/.local/state/agent-herder/project-release-leases.json";
const owner = {
  hostId: hostname(),
  harness: "codex",
  nativeSessionId: process.env.CODEX_THREAD_ID,
};
assert.equal(hostname(), "roomhacker-server-100");
assert(owner.nativeSessionId);
assert.equal(process.env.OMNIROUTE_DEPLOY_LOCK_HELD, "1");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
const pid = (port) =>
  Number(run("systemctl", ["show", "omniroute@" + port + ".service", "-p", "MainPID", "--value"]));
const control = (action, port) =>
  run("sudo", ["-n", "systemctl", action, "omniroute@" + port + ".service"]);
async function healthy(port) {
  try {
    return (
      (await fetch("http://127.0.0.1:" + port + "/readyz", { signal: AbortSignal.timeout(5_000) }))
        .status === 200
    );
  } catch {
    return false;
  }
}
async function waitReady(port) {
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    if (await healthy(port)) return;
    await delay(2_000);
  }
  throw new Error("Readiness timed out on " + port);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = root + "/_tasks/research/2026-11-10-final-routing/standby-isolation.json";
const proofPath = "/home/roomhacker/.local/state/omniroute-isolate-" + stamp + ".json";
const result = {
  startedAt: new Date().toISOString(),
  sha,
  previousStandbyTarget: await readlink(standby + "/pkg/dist"),
};
const save = () => writeFile(evidence, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const admin = (request, proofOut) =>
  runReleaseAdmin({
    ledger,
    authorityHost: hostname(),
    request,
    ...(proofOut ? { proofOut } : {}),
  });
let proof;
try {
  assert.equal((await readFile(root + "/dist/BUILD_SHA", "utf8")).trim(), sha);
  assert.equal(result.previousStandbyTarget, "snapshots/d93440481f");
  assert(await healthy(20128));
  assert(!(await exists(target)), "Isolation drop-in already exists; inspect before replay");
  const acquired = await admin(
    { action: "acquire", cwd: root, owner, ttlSeconds: 1800 },
    proofPath
  );
  assert.equal(acquired.acquired, true);
  proof = JSON.parse(await readFile(proofPath, "utf8"));
  result.fence = proof.fence;
  const checked = await admin({
    action: "check",
    cwd: root,
    owner,
    token: proof.token,
    fence: proof.fence,
  });
  assert.equal(checked.fence, proof.fence);
  assert.equal(checked.project, proof.project);
  assert.deepEqual(checked.owner, owner);
  const snapshot = standby + "/pkg/snapshots/" + sha;
  if (!(await exists(snapshot))) {
    assert(!(await exists(snapshot + ".tmp")));
    run("cp", ["-a", root + "/dist", snapshot + ".tmp"]);
    await rename(snapshot + ".tmp", snapshot);
  }
  assert.equal((await readFile(snapshot + "/BUILD_SHA", "utf8")).trim(), sha);
  await mkdir(standby + "/native-state", { mode: 0o700 });
  assert(!(await lstat(standby + "/native-state")).isSymbolicLink());
  assert(!(await lstat("/home/roomhacker/.omniroute/zcode-native")).isSymbolicLink());
  await save();
  control("stop", 20130);
  assert.equal(pid(20130), 0);
  run("sudo", ["-n", "install", "-m", "0644", source, target]);
  await symlink("snapshots/" + sha, standby + "/pkg/dist.isolation-new");
  await rename(standby + "/pkg/dist.isolation-new", standby + "/pkg/dist");
  run("sudo", ["-n", "systemctl", "daemon-reload"]);
  control("start", 20130);
  console.log(JSON.stringify({ phase: "isolated-standby-started", pid: pid(20130) }));
  await waitReady(20130);
  const inode = (port, path) =>
    run("sudo", ["-n", "stat", "-Lc", "%d:%i", "/proc/" + pid(port) + "/root" + path]);
  const dbPath = "/home/roomhacker/.omniroute/storage.sqlite";
  const nativePath = "/home/roomhacker/.omniroute/zcode-native";
  result.db = { primary: inode(20128, dbPath), standby: inode(20130, dbPath) };
  result.native = { primary: inode(20128, nativePath), standby: inode(20130, nativePath) };
  assert.equal(result.db.primary, result.db.standby);
  assert.notEqual(result.native.primary, result.native.standby);
  result.standbyReady = true;
  await save();
  console.log(JSON.stringify({ phase: "namespace-verified", ...result }));
  // Recover primary rendezvous files after stopping its former shared-state peer.
  const checkedAgain = await admin({
    action: "check",
    cwd: root,
    owner,
    token: proof.token,
    fence: proof.fence,
  });
  assert.equal(checkedAgain.fence, proof.fence);
  assert.equal((await readFile(root + "/dist/BUILD_SHA", "utf8")).trim(), sha);
  assert(await healthy(20130));
  result.previousPrimaryPid = pid(20128);
  control("restart", 20128);
  result.newPrimaryPid = pid(20128);
  assert.notEqual(result.previousPrimaryPid, result.newPrimaryPid);
  console.log(JSON.stringify({ phase: "primary-recovering", pid: result.newPrimaryPid }));
  await waitReady(20128);
  assert(await healthy(20130));
  result.primaryReady = true;
  result.isolated = true;
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 500) };
  process.exitCode = 1;
} finally {
  try {
    if (proof)
      result.leaseReleased = (
        await admin({ action: "release", cwd: root, owner, token: proof.token, fence: proof.fence })
      ).released;
  } catch (error) {
    result.releaseFailure = error.name;
    process.exitCode = 1;
  }
  result.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(result));
}
