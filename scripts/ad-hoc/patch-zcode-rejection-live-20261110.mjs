import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { discoverAdmin, ROOT } from "./patch-zcode-timeout-artifact-20261110.mjs";

export function wrapRouteRejection(original) {
  return async function requestScopedZcodeRejection(...args) {
    const result = await original.apply(this, args);
    const response = result?.response || result;
    if (response?.status !== 403) return result;
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    if (body?.error?.message !== "ZCode text-generation route blocked due to unusual activity")
      return result;
    const replacement = args[0].errorResponse(
      502,
      "ZCode text-generation request context was rejected by upstream",
      { type: "upstream_response_failed", code: "upstream_response_failed" }
    );
    return result?.response ? { ...result, response: replacement } : replacement;
  };
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function inspectorPatch(pid, pkg, file) {
  const open = () =>
    fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(500) }).then(
      (r) => r.json(),
      () => null
    );
  const existing = await open();
  assert(!existing || process.argv.includes("--resume"), "Inspector port is already owned");
  let ws,
    connected = false,
    owned = false,
    nextId = 0;
  const pending = new Map();
  const rpc = (method, params = {}, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Inspector RPC deadline"));
        }, timeout);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    if (!existing) process.kill(pid, "SIGUSR1");
    let list;
    for (let n = 0; n < 40; n++) {
      list = await open();
      if (list?.[0]?.webSocketDebuggerUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(list?.[0]?.webSocketDebuggerUrl, "Inspector unavailable");
    ws = new WebSocket(list[0].webSocketDebuggerUrl);
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const message = JSON.parse(raw),
        waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error
        ? waiter.reject(new Error("Inspector evaluation rejected"))
        : waiter.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    connected = true;
    const identity = await rpc("Runtime.evaluate", {
      expression: "({pid:process.pid,pkg:process.env.OMNIROUTE_PKG})",
      returnByValue: true,
    });
    assert.equal(identity.result.value?.pid, pid);
    assert.equal(identity.result.value?.pkg, pkg);
    owned = true;
    const expression =
      "(() => { const expected=" +
      JSON.stringify({ pid, pkg, file }) +
      "; if(process.pid!==expected.pid||process.env.OMNIROUTE_PKG!==expected.pkg)throw Error('Runtime identity drift'); const Module=process.getBuiltinModule('module'),req=Module.createRequire(expected.file),fs=req('node:fs'); const filename=fs.realpathSync(expected.file); req(filename); const cached=Module._cache[filename]; if(!cached?.exports?.runNativeExecutor)throw Error('Native export absent'); if(cached.exports.__omniRouteRejectionFix!=='20261110'){ const wrapped=(" +
      wrapRouteRejection.toString() +
      ")(cached.exports.runNativeExecutor); cached.exports={...cached.exports,runNativeExecutor:wrapped,__omniRouteRejectionFix:'20261110'};} return {pid:process.pid,patched:cached.exports.__omniRouteRejectionFix==='20261110',exportName:cached.exports.runNativeExecutor.name}; })()";
    const result = await rpc("Runtime.evaluate", { expression, returnByValue: true });
    assert(!result.exceptionDetails, "Runtime patch evaluation failed");
    assert.equal(result.result.value?.patched, true);
    return result.result.value;
  } finally {
    if (connected && owned) {
      const closing = rpc(
        "Runtime.evaluate",
        { expression: "process.getBuiltinModule('inspector').close()" },
        800
      ).catch(() => {});
      ws?.terminate();
      await closing;
    } else ws?.terminate();
    assert.equal(await open(), null, "Inspector cleanup is incomplete");
  }
}
async function main() {
  if (!process.argv.includes("--locked")) {
    const child = spawnSync(
      "flock",
      [
        "-n",
        "--no-fork",
        "/home/roomhacker/.local/state/omniroute-deploy.lock",
        process.execPath,
        process.argv[1],
        "--locked",
        ...(process.argv.includes("--resume") ? ["--resume"] : []),
      ],
      { stdio: "inherit" }
    );
    process.exitCode = child.status ?? 1;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
    directory = path.join(ROOT, ".build/zcode-rejection-live-" + stamp);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const adminInfo = discoverAdmin(),
    { runReleaseAdmin } = await import(pathToFileURL(adminInfo.cli).href);
  const owner = {
    hostId: hostname(),
    harness: "codex",
    nativeSessionId: process.env.CODEX_THREAD_ID,
  };
  assert(owner.nativeSessionId);
  const proofPath = path.join(directory, "lease.json");
  const admin = (request, proofOut) =>
    runReleaseAdmin({
      ledger: adminInfo.ledger,
      authorityHost: hostname(),
      request,
      ...(proofOut ? { proofOut } : {}),
    });
  let proof;
  const receipt = {
    startedAt: new Date().toISOString(),
    sourceCorrection: "request-scoped upstream_response_failed; false account ban prevented",
    restartRequested: false,
    nodes: [],
  };
  const receiptPath = path.join(
    ROOT,
    "_tasks/research/2026-11-10-zcode-timeouts/rejection-live-" + stamp + ".json"
  );
  try {
    assert.equal(
      (await admin({ action: "acquire", cwd: ROOT, owner, ttlSeconds: 600 }, proofPath)).acquired,
      true
    );
    proof = JSON.parse(fs.readFileSync(proofPath));
    for (const port of [20128, 20130]) {
      await admin({ action: "check", cwd: ROOT, owner, token: proof.token, fence: proof.fence });
      const pkg = port === 20128 ? ROOT : "/home/roomhacker/.omniroute-standby/pkg";
      const manifestPath = path.join(pkg, "dist/RUNTIME_PATCHES.json");
      const rawManifest = fs.readFileSync(manifestPath),
        manifest = JSON.parse(rawManifest);
      assert.equal(manifest.sourceSha, "3fcd33e0b008024e82d9f941d9bd9ad54b7bf1cc");
      const item = manifest.files.find((item) =>
        item.path.endsWith("zcode-timeout-46f7696ea8ca7c53.cjs")
      );
      assert(item);
      const file = path.join(pkg, "dist", item.path),
        current = fs.readFileSync(file);
      let original = current;
      if (current.includes("OMNIROUTE_ZCODE_REJECTION_FIX_20261110")) {
        assert(process.argv.includes("--resume"), "Inspect prior fix before replay");
        original = fs.readFileSync(
          path.join(
            ROOT,
            ".build/zcode-rejection-live-2026-11-10T20-54-44-084Z",
            String(port) + ".before.cjs"
          )
        );
      }
      assert.equal(hash(original), item.after);
      const code =
        original.toString() +
        "\n// OMNIROUTE_ZCODE_REJECTION_FIX_20261110\nmodule.exports={...module.exports,runNativeExecutor:(" +
        wrapRouteRejection.toString() +
        ")(module.exports.runNativeExecutor),__omniRouteRejectionFix:'20261110'};\n";
      const verify =
        "const fs=require('node:fs'),cp=require('node:child_process'); const file='/home/roomhacker/omniroute-timeout-patch-20261110/rejection-live-check.cjs'; fs.writeFileSync(file,Buffer.from(process.argv[1],'base64'));cp.execFileSync(process.execPath,['--check',file]);";
      execFileSync(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "roomhacker@192.168.2.5",
          "node",
          "-e",
          "'" + verify.replaceAll("'", "'\\''") + "'",
          Buffer.from(code).toString("base64"),
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }
      );
      fs.writeFileSync(path.join(directory, String(port) + ".before.cjs"), original, {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(directory, String(port) + ".manifest.before.json"), rawManifest, {
        mode: 0o600,
      });
      if (current.includes("OMNIROUTE_ZCODE_REJECTION_FIX_20261110")) {
        assert.equal(current.toString(), code, "Partially installed correction drifted");
      } else {
        assert.equal(hash(fs.readFileSync(file)), item.after);
        fs.writeFileSync(file + ".scoped-new", code, { mode: 0o644, flag: "wx" });
        fs.renameSync(file + ".scoped-new", file);
      }
      const socket = execFileSync("ss", ["-H", "-ltnp", "sport", "=", ":" + port], {
        encoding: "utf8",
      });
      const pids = [
        ...new Set([...socket.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))),
      ];
      assert.equal(pids.length, 1);
      const node = await inspectorPatch(pids[0], pkg, file);
      item.after = hash(code);
      manifest.runtimeCorrections = [
        ...(manifest.runtimeCorrections || []),
        {
          id: "zcode-route-rejection-20261110",
          status: 502,
          code: "upstream_response_failed",
          livePid: pids[0],
          appliedAt: new Date().toISOString(),
        },
      ];
      fs.writeFileSync(manifestPath + ".scoped-new", JSON.stringify(manifest, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(manifestPath + ".scoped-new", manifestPath);
      receipt.nodes.push({ port, ...node, afterSha256: item.after });
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    }
    receipt.applied = true;
  } finally {
    if (proof)
      receipt.leaseReleased = (
        await admin({ action: "release", cwd: ROOT, owner, token: proof.token, fence: proof.fence })
      ).released;
    receipt.finishedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ receiptPath, ...receipt }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(JSON.stringify({ failed: true, name: error.name, code: error.code }));
    process.exitCode = 1;
  });
