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
const OVERLAY_BASE_SOURCE = "5eeb4c0afcdb0fc4da4fa259068d9b0f21417876";
const EXECUTOR_SOURCE = "open-sse/executors/zcode.ts";
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
function nativeBranch(text, parse, sourceType = "script") {
  const hits = [];
  walk(parse(text, { ecmaVersion: "latest", sourceType }), (node) => {
    if (
      node.type === "IfStatement" &&
      text.slice(node.test.start, node.test.end).includes("native-host") &&
      text.slice(node.consequent.start, node.consequent.end).includes("zcode://native-host/session")
    )
      hits.push(node.consequent);
  });
  assert.equal(hits.length, 1, "Native executor branch is ambiguous");
  return hits[0];
}
function executorMap(dist) {
  const require = createRequire(join(ROOT, "package.json"));
  const { parse } = require("acorn");
  return ["37000.js", "41147.js"].map((name) => {
    const path = join(CHUNKS, name),
      text = read(join(dist, path));
    const node = nativeBranch(text, parse),
      body = text.slice(node.start, node.end);
    const errorResponse = name === "37000.js" ? "n.errorResponse" : "n.yj";
    for (const anchor of [
      "t.nativeZcodeHosts.ensure",
      "new r.A",
      "new s.m",
      "s.k",
      "J.get",
      errorResponse,
    ])
      assert(body.includes(anchor), "Executor dependency bindings changed");
    for (const anchor of [
      "async function F(",
      "function G(",
      "function H(",
      "function y(",
      "function E(",
      "function w(",
    ])
      assert(text.includes(anchor), "Executor helper binding changed");
    const dependencies = {
      nativeZcodeHosts: "t.nativeZcodeHosts",
      NativeZcodeHostClient: "r.A",
      NativeZcodeSessionBridge: "s.m",
      NativeSessionError: "s.k",
      nativeBridges: "J",
      tmpdir: "f.tmpdir",
      join: "g.join",
      createHash: "q.createHash",
      errorResponse,
      sanitizeErrorMessage: "n.sanitizeErrorMessage",
      errorText: "G",
      asRecord: "w",
      withAbort: "F",
      resolveZcodeSelection: "y",
      modelResponse: "E",
      isZcodeRequestCancelled: "H",
      UPSTREAM_REQUEST_CANCELLED_CODE: '"upstream_request_cancelled"',
    };
    return {
      path,
      sha256: sha256(text),
      branchSha256: sha256(body),
      dependencies,
      coverage: ["ZcodeExecutor.native-host"],
    };
  });
}
export function patchExecutorBranch(text, parse, entry, sidecar) {
  assert.equal(sha256(text), entry.sha256);
  const node = nativeBranch(text, parse);
  assert.equal(sha256(text.slice(node.start, node.end)), entry.branchSha256);
  const dependencies = Object.entries(entry.dependencies)
    .map(([name, value]) => name + ":(" + value + ")")
    .join(",");
  const replacement =
    '{return await require(__dirname + "/' +
    sidecar +
    '").runNativeExecutor.call(this,{' +
    dependencies +
    "},a,b,c);}";
  const after = text.slice(0, node.start) + replacement + text.slice(node.end);
  parse(after, { ecmaVersion: "latest" });
  return { after, coverage: entry.coverage };
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
  const sidecar = manifest.overlay
    ? manifest.overlay.sidecarPath.split("/").at(-1)
    : "zcode-timeout-" + manifest.sourceSnapshotSha256.slice(0, 16) + ".cjs";
  let bundle =
    '"use strict";\n' +
    "function loadSession(){const module={exports:{}};const exports=module.exports;\n" +
    code[SOURCES[1]] +
    "\nreturn module.exports;}\n" +
    "function loadClient(require){const module={exports:{}};const exports=module.exports;\n" +
    code[SOURCES[0]] +
    "\nreturn module.exports.NativeZcodeHostClient;}\n" +
    "Object.assign(exports,loadSession());\n" +
    'exports.createHostClient=(protocol)=>loadClient((name)=>name==="../zcodeProtocol.ts"?protocol:require(name));\n';
  if (manifest.overlay?.executorMap) {
    const options = { loader: "ts", format: "esm", target: "node22", sourcemap: false };
    const previousCode = (
      await transform(read(join(inputDirectory, "executor-before.ts")), options)
    ).code;
    const candidateCode = (
      await transform(read(join(inputDirectory, "source", EXECUTOR_SOURCE)), options)
    ).code;
    const previousBlock = nativeBranch(previousCode, parse, "module");
    const candidateBlock = nativeBranch(candidateCode, parse, "module");
    const outside = (text, block) => text.slice(0, block.start) + "{}" + text.slice(block.end);
    assert.equal(
      outside(candidateCode, candidateBlock),
      outside(previousCode, previousBlock),
      "Executor changes outside the native-host branch require an expanded review"
    );
    const names = Object.keys(manifest.overlay.executorMap[0].dependencies).join(",");
    bundle +=
      "exports.runNativeExecutor=async function(__dependencies,input,request,resolution){const {" +
      names +
      "}=__dependencies;\n" +
      candidateCode.slice(candidateBlock.start + 1, candidateBlock.end - 1) +
      "\n};\n";
  }
  const output = join(inputDirectory, "output");
  assert(!existsSync(output), "Output exists; inspect the previous attempt before replay");
  mkdirSync(join(output, CHUNKS), { recursive: true, mode: 0o700 });
  writeFileSync(join(output, CHUNKS, sidecar), bundle, { mode: 0o644 });
  manifest.files = [
    {
      path: join(CHUNKS, sidecar),
      before: manifest.overlay
        ? manifest.overlay.files.find((file) => file.path === manifest.overlay.sidecarPath).sha256
        : null,
      after: sha256(bundle),
    },
  ];
  for (const chunk of manifest.chunks) {
    const before = read(join(inputDirectory, "chunks", chunk.path.split("/").at(-1)));
    assert.equal(sha256(before), chunk.sha256);
    let patched = manifest.overlay
      ? { after: before, coverage: chunk.coverage }
      : patchChunk(before, parse, sidecar);
    const executor = manifest.overlay?.executorMap?.find((entry) => entry.path === chunk.path);
    if (executor) {
      patched = patchExecutorBranch(before, parse, executor, sidecar);
      patched.coverage = [...new Set([...chunk.coverage, ...patched.coverage])];
    }
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
  if (manifest.overlay) {
    run("cp", ["-a", join(inputDirectory, "rollback"), join(output, "rollback")]);
    const executorPaths = manifest.overlay.executorMap?.map((entry) => entry.path) || [];
    manifest.checks.wrapperChunksUnchanged = !executorPaths.length;
    manifest.checks.nonExecutorChunksUnchanged = manifest.files
      .filter((file) => file.path.endsWith(".js") && !executorPaths.includes(file.path))
      .every((file) => file.before === file.after);
    manifest.checks.executorBranchOnly = executorPaths;
    assert(manifest.checks.nonExecutorChunksUnchanged);
  }
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
 for(const file of manifest.files.filter(f=>f.coverage?.some(c=>['NativeZcodeHostClient','NativeZcodeSessionBridge'].includes(c)))){
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(output,file.path))).digest('hex'),file.after);
  const chunk=require(path.join(output,file.path));
  const factories=Object.values(chunk.modules).filter(f=>file.coverage.includes('NativeZcodeHostClient')?f.toString().includes('.createHostClient('):f.toString().includes('.NativeZcodeSessionBridge'));
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
 let executorSmoke=null;
 if(manifest.overlay?.executorMap){
  const p=require(path.join(output,manifest.overlay.sidecarPath)), observed=[];
  class Client{async start(options){assert(options?.timeoutMs>0&&options.timeoutMs<=500);assert(options.signal);observed.push('start');}async call(channel,method,args,options){assert.equal(method,'getView');assert(options?.timeoutMs>0);observed.push('getView');return {};}async close(){observed.push('close');}}
  class Bridge{async execute(input){assert(Number.isFinite(input.deadline));assert(input.deadline<=Date.now()+500);observed.push('deadline');return {text:'fixture-ok'};}}
  const withAbort=(promise,signal)=>Promise.race([promise,new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})]);
  const deps={nativeZcodeHosts:{ensure:async()=>'/fixture-root'},NativeZcodeHostClient:Client,NativeZcodeSessionBridge:Bridge,NativeSessionError:p.NativeSessionError,nativeBridges:new Map(),tmpdir:()=>'/fixture',join:path.join,createHash:require('node:crypto').createHash,errorResponse:(status,message,extra)=>({status,message,extra}),sanitizeErrorMessage:s=>s,errorText:e=>e.message,asRecord:v=>v&&typeof v==='object'?v:{},withAbort,resolveZcodeSelection:()=>({providerId:'fixture',modelId:'fixture'}),modelResponse:(_model,result)=>result,isZcodeRequestCancelled:()=>false,UPSTREAM_REQUEST_CANCELLED_CODE:'upstream_request_cancelled'};
  const input={credentials:{authType:'oauth',connectionId:'fixture'},body:{messages:[{role:'user',content:'fixture'}]},signal:new AbortController().signal};
  const context={options:{provider:'fixture'},turnTimeoutMs:()=>500};
  const result=await p.runNativeExecutor.call(context,deps,input,{messages:[{content:'fixture'}],tools:[]},{model:'fixture'});
  assert.equal(result.url,'zcode://native-host/session');assert.equal(result.response.text,'fixture-ok');assert.deepEqual(observed,['start','getView','deadline','close']);
  const cancelled=new AbortController();cancelled.abort();
  const rejected=await p.runNativeExecutor.call(context,deps,{...input,signal:cancelled.signal},{messages:[],tools:[]},{model:'fixture'});
  assert.equal(rejected.status,499);
  executorSmoke={boundedPreflight:true,deadlinePassed:true,cancellation:true};
 }
 console.log(JSON.stringify({webpackFactories:tested,hostClients:clients,sessionBridges:bridges,abortedTurns:true,executorSmoke}));
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

async function stageOverlay(sourceSha, baselineDirectory) {
  fullSha(sourceSha);
  assert.notEqual(sourceSha, OVERLAY_BASE_SOURCE, "A new source SHA is required");
  baselineDirectory = realpathSync(baselineDirectory);
  assert(baselineDirectory.startsWith(AREA + "/overlay-base-"));
  const baseline = json(join(baselineDirectory, "baseline.json"));
  assert.equal(baseline.schema, "omniroute-zcode-timeout-overlay-base/1");
  const changedPaths = run(
    "git",
    [
      "diff",
      "--name-only",
      OVERLAY_BASE_SOURCE,
      sourceSha,
      "--",
      "open-sse/executors/zcode",
      "open-sse/executors/zcode.ts",
      SOURCES[2],
    ],
    { cwd: ROOT }
  )
    .split("\n")
    .filter(Boolean);
  const needsExecutor = changedPaths.includes(EXECUTOR_SOURCE);
  const outside = changedPaths.filter((file) => ![...SOURCES, EXECUTOR_SOURCE].includes(file));
  if (outside.length)
    console.log(JSON.stringify({ phase: "overlay-needs-expanded-map", files: outside }));
  assert.equal(outside.length, 0, "Runtime changes exceed the client/session sidecar boundary");
  const sources = [...SOURCES, ...(needsExecutor ? [EXECUTOR_SOURCE] : [])].map((path) => {
    const bytes = execFileSync("git", ["show", sourceSha + ":" + path], { cwd: ROOT });
    return { path, sha256: sha256(bytes), bytes };
  });
  const sourceSnapshotSha256 = sha256(JSON.stringify(sources.map(({ bytes, ...file }) => file)));
  const name = "input-v2-" + sourceSnapshotSha256.slice(0, 16);
  const directory = join(AREA, name),
    output = join(directory, "output");
  const overlay = { ...baseline };
  if (needsExecutor) {
    assert.equal(baseline.executorCandidates?.length, 2, "Capture an executor-aware overlay base");
    overlay.executorMap = baseline.executorCandidates;
    overlay.files = [...baseline.files, ...baseline.extraFiles];
  }
  const manifest = {
    schema: "omniroute-zcode-timeout-patch/2",
    expectedLive: EXPECTED_LIVE,
    sourceSha,
    sourceSnapshotSha256,
    sources: sources.map(({ bytes, ...file }) => file),
    overlay,
    chunks: overlay.files.filter((file) => file.path.endsWith(".js")),
    lockfileSha256: sha256(
      execFileSync("git", ["show", sourceSha + ":package-lock.json"], { cwd: ROOT })
    ),
    createdAt: stamp(),
  };
  Object.assign(manifest, publishedSources(manifest, sourceSha));
  checkOverlayPreimages(join(ROOT, "dist"), manifest);
  checkOverlayPreimages(join(STANDBY, "dist"), manifest);
  if (existsSync(join(output, "patch.json"))) {
    const existing = checkArtifact(output, sourceSha);
    save(join(output, "patch.json"), existing.manifest);
    console.log(JSON.stringify({ phase: "overlay-already-staged", artifact: output, sourceSha }));
    return;
  }
  mkdirSync(join(directory, "chunks"), { recursive: true, mode: 0o700 });
  for (const file of sources) {
    const path = join(directory, "source", file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { mode: 0o600 });
  }
  for (const chunk of manifest.chunks)
    writeFileSync(
      join(directory, "chunks", chunk.path.split("/").at(-1)),
      readFileSync(join(baselineDirectory, "rollback", chunk.path)),
      { mode: 0o600 }
    );
  run("cp", ["-a", join(baselineDirectory, "rollback"), join(directory, "rollback")]);
  writeFileSync(
    join(directory, "protocol-before.ts"),
    execFileSync("git", ["show", OVERLAY_BASE_SOURCE + ":" + SOURCES[2]], { cwd: ROOT }),
    { mode: 0o600 }
  );
  if (needsExecutor)
    writeFileSync(
      join(directory, "executor-before.ts"),
      execFileSync("git", ["show", OVERLAY_BASE_SOURCE + ":" + EXECUTOR_SOURCE], { cwd: ROOT }),
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
  const result = checkArtifact(output, sourceSha).manifest;
  const receipt = join(RECEIPTS, "deploy-prepare-v2-staged-" + stamp() + ".json");
  save(receipt, {
    ...result,
    artifact: output,
    productionChanged: false,
    status: "compiled-awaiting-lead-review-no-live-apply",
  });
  console.log(
    JSON.stringify({
      phase: "overlay-staged",
      artifact: output,
      receipt,
      sourceSha,
      filesReplaced: needsExecutor ? 3 : 1,
      executorBranches: needsExecutor ? 2 : 0,
      rollbackSourceSha: OVERLAY_BASE_SOURCE,
    })
  );
}
function overlayBaseFiles(dist) {
  const raw = readFileSync(join(dist, "RUNTIME_PATCHES.json"));
  const manifest = JSON.parse(raw);
  assert.equal(read(join(dist, "BUILD_SHA")).trim(), EXPECTED_LIVE);
  assert.equal(manifest.sourceSha, OVERLAY_BASE_SOURCE, "Overlay requires installed patch 5eeb");
  assert.equal(manifest.files.length, 7);
  const files = manifest.files.map((file) => {
    assert.equal(dirname(file.path), CHUNKS);
    assert.equal(
      sha256(readFileSync(join(dist, file.path))),
      file.after,
      "Installed overlay base file differs from its manifest"
    );
    return { path: file.path, sha256: file.after, coverage: file.coverage || [] };
  });
  assert.equal(new Set(files.map((file) => file.path)).size, 7);
  assert.equal(files.filter((file) => file.path.endsWith(".cjs")).length, 1);
  assert.equal(files.filter((file) => file.path.endsWith(".js")).length, 6);
  return { raw, manifest, files };
}
function captureOverlayBase() {
  assertFlock();
  const primary = processState(20128),
    standby = processState(20130);
  assert.equal(primary.pkg, ROOT);
  assert.equal(standby.pkg, STANDBY);
  assert.notEqual(primary.nativeInode, standby.nativeInode);
  const current = overlayBaseFiles(join(ROOT, "dist"));
  const frozen = overlayBaseFiles(join(STANDBY, "dist"));
  assert.deepEqual(current.files, frozen.files, "Primary/standby patch bases differ");
  assert.equal(current.manifest.sourceSnapshotSha256, frozen.manifest.sourceSnapshotSha256);
  const executorCandidates = executorMap(join(ROOT, "dist"));
  assert.deepEqual(
    executorMap(join(STANDBY, "dist")),
    executorCandidates,
    "Primary/standby executor branches differ"
  );
  const extraFiles = executorCandidates
    .filter((entry) => !current.files.some((file) => file.path === entry.path))
    .map(({ path, sha256 }) => ({ path, sha256, coverage: [] }));
  const directory = join(AREA, "overlay-base-" + stamp());
  mkdirSync(join(directory, "rollback", CHUNKS), { recursive: true, mode: 0o700 });
  for (const file of [...current.files, ...extraFiles])
    writeFileSync(
      join(directory, "rollback", file.path),
      readFileSync(join(ROOT, "dist", file.path)),
      { mode: 0o600, flag: "wx" }
    );
  const previousManifests = {};
  for (const [role, base] of Object.entries({ primary: current, standby: frozen })) {
    const file = "rollback/" + role + ".RUNTIME_PATCHES.json";
    writeFileSync(join(directory, file), base.raw, { mode: 0o600, flag: "wx" });
    previousManifests[role] = { file, sha256: sha256(base.raw) };
  }
  const baseline = {
    schema: "omniroute-zcode-timeout-overlay-base/1",
    directory,
    expectedLive: EXPECTED_LIVE,
    expectedSourceSha: OVERLAY_BASE_SOURCE,
    expectedSnapshotSha256: current.manifest.sourceSnapshotSha256,
    sidecarPath: current.files.find((file) => file.path.endsWith(".cjs")).path,
    files: current.files,
    extraFiles,
    executorCandidates,
    previousManifests,
    instances: { primary, standby },
    capturedAt: new Date().toISOString(),
  };
  assert.deepEqual(processState(20128), primary);
  assert.deepEqual(processState(20130), standby);
  for (const [role, pkg] of Object.entries({ primary: ROOT, standby: STANDBY }))
    assert.equal(
      sha256(readFileSync(join(pkg, "dist/RUNTIME_PATCHES.json"))),
      previousManifests[role].sha256
    );
  for (const file of [...current.files, ...extraFiles])
    for (const pkg of [ROOT, STANDBY])
      assert.equal(sha256(readFileSync(join(pkg, "dist", file.path))), file.sha256);
  save(join(directory, "baseline.json"), baseline);
  const receipt = join(RECEIPTS, "deploy-prepare-v2-baseline-" + stamp() + ".json");
  save(receipt, {
    ...baseline,
    status: "preimages-saved-awaiting-source-sha-and-lead-review",
    productionChanged: false,
  });
  console.log(
    JSON.stringify({
      phase: "overlay-base-captured",
      directory,
      receipt,
      files: baseline.files.length,
      sidecarPath: baseline.sidecarPath,
      productionChanged: false,
    })
  );
}
export function checkOverlayPreimages(dist, manifest) {
  const overlay = manifest.overlay;
  assert(overlay, "Overlay metadata required");
  assert.equal(read(join(dist, "BUILD_SHA")).trim(), EXPECTED_LIVE);
  const raw = readFileSync(join(dist, "RUNTIME_PATCHES.json")),
    current = JSON.parse(raw);
  assert.equal(current.sourceSha, overlay.expectedSourceSha, "Installed source patch changed");
  assert.equal(
    current.sourceSnapshotSha256,
    overlay.expectedSnapshotSha256,
    "Installed source snapshot changed"
  );
  const role = realpathSync(dist) === realpathSync(join(ROOT, "dist")) ? "primary" : "standby";
  assert.equal(
    sha256(raw),
    overlay.previousManifests[role].sha256,
    "Previous runtime manifest changed"
  );
  assert.equal(overlay.files.length, overlay.executorMap ? 8 : 7);
  for (const file of overlay.files)
    assert.equal(
      sha256(readFileSync(join(dist, file.path))),
      file.sha256,
      "Overlay runtime preimage changed"
    );
}
export function checkOverlayArtifact(directory, manifest) {
  const overlay = manifest.overlay;
  assert.equal(manifest.schema, "omniroute-zcode-timeout-patch/2");
  assert.equal(overlay.expectedSourceSha, OVERLAY_BASE_SOURCE);
  const executorPaths = overlay.executorMap?.map((entry) => entry.path) || [];
  const size = executorPaths.length ? 8 : 7;
  assert.equal(manifest.files.length, size);
  assert.equal(overlay.files.length, size);
  assert.equal(new Set(manifest.files.map((file) => file.path)).size, size);
  assert.equal(new Set(overlay.files.map((file) => file.path)).size, size);
  const changed = manifest.files.filter((file) => file.before !== file.after);
  assert.deepEqual(
    changed.map((file) => file.path).sort(),
    [overlay.sidecarPath, ...executorPaths].sort(),
    "Overlay replacements exceed the reviewed map"
  );
  assert(overlay.sidecarPath.endsWith(".cjs"));
  for (const file of overlay.files) {
    assert.equal(dirname(file.path), CHUNKS);
    assert.equal(
      sha256(readFileSync(join(directory, "rollback", file.path))),
      file.sha256,
      "Rollback patch 5eeb file changed"
    );
    const candidate = manifest.files.find((item) => item.path === file.path);
    assert(candidate);
    assert.equal(candidate.before, file.sha256);
    if (file.path !== overlay.sidecarPath && !executorPaths.includes(file.path))
      assert.equal(candidate.after, file.sha256);
  }
  for (const previous of Object.values(overlay.previousManifests)) {
    assert(/^rollback\/(primary|standby)\.RUNTIME_PATCHES\.json$/.test(previous.file));
    const raw = readFileSync(join(directory, previous.file));
    assert.equal(sha256(raw), previous.sha256, "Rollback manifest preimage changed");
    assert.equal(JSON.parse(raw).sourceSha, overlay.expectedSourceSha);
  }
  if (executorPaths.length) {
    assert.deepEqual(executorPaths.slice().sort(), [
      join(CHUNKS, "37000.js"),
      join(CHUNKS, "41147.js"),
    ]);
    assert.equal(manifest.checks.nonExecutorChunksUnchanged, true);
    assert.deepEqual(
      manifest.checks.executorBranchOnly.slice().sort(),
      executorPaths.slice().sort()
    );
    assert.equal(manifest.checks.webpackFactories?.executorSmoke?.boundedPreflight, true);
    assert.equal(manifest.checks.webpackFactories?.executorSmoke?.deadlinePassed, true);
    assert.equal(manifest.checks.webpackFactories?.executorSmoke?.cancellation, true);
  } else assert.equal(manifest.checks.wrapperChunksUnchanged, true);
}
export function checkOverlaySourceCoverage(manifest, changed) {
  assert(
    changed.every((file) => [...SOURCES, EXECUTOR_SOURCE].includes(file)),
    "Published source delta exceeds the overlay boundary"
  );
  const requiresExecutor = changed.includes(EXECUTOR_SOURCE);
  assert.equal(
    Boolean(manifest.overlay.executorMap),
    requiresExecutor,
    "Overlay would omit the published native executor delta"
  );
  assert.deepEqual(
    manifest.sources.map((file) => file.path).sort(),
    [...SOURCES, ...(requiresExecutor ? [EXECUTOR_SOURCE] : [])].sort()
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
  assert(
    ["omniroute-zcode-timeout-patch/1", "omniroute-zcode-timeout-patch/2"].includes(manifest.schema)
  );
  assert.equal(Boolean(manifest.overlay), manifest.schema.endsWith("/2"));
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
  if (manifest.overlay) {
    checkOverlayArtifact(directory, manifest);
    const changed = run(
      "git",
      [
        "diff",
        "--name-only",
        OVERLAY_BASE_SOURCE,
        sourceSha,
        "--",
        "open-sse/executors/zcode",
        EXECUTOR_SOURCE,
        SOURCES[2],
      ],
      { cwd: ROOT }
    )
      .split("\n")
      .filter(Boolean);
    checkOverlaySourceCoverage(manifest, changed);
  }
  Object.assign(manifest, publishedSources(manifest, sourceSha));
  return { directory, manifest };
}
export function checkPreimages(dist, manifest) {
  if (manifest.overlay) return checkOverlayPreimages(dist, manifest);
  assert.equal(read(join(dist, "BUILD_SHA")).trim(), EXPECTED_LIVE);
  assert.deepEqual(inventory(dist), manifest.chunks, "Compiled baseline chunk inventory changed");
  for (const file of manifest.files) {
    const path = join(dist, file.path);
    if (file.before === null) assert(!existsSync(path), "Patch sidecar already exists");
    else assert.equal(sha256(readFileSync(path)), file.before, "Runtime preimage changed");
  }
}
export function installFiles(dist, directory, manifest) {
  for (const file of manifest.files) {
    if (file.before === file.after) continue;
    const destination = join(dist, file.path);
    writeFileSync(destination + ".timeout-new", readFileSync(join(directory, file.path)), {
      mode: 0o644,
      flag: "wx",
    });
    renameSync(destination + ".timeout-new", destination);
  }
  const path = join(dist, "RUNTIME_PATCHES.json");
  const previousRaw = existsSync(path) ? readFileSync(path) : null;
  const previous = previousRaw ? JSON.parse(previousRaw) : null;
  if (manifest.overlay) {
    assert(previousRaw);
    writeFileSync(
      join(dist, "RUNTIME_PATCHES.previous-" + previous.sourceSha.slice(0, 10) + ".json"),
      previousRaw,
      { mode: 0o600, flag: "wx" }
    );
  }
  save(path, {
    schema: "omniroute-runtime-patches/1",
    baseBuildSha: EXPECTED_LIVE,
    sourceSha: manifest.sourceSha,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    compiledOn: manifest.compiledOn,
    appliedAt: stamp(),
    files: manifest.files,
    previous,
    ...(manifest.overlay
      ? {
          previousManifestSha256: sha256(previousRaw),
          checks: manifest.checks,
          rollbackSourceSha: manifest.overlay.expectedSourceSha,
          overlayOnly: manifest.overlay.sidecarPath,
        }
      : {}),
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
  const allowed = new Set([
    "--source-sha",
    "--artifact",
    "--consumer-receipt",
    "--baseline",
    "--locked",
  ]);
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
  if (mode === "overlay-base") {
    if (!flags["--locked"]) {
      const child = spawnSync(
        "flock",
        ["-n", "--no-fork", LOCK, process.execPath, SELF, mode, "--locked"],
        { stdio: "inherit" }
      );
      process.exitCode = child.status ?? 1;
      return;
    }
    return captureOverlayBase();
  }
  if (mode === "stage-overlay")
    return stageOverlay(fullSha(flags["--source-sha"]), flags["--baseline"]);
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
