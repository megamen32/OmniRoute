import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const ROOT = "/home/roomhacker/agents-projects/omniroute-zcode";
const STANDBY = "/home/roomhacker/.omniroute-standby/pkg";
const REMOTE = "roomhacker@192.168.2.5";
const REMOTE_ROOT = "/home/roomhacker/omniroute-timeout-patch-20261110";
const DONOR = "/home/roomhacker/omniroute-build-142a2f04d8";
const AREA = join(ROOT, ".build/zcode-timeout-patch-20261110");
const RECEIPTS = join(ROOT, "_tasks/research/2026-11-10-zcode-timeouts");
const LOCK = "/home/roomhacker/.local/state/omniroute-deploy.lock";
export const EXPECTED_LIVE = "30bae46b37";
export const SOURCES = [
  "open-sse/executors/zcode/nativeHostClient.ts",
  "open-sse/executors/zcode/nativeSession.ts",
  "open-sse/executors/zcodeProtocol.ts",
];
const CHUNKS = ".build/next/server/chunks";
const MARKERS = ["ZCode host startup timed out", "ZCode native session timed out"];
const SELF = resolve(process.argv[1] || "");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const run = (cmd, args, options = {}) => {
  const output = execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return typeof output === "string" ? output.trim() : output;
};
const save = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
function fullSha(value) {
  assert(/^[a-f0-9]{40}$/.test(value || ""), "Full published source SHA is required");
  return value;
}
export function inventory(dist) {
  const directory = join(dist, CHUNKS);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name),
        text = read(path);
      const markers = MARKERS.filter((marker) => text.includes(marker));
      return markers.length ? [{ path: join(CHUNKS, name), sha256: sha256(text), markers }] : [];
    });
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}
// Keep webpack module IDs, dependency bindings, async initialization and exports.
// Replace only exact AST class ranges, never an unbounded textual pattern.
export function patchChunk(text, parse, sidecar) {
  const ast = parse(text, { ecmaVersion: "latest" });
  const classes = [];
  walk(ast, (node) => {
    if (node.type === "ClassDeclaration") classes.push(node);
  });
  const replacements = [],
    coverage = [];
  const load = 'require(__dirname + "/' + sidecar + '")';
  for (const [marker, exported] of MARKERS.map((marker, i) => [
    marker,
    ["NativeZcodeHostClient", "NativeZcodeSessionBridge"][i],
  ])) {
    if (!text.includes(marker)) continue;
    const found = classes.filter((node) => text.slice(node.start, node.end).includes(marker));
    assert.equal(found.length, 1, "Expected exactly one matching class per chunk");
    const node = found[0];
    let expression = load + "." + exported;
    if (exported === "NativeZcodeHostClient") {
      const calls = {};
      for (const method of node.body.body.filter((method) =>
        ["consume", "call"].includes(method.key?.name)
      )) {
        walk(method.value.body, (child) => {
          if (child.type !== "CallExpression" || child.callee.type !== "SequenceExpression") return;
          const size = child.arguments.length;
          if (
            (method.key.name === "consume" && [1, 2].includes(size)) ||
            (method.key.name === "call" && size === 4)
          ) {
            const key = size === 4 ? "encodeZcodeRpcCall" : "decodeZcodeValue";
            const value = text.slice(child.callee.start, child.callee.end);
            assert(!calls[key] || calls[key] === value, "Ambiguous protocol binding");
            calls[key] = value;
          }
        });
      }
      assert(calls.decodeZcodeValue && calls.encodeZcodeRpcCall, "Protocol bindings missing");
      expression =
        load +
        ".createHostClient({" +
        Object.entries(calls)
          .map(([key, value]) => key + ":(" + value + ")")
          .join(",") +
        "})";
    } else {
      const errors = classes.filter(
        (entry) =>
          entry.superClass?.name === "Error" &&
          /^class \w+ extends Error\{constructor\(\w+,\w+=502\)/.test(
            text.slice(entry.start, entry.end)
          )
      );
      assert.equal(errors.length, 1, "NativeSessionError binding is ambiguous");
      replacements.push({ node: errors[0], expression: load + ".NativeSessionError" });
      coverage.push("NativeSessionError");
    }
    replacements.push({ node, expression });
    coverage.push(exported);
  }
  assert(replacements.length, "No patch targets found");
  let after = text;
  for (const { node, expression } of replacements.sort((a, b) => b.node.start - a.node.start))
    after =
      after.slice(0, node.start) +
      "const " +
      node.id.name +
      "=" +
      expression +
      ";" +
      after.slice(node.end);
  parse(after, { ecmaVersion: "latest" });
  assert(!MARKERS.some((marker) => after.includes(marker)), "Unpatched class remains");
  return { after, coverage };
}
async function remoteStage(inputDirectory) {
  assert.equal(hostname(), "server-44", "Compilation is allowed only on server-44");
  assert.equal(dirname(inputDirectory), REMOTE_ROOT);
  const manifest = json(join(inputDirectory, "input.json"));
  const require = createRequire(join(DONOR, "package.json"));
  const { transform } = require("esbuild"),
    { parse } = require("acorn");
  assert.equal(
    sha256(readFileSync(join(DONOR, "package-lock.json"))),
    manifest.lockfileSha256,
    "Reusable compiler dependencies have a different lockfile"
  );
  const code = {};
  for (const file of manifest.sources) {
    const bytes = readFileSync(join(inputDirectory, "source", file.path));
    assert.equal(sha256(bytes), file.sha256);
    code[file.path] = (
      await transform(bytes.toString(), {
        loader: "ts",
        format: "cjs",
        target: "node22",
        sourcemap: false,
      })
    ).code;
  }
  // Protocol's change is types only. Reuse the installed wire codec verbatim.
  const protocol = SOURCES[2];
  const original = (
    await transform(read(join(inputDirectory, "protocol-before.ts")), {
      loader: "ts",
      format: "cjs",
      target: "node22",
      sourcemap: false,
    })
  ).code;
  assert.equal(code[protocol], original, "Protocol runtime changed; class-only patch is unsafe");
  const sidecar = "zcode-timeout-" + manifest.sourceSnapshotSha256.slice(0, 16) + ".cjs";
  const bundle =
    '"use strict";\n' +
    "function loadSession(){const module={exports:{}};const exports=module.exports;\n" +
    code[SOURCES[1]] +
    "\nreturn module.exports;}\n" +
    "function loadClient(require){const module={exports:{}};const exports=module.exports;\n" +
    code[SOURCES[0]] +
    "\nreturn module.exports.NativeZcodeHostClient;}\n" +
    "Object.assign(exports,loadSession());\n" +
    'exports.createHostClient=(protocol)=>loadClient((name)=>name==="../zcodeProtocol.ts"?protocol:require(name));\n';
  const output = join(inputDirectory, "output");
  assert(!existsSync(output), "Output exists; inspect the previous attempt before replay");
  mkdirSync(join(output, CHUNKS), { recursive: true, mode: 0o700 });
  writeFileSync(join(output, CHUNKS, sidecar), bundle, { mode: 0o644 });
  manifest.files = [{ path: join(CHUNKS, sidecar), before: null, after: sha256(bundle) }];
  for (const chunk of manifest.chunks) {
    const before = read(join(inputDirectory, "chunks", chunk.path.split("/").at(-1)));
    assert.equal(sha256(before), chunk.sha256);
    const patched = patchChunk(before, parse, sidecar);
    const destination = join(output, chunk.path);
    writeFileSync(destination, patched.after, { mode: 0o644 });
    run(process.execPath, ["--check", destination]);
    manifest.files.push({
      path: chunk.path,
      before: chunk.sha256,
      after: sha256(patched.after),
      coverage: patched.coverage,
    });
  }
  run(process.execPath, ["--check", join(output, CHUNKS, sidecar)]);
  const smoke =
    'const p=require(process.argv[1]);if(typeof p.createHostClient!=="function"||' +
    'typeof p.NativeZcodeSessionBridge!=="function"||!(new p.NativeSessionError("test",504) instanceof Error))process.exit(1);';
  run(process.execPath, ["-e", smoke, join(output, CHUNKS, sidecar)], {
    env: { ...process.env, NODE_PATH: join(DONOR, "node_modules") },
  });
  manifest.compiledOn = hostname();
  manifest.compiler = { node: process.version, esbuild: require("esbuild").version };
  manifest.checks = { syntax: true, exports: true, protocolRuntimeUnchanged: true };
  save(join(output, "patch.json"), manifest);
  remoteVerify(inputDirectory);
  console.log(JSON.stringify({ phase: "patch-compiled", output, chunks: manifest.chunks.length }));
}
function remoteVerify(inputDirectory) {
  assert.equal(hostname(), "server-44");
  assert.equal(dirname(inputDirectory), REMOTE_ROOT);
  const output = join(inputDirectory, "output"),
    manifest = json(join(output, "patch.json"));
  const test = String.raw`
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const ws=require('ws'), zod=require('zod');
const all=Object.assign({},require('node:crypto'),require('node:http'),require('node:fs/promises'),path,zod,{default:ws,Bt:()=>{},tC:()=>Buffer.alloc(0)});
(async()=>{
 let tested=0, clients=0, bridges=0;
 const output=process.argv[1], manifest=JSON.parse(fs.readFileSync(path.join(output,'patch.json')));
 for(const file of manifest.files.filter(f=>f.path.endsWith('.js'))){
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(output,file.path))).digest('hex'),file.after);
  const chunk=require(path.join(output,file.path));
  const factories=Object.values(chunk.modules).filter(f=>f.toString().includes('zcode-timeout-'));
  assert.equal(factories.length,1);
  const mod={exports:{}}, req=()=>all;
  req.d=(exports,getters)=>{for(const [key,get] of Object.entries(getters))Object.defineProperty(exports,key,{get,enumerable:true});};
  req.a=(m,body)=>{m.promise=new Promise((resolve,reject)=>{body(values=>values,error=>error?reject(error):resolve());});};
  factories[0](mod,mod.exports,req);
  if(mod.promise)await mod.promise;
  const values=Object.values(mod.exports), controller=new AbortController();controller.abort();
  if(file.coverage.includes('NativeZcodeHostClient')){
   const Client=values.find(v=>v?.name==='NativeZcodeHostClient');assert(Client);
   const client=new Client({serverRoot:'/unused'});
   await assert.rejects(client.call('host','unused',[],{signal:controller.signal}),/canceled/);
   clients++;
  }else{
   const Bridge=values.find(v=>v?.name==='NativeZcodeSessionBridge');
   const ErrorClass=values.find(v=>v?.name==='NativeSessionError');assert(Bridge&&ErrorClass);
   const bridge=new Bridge({clientFactory:()=>{throw Error('aborted turn started a client');},workspaceRoot:'/unused',timeoutMs:50});
   await assert.rejects(bridge.execute({scope:'test',selection:{providerId:'test',modelId:'test'},messages:[{role:'user',content:'test'}],tools:[],signal:controller.signal}),e=>e instanceof ErrorClass&&e.status===499);
   await bridge.close();bridges++;
  }
  tested++;
 }
 assert.equal(tested,6);assert.equal(clients,4);assert.equal(bridges,2);
 console.log(JSON.stringify({webpackFactories:tested,hostClients:clients,sessionBridges:bridges,abortedTurns:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
  const result = JSON.parse(
    run(process.execPath, ["-e", test, output], {
      env: { ...process.env, NODE_PATH: join(DONOR, "node_modules") },
    })
  );
  manifest.checks.webpackFactories = result;
  save(join(output, "patch.json"), manifest);
  console.log(JSON.stringify({ phase: "patch-webpack-verified", ...result }));
}
function publishedSources(manifest, sourceSha) {
  fullSha(sourceSha);
  const remoteTip = run("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: ROOT }).split(
    /\s+/
  )[0];
  fullSha(remoteTip);
  run("git", ["merge-base", "--is-ancestor", sourceSha, remoteTip], { cwd: ROOT });
  for (const file of manifest.sources)
    assert.equal(
      sha256(execFileSync("git", ["show", sourceSha + ":" + file.path], { cwd: ROOT })),
      file.sha256,
      "Published source bytes differ from the compiled snapshot"
    );
  return { sourceSha, publishedMain: remoteTip };
}
async function stage(sourceSha) {
  assert.equal(hostname(), "roomhacker-server-100");
  const sources = SOURCES.map((path) => {
    run("git", ["ls-files", "--error-unmatch", "--", path], { cwd: ROOT });
    const bytes = sourceSha
      ? execFileSync("git", ["show", fullSha(sourceSha) + ":" + path], { cwd: ROOT })
      : readFileSync(join(ROOT, path));
    return { path, sha256: sha256(bytes), bytes };
  });
  const sourceSnapshotSha256 = sha256(
    JSON.stringify(sources.map(({ path, sha256 }) => ({ path, sha256 })))
  );
  const name = "input-" + sourceSnapshotSha256.slice(0, 16);
  const directory = join(AREA, name),
    output = join(directory, "output");
  if (existsSync(join(output, "patch.json"))) {
    console.log(JSON.stringify({ phase: "patch-already-staged", artifact: output }));
    return;
  }
  assert.equal(read(join(ROOT, "dist/BUILD_SHA")).trim(), EXPECTED_LIVE);
  const chunks = inventory(join(ROOT, "dist"));
  assert.equal(chunks.filter((chunk) => chunk.markers.includes(MARKERS[0])).length, 4);
  assert.equal(chunks.filter((chunk) => chunk.markers.includes(MARKERS[1])).length, 2);
  assert.deepEqual(inventory(join(STANDBY, "dist")), chunks, "Standby baseline differs");
  const manifest = {
    schema: "omniroute-zcode-timeout-patch/1",
    expectedLive: EXPECTED_LIVE,
    sourceSha: sourceSha || null,
    sourceBaseSha: run("git", ["rev-parse", "HEAD"], { cwd: ROOT }),
    sourceSnapshotSha256,
    sources: sources.map(({ bytes, ...file }) => file),
    chunks,
    lockfileSha256: sha256(readFileSync(join(ROOT, "package-lock.json"))),
    createdAt: stamp(),
  };
  if (sourceSha) Object.assign(manifest, publishedSources(manifest, sourceSha));
  mkdirSync(join(directory, "chunks"), { recursive: true, mode: 0o700 });
  for (const file of sources) {
    const path = join(directory, "source", file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { mode: 0o600 });
  }
  for (const chunk of chunks)
    writeFileSync(
      join(directory, "chunks", chunk.path.split("/").at(-1)),
      readFileSync(join(ROOT, "dist", chunk.path)),
      { mode: 0o600 }
    );
  writeFileSync(
    join(directory, "protocol-before.ts"),
    execFileSync("git", ["show", EXPECTED_LIVE + ":" + SOURCES[2]], { cwd: ROOT }),
    { mode: 0o600 }
  );
  save(join(directory, "input.json"), manifest);
  run("ssh", ["-o", "BatchMode=yes", REMOTE, "mkdir -p " + REMOTE_ROOT]);
  run("scp", ["-q", SELF, REMOTE + ":" + REMOTE_ROOT + "/runner.mjs"]);
  run("scp", ["-qr", directory, REMOTE + ":" + REMOTE_ROOT + "/"]);
  run("ssh", ["-o", "BatchMode=yes", REMOTE, "node " + REMOTE_ROOT + "/runner.mjs remote-stage"], {
    input: JSON.stringify({ directory: join(REMOTE_ROOT, name) }),
    stdio: ["pipe", "inherit", "inherit"],
  });
  run("scp", ["-qr", REMOTE + ":" + join(REMOTE_ROOT, name, "output"), directory + "/"]);
  const result = json(join(output, "patch.json"));
  for (const file of result.files)
    assert.equal(sha256(readFileSync(join(output, file.path))), file.after);
  const receipt = join(RECEIPTS, "deploy-prepare-patch-" + stamp() + ".json");
  save(receipt, {
    ...result,
    artifact: output,
    status: sourceSha ? "compiled-awaiting-standby" : "compiled-awaiting-published-source-sha",
    productionChanged: false,
  });
  console.log(
    JSON.stringify({
      phase: "patch-staged",
      artifact: output,
      receipt,
      sourceSnapshotSha256,
      sourceSha: sourceSha || null,
      chunks: chunks.length,
    })
  );
}

function processState(port) {
  const unit = "omniroute@" + port + ".service";
  const pid = Number(run("systemctl", ["show", unit, "-p", "MainPID", "--value"]));
  assert(pid > 0, "OmniRoute service has no live main process");
  const env = Object.fromEntries(
    read("/proc/" + pid + "/environ")
      .split("\0")
      .filter((item) => item.includes("="))
      .map((item) => {
        const at = item.indexOf("=");
        return [item.slice(0, at), item.slice(at + 1)];
      })
  );
  return {
    pid,
    pkg: env.OMNIROUTE_PKG,
    base: read(join(env.OMNIROUTE_PKG, "dist/BUILD_SHA")).trim(),
    nativeInode: run("sudo", [
      "-n",
      "stat",
      "-Lc",
      "%d:%i",
      "/proc/" + pid + "/root/home/roomhacker/.omniroute/zcode-native",
    ]),
    namespace: run("sudo", ["-n", "readlink", "/proc/" + pid + "/ns/mnt"]),
  };
}
async function health(port, path = "readyz") {
  try {
    return (
      await fetch("http://127.0.0.1:" + port + "/" + path, { signal: AbortSignal.timeout(5000) })
    ).status;
  } catch {
    return 0;
  }
}
async function waitReady(port) {
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    if ((await health(port)) === 200) return;
    if (
      run("systemctl", [
        "show",
        "omniroute@" + port + ".service",
        "-p",
        "ActiveState",
        "--value",
      ]) === "failed"
    )
      break;
    await delay(2000);
  }
  throw new Error("OmniRoute readiness deadline exceeded");
}
function discoverAdmin() {
  const pid = Number(
    run("systemctl", ["--user", "show", "agent-herder.service", "-p", "MainPID", "--value"])
  );
  assert(pid > 0, "Live canonical Herder service is unavailable");
  const args = read("/proc/" + pid + "/cmdline").split("\0");
  const entries = args.filter((arg) =>
    /^\/home\/roomhacker\/agents-projects\/\.fleet-candidate\/releases\/[a-f0-9]{40}\/dist\/index\.js$/.test(
      arg
    )
  );
  assert.equal(entries.length, 1, "Herder canonical release identity is ambiguous");
  const env = read("/proc/" + pid + "/environ").split("\0");
  const ledger =
    env
      .find((item) => item.startsWith("AGENT_HERDER_RELEASE_LEASES="))
      ?.slice("AGENT_HERDER_RELEASE_LEASES=".length) ||
    "/home/roomhacker/.local/state/agent-herder/project-release-leases.json";
  assert.equal(realpathSync(ledger), ledger, "Lease ledger must be canonical");
  const cli = join(dirname(entries[0]), "project-release-admin.js");
  assert(statSync(cli).isFile());
  return { pid, cli, ledger };
}
async function inspect() {
  const primary = processState(20128),
    standby = processState(20130);
  assert.equal(primary.pkg, ROOT);
  assert.equal(standby.pkg, STANDBY);
  assert.equal(primary.base, EXPECTED_LIVE);
  assert.equal(standby.base, EXPECTED_LIVE);
  assert.notEqual(primary.nativeInode, standby.nativeInode, "Native-state isolation is missing");
  assert.notEqual(primary.namespace, standby.namespace);
  assert.equal(await health(20128), 200);
  assert.equal(await health(20130), 200);
  return {
    primary,
    standby,
    admin: discoverAdmin(),
    standbyTarget: readlinkSync(join(STANDBY, "dist")),
  };
}
function checkArtifact(directory, sourceSha) {
  directory = realpathSync(directory);
  assert(directory.startsWith(AREA + "/input-") && directory.endsWith("/output"));
  const manifest = json(join(directory, "patch.json"));
  assert.equal(manifest.schema, "omniroute-zcode-timeout-patch/1");
  assert.equal(manifest.expectedLive, EXPECTED_LIVE);
  assert.equal(manifest.compiledOn, "server-44");
  assert(
    manifest.checks.syntax &&
      manifest.checks.exports &&
      manifest.checks.protocolRuntimeUnchanged &&
      manifest.checks.webpackFactories?.webpackFactories === 6
  );
  for (const file of manifest.files) {
    assert(file.path.startsWith(CHUNKS + "/") && !file.path.includes(".."));
    assert.equal(sha256(readFileSync(join(directory, file.path))), file.after);
    run(process.execPath, ["--check", join(directory, file.path)]);
  }
  Object.assign(manifest, publishedSources(manifest, sourceSha));
  return { directory, manifest };
}
function checkPreimages(dist, manifest) {
  assert.equal(read(join(dist, "BUILD_SHA")).trim(), EXPECTED_LIVE);
  assert.deepEqual(inventory(dist), manifest.chunks, "Compiled baseline chunk inventory changed");
  for (const file of manifest.files) {
    const path = join(dist, file.path);
    if (file.before === null) assert(!existsSync(path), "Patch sidecar already exists");
    else assert.equal(sha256(readFileSync(path)), file.before, "Runtime preimage changed");
  }
}
function installFiles(dist, directory, manifest) {
  for (const file of manifest.files) {
    const destination = join(dist, file.path);
    writeFileSync(destination + ".timeout-new", readFileSync(join(directory, file.path)), {
      mode: 0o644,
      flag: "wx",
    });
    renameSync(destination + ".timeout-new", destination);
  }
  const path = join(dist, "RUNTIME_PATCHES.json");
  const previous = existsSync(path) ? json(path) : null;
  save(path, {
    schema: "omniroute-runtime-patches/1",
    baseBuildSha: EXPECTED_LIVE,
    sourceSha: manifest.sourceSha,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    compiledOn: manifest.compiledOn,
    appliedAt: stamp(),
    files: manifest.files,
    previous,
  });
}
function stopped(port) {
  const unit = "omniroute@" + port + ".service";
  assert.equal(run("systemctl", ["show", unit, "-p", "MainPID", "--value"]), "0");
  assert.equal(run("ss", ["-H", "-ltn", "sport", "=", ":" + port]), "");
}
const control = (action, port) =>
  run("sudo", ["-n", "systemctl", action, "omniroute@" + port + ".service"]);
function assertFlock() {
  const inode = String(statSync(LOCK).ino);
  assert(
    read("/proc/locks")
      .split("\n")
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields[1] === "FLOCK" &&
          fields[3] === "WRITE" &&
          fields[4] === String(process.pid) &&
          fields[5]?.split(":").at(-1) === inode
        );
      }),
    "Canonical deploy flock is not held by this process"
  );
}
async function apply(mode, directory, sourceSha, canaryReceipt) {
  assertFlock();
  const { manifest } = checkArtifact(directory, sourceSha);
  const before = await inspect();
  const port = mode === "standby" ? 20130 : 20128;
  const frozen = realpathSync(join(STANDBY, "dist"));
  if (port === 20128) {
    const installed = json(join(frozen, "RUNTIME_PATCHES.json"));
    assert.equal(installed.sourceSha, sourceSha, "Standby has a different patch");
    assert.equal(installed.sourceSnapshotSha256, manifest.sourceSnapshotSha256);
    for (const file of manifest.files)
      assert.equal(sha256(readFileSync(join(frozen, file.path))), file.after);
    assert(canaryReceipt, "Primary requires the consumer Worker's standby receipt path");
    assert(statSync(canaryReceipt).isFile());
    // The Lead reviews the consumer evidence. Preserve its exact hash in the receipt.
  }
  const sourceDist = port === 20130 ? frozen : join(ROOT, "dist");
  checkPreimages(sourceDist, manifest);
  const tag = stamp() + "-" + manifest.sourceSnapshotSha256.slice(0, 12);
  const staged =
    port === 20130 ? join(STANDBY, "snapshots/timeout-" + tag) : join(AREA, "primary-stage-" + tag);
  assert(!existsSync(staged));
  run("cp", ["-a", "--reflink=auto", sourceDist, staged]);
  installFiles(staged, directory, manifest);
  const adminInfo = discoverAdmin();
  const { runReleaseAdmin } = await import(pathToFileURL(adminInfo.cli).href);
  const owner = {
    hostId: hostname(),
    harness: "codex",
    nativeSessionId: process.env.CODEX_THREAD_ID,
  };
  assert(owner.nativeSessionId, "Native Worker identity unavailable");
  const proofPath = "/home/roomhacker/.local/state/omniroute-timeout-lease-" + tag + ".json";
  const admin = (request, proofOut) =>
    runReleaseAdmin({
      ledger: adminInfo.ledger,
      authorityHost: hostname(),
      request,
      ...(proofOut ? { proofOut } : {}),
    });
  const receipt = join(RECEIPTS, "deploy-prepare-" + mode + "-" + tag + ".json");
  const result = {
    mode,
    sourceSha,
    baseBuildSha: EXPECTED_LIVE,
    staged,
    before,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    ...(canaryReceipt
      ? {
          consumerReceipt: {
            path: resolve(canaryReceipt),
            sha256: sha256(readFileSync(canaryReceipt)),
          },
        }
      : {}),
  };
  const backup = join(AREA, "rollback-" + mode + "-" + tag);
  let proof,
    stopAttempted = false,
    oldDistMoved = false,
    pointerChanged = false;
  const leaseCheck = async () => {
    const checked = await admin({
      action: "check",
      cwd: ROOT,
      owner,
      token: proof.token,
      fence: proof.fence,
    });
    assert.equal(checked.fence, proof.fence, "Release fence changed");
    assert.equal(checked.project, proof.project);
    assert.deepEqual(checked.owner, owner);
  };
  try {
    const acquired = await admin(
      { action: "acquire", cwd: ROOT, owner, ttlSeconds: 1800 },
      proofPath
    );
    assert.equal(acquired.acquired, true, "Project release lease unavailable");
    proof = json(proofPath);
    result.leaseAcquired = true;
    save(receipt, result);
    checkPreimages(sourceDist, manifest);
    assert.deepEqual(processState(port), port === 20130 ? before.standby : before.primary);
    assert.equal(readlinkSync(join(STANDBY, "dist")), before.standbyTarget);
    assert.equal(await health(port === 20130 ? 20128 : 20130), 200);
    // Last awaited gate before touching the running service. Never log its capability.
    await leaseCheck();
    checkPreimages(sourceDist, manifest);
    assert.deepEqual(processState(port), port === 20130 ? before.standby : before.primary);
    assert.equal(readlinkSync(join(STANDBY, "dist")), before.standbyTarget);
    stopAttempted = true;
    control("stop", port);
    stopped(port);
    if (port === 20130) {
      const next = join(STANDBY, "dist.timeout-" + tag);
      symlinkSync("snapshots/" + staged.split("/").at(-1), next);
      renameSync(next, join(STANDBY, "dist"));
      pointerChanged = true;
    } else {
      renameSync(join(ROOT, "dist"), backup);
      oldDistMoved = true;
      renameSync(staged, join(ROOT, "dist"));
    }
    control("start", port);
    await waitReady(port);
    const after = processState(port);
    assert.equal(
      after.nativeInode,
      port === 20130 ? before.standby.nativeInode : before.primary.nativeInode
    );
    assert.notEqual(after.pid, port === 20130 ? before.standby.pid : before.primary.pid);
    assert.equal(after.pkg, port === 20130 ? STANDBY : ROOT);
    assert.equal(await health(port, "api/health"), 200);
    const unchanged = processState(port === 20130 ? 20128 : 20130);
    assert.deepEqual(
      unchanged,
      port === 20130 ? before.primary : before.standby,
      "Peer instance changed during patch installation"
    );
    assert.notEqual(after.nativeInode, unchanged.nativeInode);
    const installedDist = port === 20130 ? realpathSync(join(STANDBY, "dist")) : join(ROOT, "dist");
    for (const file of manifest.files)
      assert.equal(sha256(readFileSync(join(installedDist, file.path))), file.after);
    result.installed = true;
    result.after = after;
    result.rollback = port === 20130 ? { standbyTarget: before.standbyTarget } : { dist: backup };
    result.consumerProof = "pending-separate-worker";
  } catch (error) {
    result.failure = { name: error.name, code: error.code || null };
    if (stopAttempted) {
      try {
        await leaseCheck();
        if (port === 20130 && pointerChanged)
          assert.equal(realpathSync(join(STANDBY, "dist")), staged);
        if (port === 20128 && existsSync(join(ROOT, "dist/RUNTIME_PATCHES.json")))
          assert.equal(
            json(join(ROOT, "dist/RUNTIME_PATCHES.json")).sourceSnapshotSha256,
            manifest.sourceSnapshotSha256
          );
        control("stop", port);
        stopped(port);
        if (port === 20130 && pointerChanged) {
          const next = join(STANDBY, "dist.rollback-" + tag);
          symlinkSync(before.standbyTarget, next);
          renameSync(next, join(STANDBY, "dist"));
        }
        if (port === 20128 && oldDistMoved) {
          if (existsSync(join(ROOT, "dist"))) renameSync(join(ROOT, "dist"), backup + "-failed");
          renameSync(backup, join(ROOT, "dist"));
        }
        control("start", port);
        await waitReady(port);
        checkPreimages(
          port === 20130 ? realpathSync(join(STANDBY, "dist")) : join(ROOT, "dist"),
          manifest
        );
        result.rolledBack = true;
      } catch (failure) {
        result.rollbackFailure = { name: failure.name, code: failure.code || null };
      }
    }
    process.exitCode = 1;
  } finally {
    try {
      if (proof) {
        const released = await admin({
          action: "release",
          cwd: ROOT,
          owner,
          token: proof.token,
          fence: proof.fence,
        });
        assert.equal(released.released, true);
        result.leaseReleased = true;
        unlinkSync(proofPath);
      }
    } catch {
      result.leaseReleaseFailed = true;
      process.exitCode = 1;
    }
    result.finishedAt = stamp();
    save(receipt, result);
    console.log(
      JSON.stringify({
        receipt,
        installed: result.installed || false,
        rolledBack: result.rolledBack || false,
        mode,
      })
    );
  }
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const allowed = new Set(["--source-sha", "--artifact", "--consumer-receipt", "--locked"]);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    assert(allowed.has(args[i]) && !(args[i] in flags), "Unknown or duplicate argument");
    flags[args[i]] = args[i] === "--locked" ? true : args[++i];
  }
  if (mode === "remote-stage") {
    return remoteStage(JSON.parse(readFileSync(0, "utf8")).directory);
  }
  if (mode === "remote-verify") {
    return remoteVerify(JSON.parse(readFileSync(0, "utf8")).directory);
  }
  assert.equal(hostname(), "roomhacker-server-100");
  assert.equal(realpathSync(process.cwd()), ROOT);
  if (mode === "stage") return stage(flags["--source-sha"]);
  if (mode === "inspect") {
    const result = await inspect();
    result.chunks = inventory(join(ROOT, "dist"));
    const receipt = join(RECEIPTS, "deploy-prepare-inspect-" + stamp() + ".json");
    save(receipt, result);
    console.log(JSON.stringify({ receipt, ...result }));
    return;
  }
  assert(
    ["prepare", "standby", "primary"].includes(mode),
    "Usage: patch helper stage|inspect|prepare|standby|primary [--source-sha SHA --artifact DIR]"
  );
  const sourceSha = fullSha(flags["--source-sha"]),
    directory = resolve(flags["--artifact"] || "");
  if (mode === "prepare") {
    const { manifest } = checkArtifact(directory, sourceSha);
    const state = await inspect();
    checkPreimages(join(ROOT, "dist"), manifest);
    save(join(directory, "patch.json"), manifest);
    const receipt = join(RECEIPTS, "deploy-prepare-ready-" + stamp() + ".json");
    save(receipt, { ...manifest, state, artifact: directory, productionChanged: false });
    console.log(
      JSON.stringify({ receipt, artifact: directory, sourceSha, phase: "ready-for-standby" })
    );
    return;
  }
  if (!flags["--locked"]) {
    const child = spawnSync(
      "flock",
      ["-n", "--no-fork", LOCK, process.execPath, SELF, mode, ...args, "--locked"],
      { stdio: "inherit" }
    );
    process.exitCode = child.status ?? 1;
    return;
  }
  return apply(mode, directory, sourceSha, flags["--consumer-receipt"]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // Lease validation errors may contain capabilities; never echo their messages.
    console.error(
      JSON.stringify({ phase: "patch-helper-failed", name: error.name, code: error.code || null })
    );
    process.exitCode = 1;
  });
