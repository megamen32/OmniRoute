import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
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
      (text
        .slice(node.consequent.start, node.consequent.end)
        .includes("zcode://native-host/session") ||
        text.slice(node.consequent.start, node.consequent.end).includes('"generateWorkspaceText"'))
    )
      hits.push(node.consequent);
  });
  assert.equal(hits.length, 1, "Native executor branch is ambiguous");
  return hits[0];
}
// These functions already exist in both frozen webpack factories. Do not add
// imports or replace a factory to make new native-only request mapping work.
export function extendExecutorBindings(text, parse, entry) {
  assert.equal(sha256(text), entry.sha256, "Executor preimage changed");
  const node = nativeBranch(text, parse);
  assert.equal(sha256(text.slice(node.start, node.end)), entry.branchSha256);
  const dependencies = { ...entry.dependencies };
  for (const [name, binding] of Object.entries({
    buildZcodeModelRequest: "C",
    resolveZcodeMaxTokens: "z",
  })) {
    assert(text.includes("function " + binding + "("), "Body helper binding changed");
    assert(!dependencies[name] || dependencies[name] === binding);
    dependencies[name] = binding;
  }
  return { ...entry, dependencies };
}
function nativeOutsideWithCleanup(previousCode, candidateCode, parse, previousBlock) {
  const options = { ecmaVersion: "latest", sourceType: "module" };
  const previous = parse(previousCode, options),
    candidate = parse(candidateCode, options);
  const imports = candidate.body.filter((node) => node.type === "ImportDeclaration");
  const exactImport = (node, source, names) =>
    node.type === "ImportDeclaration" &&
    node.source.value === source &&
    !node.attributes?.length &&
    !node.assertions?.length &&
    node.specifiers.length === names.length &&
    node.specifiers.every(
      (specifier, index) =>
        specifier.type === "ImportSpecifier" &&
        specifier.imported.name === names[index] &&
        specifier.local.name === names[index]
    );
  const changes = [],
    removed = new Set();
  const remove = (node, name) => {
    // Remove only this statement and its terminating newline, not surrounding
    // code/comments/whitespace. This is deletion-only, never normalize additions.
    const end = previousCode.startsWith("\r\n", node.end)
      ? node.end + 2
      : previousCode[node.end] === "\n"
        ? node.end + 1
        : node.end;
    changes.push({ node, start: node.start, end, replacement: "" });
    removed.add(name);
  };
  for (const node of previous.body) {
    for (const [source, name] of [
      ["node:crypto", "createHash"],
      ["node:os", "tmpdir"],
    ])
      if (
        exactImport(node, source, [name]) &&
        !imports.some((entry) =>
          entry.specifiers.some((specifier) => specifier.local.name === name)
        )
      )
        remove(node, name);
    if (
      exactImport(node, "./zcode/nativeSession.ts", [
        "NativeZcodeSessionBridge",
        "NativeSessionError",
      ]) &&
      !imports.some((entry) =>
        entry.specifiers.some((specifier) => specifier.local.name === "NativeZcodeSessionBridge")
      )
    ) {
      const retained = imports.filter((entry) =>
        exactImport(entry, "./zcode/nativeSession.ts", ["NativeSessionError"])
      );
      assert.equal(retained.length, 1, "NativeSessionError import changed outside native branch");
      changes.push({
        node,
        start: node.start,
        end: node.end,
        replacement: candidateCode.slice(retained[0].start, retained[0].end),
      });
      removed.add("NativeZcodeSessionBridge");
    }
    const declaration = node.type === "VariableDeclaration" && node.declarations[0];
    if (
      node.kind === "const" &&
      node.declarations?.length === 1 &&
      declaration.id.type === "Identifier" &&
      declaration.id.name === "nativeBridges" &&
      declaration.init?.type === "NewExpression" &&
      declaration.init.callee.type === "Identifier" &&
      declaration.init.callee.name === "Map" &&
      declaration.init.arguments.length === 0 &&
      !candidate.body.some(
        (entry) =>
          entry.type === "VariableDeclaration" &&
          entry.declarations.some((value) => value.id.name === "nativeBridges")
      )
    )
      remove(node, "nativeBridges");
  }
  const ignored = new Set([previousBlock, ...changes.map((change) => change.node)]);
  const referencedOutside = (node) => {
    if (!node || typeof node !== "object" || ignored.has(node)) return false;
    // previousBlock came from the selector's separate parse. Compare its exact
    // range rather than node identity so old native-only uses remain excluded.
    if (
      node.type === "BlockStatement" &&
      node.start === previousBlock.start &&
      node.end === previousBlock.end
    )
      return false;
    if (node.type === "Identifier" && removed.has(node.name)) return true;
    return Object.values(node).some((value) =>
      Array.isArray(value) ? value.some(referencedOutside) : referencedOutside(value)
    );
  };
  assert(
    !referencedOutside(previous),
    "Removed native binding is still used outside native branch"
  );
  changes.push({ start: previousBlock.start, end: previousBlock.end, replacement: "{}" });
  let normalized = previousCode;
  for (const change of changes.sort((a, b) => b.start - a.start))
    normalized =
      normalized.slice(0, change.start) + change.replacement + normalized.slice(change.end);
  return normalized;
}
export function nativeExecutorSource(previousCode, candidateCode, parse, dependencies) {
  const previousBlock = nativeBranch(previousCode, parse, "module");
  const candidateBlock = nativeBranch(candidateCode, parse, "module");
  const outside = (text, block) => text.slice(0, block.start) + "{}" + text.slice(block.end);
  assert.equal(
    outside(candidateCode, candidateBlock),
    nativeOutsideWithCleanup(previousCode, candidateCode, parse, previousBlock),
    "Executor changes outside the native-host branch require an expanded review"
  );
  const body = candidateCode.slice(candidateBlock.start + 1, candidateBlock.end - 1);
  assert(body.includes('"generateWorkspaceText"'), "Expected plain native model route");
  // The frozen bundler inlined this helper at its old call site. Reuse its
  // unchanged source inside the native wrapper, rather than inventing a binding.
  const helper = parse(candidateCode, { ecmaVersion: "latest", sourceType: "module" }).body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === "boundMaxOutputTokens"
  );
  const local = /\bboundMaxOutputTokens\b/.test(body) ? helper : null;
  assert(!/\bboundMaxOutputTokens\b/.test(body) || local, "Native token-bound helper is missing");
  const constant = parse(candidateCode, { ecmaVersion: "latest", sourceType: "module" })
    .body.filter((node) => node.type === "VariableDeclaration")
    .flatMap((node) => node.declarations)
    .find((node) => node.id?.name === "fallbackMaxTokens");
  const needsFallback = /\bfallbackMaxTokens\b/.test(body);
  if (needsFallback) assert.equal(constant?.init?.value, 128000, "Fallback token bound changed");
  return (
    "exports.runNativeExecutor=async function(__dependencies,input,request,resolution){const {" +
    Object.keys(dependencies).join(",") +
    "}=__dependencies;\n" +
    (local ? candidateCode.slice(local.start, local.end) + "\n" : "") +
    (needsFallback
      ? "const fallbackMaxTokens=" +
        candidateCode.slice(constant.init.start, constant.init.end) +
        ";\n"
      : "") +
    body +
    "\n};\n"
  );
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
  const delegated =
    'return await require(__dirname + "/' +
    sidecar +
    '").runNativeExecutor.call(this,{' +
    dependencies +
    "}," +
    (entry.individualOnly
      ? '{...a,credentials:{...a.credentials,connectionId:a.credentials.connectionId+":plain-individual"}}'
      : "a") +
    ",b,c);";
  const replacement = entry.individualOnly
    ? '{if(this.options.provider?.endsWith("individual")){' +
      delegated +
      "}" +
      text.slice(node.start + 1, node.end - 1) +
      "}"
    : "{" + delegated + "}";
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
    bundle += nativeExecutorSource(
      previousCode,
      candidateCode,
      parse,
      manifest.overlay.executorMap[0].dependencies
    );
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
// The same bounded smoke runs against future compiled overlays on44 and against
// handwritten fixtures locally. It never imports or compiles an unfrozen source.
export async function smokeNativeExecutor(runNativeExecutor, ErrorClass, runtime) {
  const { assert, fs, path, os, crypto } = runtime;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-executor-smoke-"));
  const serverRoot = path.join(scratch, "profile", ".zcode", "server");
  const observed = [];
  let failure,
    hanging = false,
    generated = 0,
    useFallback = false;
  const request = {
    messages: [
      { role: "system", content: "Caller owns tools." },
      { role: "user", content: "Read fixture." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read-fixture", name: "Read", input: { filePath: "/fixture/non-secret" } },
        ],
      },
      { role: "tool", content: "fixture-nonce", toolCallId: "read-fixture", toolName: "Read" },
    ],
    tools: [
      {
        name: "Read",
        description: "Caller tool",
        inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
      },
    ],
    maxOutputTokens: 100000,
  };
  const body = {
    messages: [
      ...request.messages.slice(0, 2),
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "read-fixture",
            type: "function",
            function: { name: "Read", arguments: '{"filePath":"/fixture/non-secret"}' },
          },
        ],
      },
      { role: "tool", content: "fixture-nonce", tool_call_id: "read-fixture" },
    ],
    tools: [
      { type: "function", function: { name: "Read", parameters: request.tools[0].inputSchema } },
    ],
    max_tokens: 100000,
  };
  const nativeResult = {
    text: "fixture-ok",
    usage: { inputTokens: 13, outputTokens: 3 },
    toolCalls: [{ id: "next-read", name: "Read", input: { filePath: "/fixture/next" } }],
  };
  const withAbort = async (promise, signal) => {
    signal?.throwIfAborted();
    if (!signal) return promise;
    let listener;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          listener = () => reject(signal.reason);
          signal.addEventListener("abort", listener, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", listener);
    }
  };
  const bounded = (options) => {
    assert(options?.timeoutMs > 0 && options.timeoutMs <= 500);
    assert(options.signal instanceof AbortSignal);
  };
  class Client {
    async start(options) {
      bounded(options);
      const profile = JSON.parse(
        fs.readFileSync(path.join(serverRoot, "..", "cli", "config.json"), "utf8")
      );
      for (const key of ["mcp", "memory", "subagent"]) assert.equal(profile.features[key], false);
      assert.deepEqual(profile.mcp.servers, {});
      assert.equal(profile.plugins.enabled, false);
      assert.equal(profile.hooks.enabled, false);
      observed.push("start");
    }
    async call(channel, method, args, options) {
      bounded(options);
      assert(
        ["getView", "generateWorkspaceText"].includes(method),
        "Session/project/MCP RPC is forbidden"
      );
      observed.push(method);
      if (method === "getView") {
        assert.equal(channel, "model-selection");
        return {};
      }
      assert.equal(channel, "zcode-agent");
      generated++;
      const payload = args[0];
      assert.equal(args.length, 1);
      assert.equal(payload.workspacePath, payload.workspaceIdentity);
      assert(
        payload.workspacePath.startsWith(scratch + path.sep),
        "Workspace escaped isolated scratch"
      );
      assert.deepEqual(
        fs.readdirSync(payload.workspacePath),
        [],
        "Smoke workspace contains project or MCP state"
      );
      for (const name of ["sessionId", "projectId", "mcpServers"])
        assert.equal(payload[name], undefined);
      assert.deepEqual(payload.messages, request.messages);
      assert.deepEqual(payload.tools, request.tools);
      assert.deepEqual(payload.selection, {
        providerId: "account:zai-start-plan",
        modelId: "GLM-Fixture",
      });
      assert.equal(payload.maxOutputTokens, useFallback ? 100000 : 32768);
      assert.equal(payload.querySource, "omniroute");
      assert(payload.requestTimeoutMs > 0 && payload.requestTimeoutMs <= 500);
      if (failure) throw failure;
      if (hanging) return withAbort(new Promise(() => {}), options.signal);
      return nativeResult;
    }
    async close() {
      observed.push("close");
    }
  }
  class Bridge {
    constructor() {
      throw Error("Native session bridge is forbidden");
    }
  }
  const deps = {
    nativeZcodeHosts: {
      ensure: async () => {
        observed.push("ensure");
        return serverRoot;
      },
    },
    NativeZcodeHostClient: Client,
    NativeZcodeSessionBridge: Bridge,
    NativeSessionError: ErrorClass,
    nativeBridges: new Proxy(
      {},
      {
        get() {
          throw Error("Session cache is forbidden");
        },
      }
    ),
    tmpdir: () => scratch,
    join: path.join,
    createHash: crypto.createHash,
    errorResponse: (status, message, extra) => ({ status, message, extra }),
    sanitizeErrorMessage: (s) => s,
    errorText: (e) => e.message,
    asRecord: (v) => (v && typeof v === "object" ? v : {}),
    withAbort,
    resolveZcodeSelection: () => ({ providerId: "account:zai-start-plan", modelId: "GLM-Fixture" }),
    resolveZcodeMaxTokens: () => (useFallback ? undefined : 32768),
    buildZcodeModelRequest: (value) => {
      assert.deepEqual(value, body);
      return structuredClone(request);
    },
    modelResponse: (_model, result) => result,
    isZcodeRequestCancelled: () => false,
    UPSTREAM_REQUEST_CANCELLED_CODE: "upstream_request_cancelled",
  };
  const input = {
    credentials: { authType: "oauth", connectionId: "fixture" },
    body,
    signal: new AbortController().signal,
  };
  const context = { options: { provider: "zcode-start" }, turnTimeoutMs: () => 500 };
  const invoke = (inputValue = input, contextValue = context) =>
    runNativeExecutor.call(contextValue, deps, inputValue, structuredClone(request), {
      model: "GLM-Fixture",
    });
  try {
    const result = await invoke();
    assert(result.url.startsWith("zcode://native-host/") && !result.url.endsWith("/session"));
    assert.deepEqual(result.response, nativeResult);
    assert.deepEqual(observed, ["ensure", "start", "getView", "generateWorkspaceText", "close"]);
    useFallback = true;
    assert.deepEqual((await invoke()).response, nativeResult);
    useFallback = false;
    const cancelled = new AbortController();
    cancelled.abort();
    observed.length = 0;
    assert.equal((await invoke({ ...input, signal: cancelled.signal })).status, 499);
    assert(!observed.includes("ensure") && !observed.includes("start"));
    failure = new ErrorClass("fixture quota", 429);
    assert.equal((await invoke()).status, 429, "Real quota status was replaced");
    failure = null;
    hanging = true;
    assert.equal((await invoke(input, { ...context, turnTimeoutMs: () => 100 })).status, 504);
    assert.equal(generated, 4);
    return {
      boundedPreflight: true,
      deadlinePassed: true,
      cancellation: true,
      generateWorkspaceText: true,
      callerTools: true,
      noAgentSessions: true,
      isolatedWorkspace: true,
      quotaPreserved: true,
      tokenFallback: true,
      mcpDisabled: true,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
  const p=require(path.join(output,manifest.overlay.sidecarPath));
  executorSmoke=await (${smokeNativeExecutor.toString()})(p.runNativeExecutor,p.NativeSessionError,{assert,fs,path,os:require('node:os'),crypto:require('node:crypto')});
 }
 console.log(JSON.stringify({webpackFactories:tested,hostClients:clients,sessionBridges:bridges,abortedTurns:true,executorSmoke}));
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
  const result = JSON.parse(
    run(process.execPath, ["-e", test, output], {
      env: { ...process.env, NODE_PATH: join(DONOR, "node_modules") },
      timeout: 30000,
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
    const { parse } = createRequire(join(ROOT, "package.json"))("acorn");
    overlay.executorMap = baseline.executorCandidates.map((entry) =>
      extendExecutorBindings(read(join(baselineDirectory, "rollback", entry.path)), parse, entry)
    );
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
      execFileSync("git", ["show", sourceSha + ":package-lock.json"], {
        cwd: ROOT,
        maxBuffer: 16 * 1024 * 1024,
      })
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
    for (const check of [
      "generateWorkspaceText",
      "callerTools",
      "noAgentSessions",
      "isolatedWorkspace",
      "quotaPreserved",
      "tokenFallback",
      "mcpDisabled",
    ])
      assert.equal(manifest.checks.webpackFactories?.executorSmoke?.[check], true);
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
export function discoverAdmin() {
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
    ...(manifest.providerScope
      ? {
          providerScope: manifest.providerScope,
          partialSourceApplication: manifest.partialSourceApplication,
        }
      : {}),
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
export function nativeProfileResetTarget(mode) {
  assert(["primary", "standby"].includes(mode), "Profile reset is apply-only");
  return mode === "primary"
    ? "/home/roomhacker/.omniroute/zcode-native"
    : "/home/roomhacker/.omniroute-standby/native-state";
}
const inodeOf = (path) => {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}`;
};
const present = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
function privateDirectory(path) {
  assert.equal(realpathSync(path), path, "Private directory must be canonical");
  const stat = lstatSync(path);
  assert(stat.isDirectory() && stat.uid === process.getuid());
  assert.equal(stat.mode & 0o077, 0, "Directory must be private");
}
function profileRootCas(state) {
  privateDirectory(state.root);
  assert.equal(inodeOf(state.root), state.expectedInode, "Native root inode changed");
}
// Hash metadata only, never credential values. No symlink is followed. Include
// child ctime and inode so edits/replacements fail CAS; top ctime changes on rename.
function profileSnapshot(path) {
  const hash = createHash("sha256");
  const visit = (path, relative) => {
    const stat = lstatSync(path, { bigint: true });
    hash.update(
      JSON.stringify([
        relative,
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.uid),
        String(stat.gid),
        String(stat.size),
        String(stat.mtimeNs),
        relative ? String(stat.ctimeNs) : null,
        stat.isSymbolicLink() ? readlinkSync(path) : null,
      ])
    );
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(path, name), relative + "/" + name);
  };
  visit(path, "");
  return { inode: inodeOf(path), metadataSha256: hash.digest("hex") };
}
export function planNativeProfileReset({ root, archive, expectedInode }) {
  assert.equal(resolve(root), root);
  assert.equal(resolve(archive), archive);
  assert(archive !== root && !archive.startsWith(root + "/"), "Archive must be outside bind root");
  const state = {
    schema: "omniroute-native-profile-reset/1",
    root,
    archive,
    expectedInode,
    phase: "planned",
    entries: [],
  };
  profileRootCas(state);
  assert(!present(archive), "Profile archive exists; inspect previous outcome before replay");
  return state;
}
function profileCheckpoint(state, checkpoint) {
  save(join(state.archive, "reset.json"), state);
  checkpoint?.();
}
const NATIVE_GRANT_FILES = ["cipher-secret", "account.json", ".zcode/v2/credentials.json"];
const NATIVE_TELEMETRY_FILE = ".zcode/v2/telemetry-state.json";
function nativeCarryFiles(profile) {
  const files = [
    ...NATIVE_GRANT_FILES,
    ...(present(join(profile, NATIVE_TELEMETRY_FILE)) ? [NATIVE_TELEMETRY_FILE] : []),
  ];
  for (const file of files) {
    const path = join(profile, file);
    assert.equal(realpathSync(path), path, "Native grant file must be canonical");
    const stat = lstatSync(path);
    assert(
      stat.isFile() && stat.uid === process.getuid() && stat.size > 0,
      "Native grant file is missing or invalid"
    );
  }
  return files;
}
function seedNativeGrant(state, entry, checkStopped, checkpoint) {
  const old = join(state.archive, "profiles", entry.name);
  assert.deepEqual(profileSnapshot(old), entry.snapshot, "Archived native grant changed");
  const seeded = join(state.archive, "new-profiles", entry.name);
  mkdirSync(seeded, { mode: 0o700 });
  entry.carriedFiles = [];
  for (const file of nativeCarryFiles(old)) {
    const bytes = readFileSync(join(old, file)),
      to = join(seeded, file);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, bytes, { mode: 0o600, flag: "wx" });
    assert.deepEqual(readFileSync(to), bytes);
    assert.equal(lstatSync(to).mode & 0o777, 0o600);
    entry.carriedFiles.push({ path: file, sha256: sha256(bytes), mode: "0600" });
  }
  const settings = join(old, ".zcode/v2/setting.json");
  if (present(settings) && realpathSync(settings) === settings && lstatSync(settings).isFile()) {
    let prefs;
    try {
      prefs = json(settings);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const family = prefs?.providerFamilyDomain;
    const selections = prefs?.providerFamilyConnectionSelections;
    if (
      ["zai", "bigmodel"].includes(family) &&
      selections &&
      Object.keys(selections).length === 1 &&
      selections[family]?.kind === "individual-coding-plan" &&
      Object.keys(selections[family]).length === 1
    )
      save(join(seeded, ".zcode/v2/setting.json"), {
        providerFamilyDomain: family,
        providerFamilyConnectionSelections: selections,
      });
  }
  // Ciphertext, cipher secret and grant fingerprint come from the refreshed
  // native account together. Never reconstruct these three files from DB.
  assert.deepEqual(profileSnapshot(old), entry.snapshot, "Native grant changed while copying");
  entry.seedSnapshot = profileSnapshot(seeded);
  entry.seedStatus = "pending";
  profileCheckpoint(state, checkpoint);
  checkStopped();
  profileRootCas(state);
  const to = join(state.root, entry.name);
  assert(!present(to), "Unknown new account state appeared before native grant carry");
  renameSync(seeded, to);
  entry.seedStatus = "installed";
  profileCheckpoint(state, checkpoint);
  assert.deepEqual(profileSnapshot(to), entry.seedSnapshot);
}
export function moveNativeProfiles(state, checkStopped, checkpoint) {
  assert.equal(state.schema, "omniroute-native-profile-reset/1");
  assert.equal(state.phase, "planned");
  assert.equal(typeof checkStopped, "function");
  checkStopped();
  profileRootCas(state);
  // Only account roots may be moved. Unexpected state is preserved and stops reset.
  const names = readdirSync(state.root).sort();
  for (const name of names)
    assert(
      /^[a-f0-9]{64}$/.test(name) && lstatSync(join(state.root, name)).isDirectory(),
      "Unexpected native account state"
    );
  for (const name of names) nativeCarryFiles(join(state.root, name));
  assert(!present(state.archive), "Profile archive already exists");
  mkdirSync(dirname(state.archive), { recursive: true, mode: 0o700 });
  privateDirectory(dirname(state.archive));
  mkdirSync(state.archive, { mode: 0o700 });
  privateDirectory(state.archive);
  assert.equal(
    lstatSync(state.archive).dev,
    lstatSync(state.root).dev,
    "Profile archive must share filesystem"
  );
  state.archiveInode = inodeOf(state.archive);
  mkdirSync(join(state.archive, "profiles"), { mode: 0o700 });
  state.profilesInode = inodeOf(join(state.archive, "profiles"));
  mkdirSync(join(state.archive, "new-profiles"), { mode: 0o700 });
  state.newProfilesInode = inodeOf(join(state.archive, "new-profiles"));
  state.entries = names.map((name) => ({
    name,
    snapshot: profileSnapshot(join(state.root, name)),
    status: "pending",
  }));
  state.phase = "moving";
  profileCheckpoint(state, checkpoint);
  for (const entry of state.entries) {
    checkStopped();
    profileRootCas(state);
    const from = join(state.root, entry.name),
      to = join(state.archive, "profiles", entry.name);
    assert(!present(to), "Archive destination changed");
    assert.deepEqual(profileSnapshot(from), entry.snapshot, "Account profile changed before move");
    renameSync(from, to);
    entry.status = "moved";
    profileCheckpoint(state, checkpoint);
    assert.deepEqual(profileSnapshot(to), entry.snapshot, "Account profile changed during move");
  }
  profileRootCas(state);
  assert.equal(readdirSync(state.root).length, 0, "New native state appeared during reset");
  state.phase = "archived";
  profileCheckpoint(state, checkpoint);
  for (const entry of state.entries) seedNativeGrant(state, entry, checkStopped, checkpoint);
  profileRootCas(state);
  assert.deepEqual(
    readdirSync(state.root).sort(),
    names,
    "Unknown native state appeared while seeding"
  );
  state.phase = "seeded";
  state.retainedNativeGrant = true;
  profileCheckpoint(state, checkpoint);
  return state;
}
export function rollbackNativeProfiles(state, checkStopped, checkpoint) {
  assert.equal(state.schema, "omniroute-native-profile-reset/1");
  checkStopped();
  profileRootCas(state);
  if (state.phase === "planned" && state.entries.length === 0)
    return { restored: true, conflicts: [] };
  privateDirectory(state.archive);
  assert.equal(inodeOf(state.archive), state.archiveInode, "Archive inode changed");
  const profiles = join(state.archive, "profiles");
  privateDirectory(profiles);
  assert.equal(inodeOf(profiles), state.profilesInode, "Archived profiles root changed");
  const newProfiles = join(state.archive, "new-profiles");
  privateDirectory(newProfiles);
  assert.equal(inodeOf(newProfiles), state.newProfilesInode, "Seeded profiles archive changed");
  const conflicts = [];
  for (const entry of state.entries.slice().reverse()) {
    assert(/^[a-f0-9]{64}$/.test(entry.name), "Invalid journaled account name");
    checkStopped();
    profileRootCas(state);
    const from = join(profiles, entry.name),
      to = join(state.root, entry.name);
    if (!present(from) && present(to)) {
      if (JSON.stringify(profileSnapshot(to)) === JSON.stringify(entry.snapshot)) {
        entry.status = "restored";
        profileCheckpoint(state, checkpoint);
        continue;
      }
    }
    // Only the exact minimal profile created by this transaction may move aside.
    // Native OAuth refreshes, new projects/tasks or other writes are preserved.
    const ownSeed =
      entry.seedSnapshot &&
      present(to) &&
      JSON.stringify(profileSnapshot(to)) === JSON.stringify(entry.seedSnapshot);
    const seedBackup = join(newProfiles, entry.name);
    if (
      !present(from) ||
      (present(to) && (!ownSeed || present(seedBackup))) ||
      JSON.stringify(profileSnapshot(from)) !== JSON.stringify(entry.snapshot)
    ) {
      conflicts.push({ name: entry.name, reason: "profile-state-changed" });
      continue;
    }
    if (ownSeed) {
      renameSync(to, seedBackup);
      entry.seedStatus = "rolled-back";
      profileCheckpoint(state, checkpoint);
    }
    renameSync(from, to);
    entry.status = "restored";
    profileCheckpoint(state, checkpoint);
  }
  state.phase = conflicts.length ? "rollback-conflict" : "restored";
  state.conflicts = conflicts;
  profileCheckpoint(state, checkpoint);
  return { restored: conflicts.length === 0, conflicts };
}
function stopped(port) {
  const unit = "omniroute@" + port + ".service";
  assert.equal(run("systemctl", ["show", unit, "-p", "MainPID", "--value"]), "0");
  assert.equal(run("ss", ["-H", "-ltn", "sport", "=", ":" + port]), "");
}
function stoppedNativeProfile(port) {
  stopped(port);
  const unit = "omniroute@" + port + ".service";
  assert.equal(run("systemctl", ["show", unit, "-p", "ActiveState", "--value"]), "inactive");
  const group = run("systemctl", ["show", unit, "-p", "ControlGroup", "--value"]);
  if (!group) return;
  assert(group.startsWith("/") && !group.split("/").includes(".."));
  const empty = (path) => {
    if (!existsSync(path)) return;
    assert.equal(
      read(join(path, "cgroup.procs")).trim(),
      "",
      "Native child processes are still running"
    );
    for (const name of readdirSync(path))
      if (lstatSync(join(path, name)).isDirectory()) empty(join(path, name));
  };
  empty("/sys/fs/cgroup" + group);
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
async function apply(mode, directory, sourceSha, canaryReceipt, resetNativeProfile = false) {
  assertFlock();
  const { manifest } = checkArtifact(directory, sourceSha);
  const before = await inspect();
  const port = mode === "standby" ? 20130 : 20128;
  if (resetNativeProfile)
    assert.equal(
      manifest.checks.webpackFactories?.executorSmoke?.generateWorkspaceText,
      true,
      "Profile reset requires the verified plain native model route"
    );
  const frozen = realpathSync(join(STANDBY, "dist"));
  if (port === 20128) {
    const installed = json(join(frozen, "RUNTIME_PATCHES.json"));
    assert.equal(installed.sourceSha, sourceSha, "Standby has a different patch");
    assert.equal(installed.sourceSnapshotSha256, manifest.sourceSnapshotSha256);
    if (manifest.providerScope) {
      assert.equal(manifest.providerScope, "individual");
      assert.equal(resetNativeProfile, false, "Scoped Individual patch must preserve Start state");
      assert.deepEqual(manifest.standbyReferenceFiles, installed.files);
      assert.equal(manifest.checks.startBranchPreserved, true);
      assert.equal(manifest.checks.individualProfileIsolated, true);
    }
    for (const file of manifest.providerScope ? manifest.standbyReferenceFiles : manifest.files)
      assert.equal(sha256(readFileSync(join(frozen, file.path))), file.after);
    assert(canaryReceipt, "Primary requires the consumer Worker's standby receipt path");
    assert(statSync(canaryReceipt).isFile());
    // The Lead reviews the consumer evidence. Preserve its exact hash in the receipt.
  }
  const sourceDist = port === 20130 ? frozen : join(ROOT, "dist");
  checkPreimages(sourceDist, manifest);
  const tag = stamp() + "-" + manifest.sourceSnapshotSha256.slice(0, 12);
  const resetPlan = resetNativeProfile
    ? planNativeProfileReset({
        root: nativeProfileResetTarget(mode),
        archive: join(dirname(nativeProfileResetTarget(mode)), "native-profile-archive", tag),
        expectedInode: (port === 20130 ? before.standby : before.primary).nativeInode,
      })
    : null;
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
    ...(resetPlan ? { nativeProfileReset: resetPlan } : {}),
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
    if (resetPlan)
      moveNativeProfiles(
        resetPlan,
        () => stoppedNativeProfile(port),
        () => save(receipt, result)
      );
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
    if (resetPlan) result.rollback.nativeProfileArchive = resetPlan.archive;
    result.consumerProof = "pending-separate-worker";
  } catch (error) {
    result.failure = { name: error.name, code: error.code || null };
    if (stopAttempted) {
      try {
        await leaseCheck();
        if (port === 20130 && pointerChanged)
          assert.equal(realpathSync(join(STANDBY, "dist")), staged);
        if (port === 20128 && oldDistMoved && existsSync(join(ROOT, "dist/RUNTIME_PATCHES.json")))
          assert.equal(
            json(join(ROOT, "dist/RUNTIME_PATCHES.json")).sourceSnapshotSha256,
            manifest.sourceSnapshotSha256
          );
        control("stop", port);
        stopped(port);
        if (resetPlan)
          result.nativeProfileRollback = rollbackNativeProfiles(
            resetPlan,
            () => stoppedNativeProfile(port),
            () => save(receipt, result)
          );
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
        if (resetPlan) assert.equal(processState(port).nativeInode, resetPlan.expectedInode);
        result.runtimeRolledBack = true;
        result.rolledBack = !resetPlan || result.nativeProfileRollback.restored;
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
    "--reset-native-profile",
  ]);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    assert(allowed.has(args[i]) && !(args[i] in flags), "Unknown or duplicate argument");
    const flag = args[i];
    if (["--locked", "--reset-native-profile"].includes(flag)) flags[flag] = true;
    else {
      assert(args[i + 1] && !args[i + 1].startsWith("--"), "Missing argument value");
      flags[flag] = args[++i];
    }
  }
  assert(
    !flags["--reset-native-profile"] || ["standby", "primary"].includes(mode),
    "Profile reset is apply-only"
  );
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
  return apply(
    mode,
    directory,
    sourceSha,
    flags["--consumer-receipt"],
    Boolean(flags["--reset-native-profile"])
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // Lease validation errors may contain capabilities; never echo their messages.
    console.error(
      JSON.stringify({ phase: "patch-helper-failed", name: error.name, code: error.code || null })
    );
    process.exitCode = 1;
  });
