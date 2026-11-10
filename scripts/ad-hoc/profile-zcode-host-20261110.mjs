import fs from "node:fs/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";
const pid = Number(process.argv[2]);
assert(Number.isInteger(pid) && pid > 1);
const out = "_tasks/research/2026-11-10-zcode-timeouts/lead-native-idle-cpu-profile";
const group = await fs.readFile("/proc/" + pid + "/cgroup", "utf8");
assert(group.includes("omniroute@20128.service"));
assert((await fs.readFile("/proc/" + pid + "/cmdline", "utf8")).includes("server-core.js"));
const isOpen = () =>
  fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(700) }).then(
    () => true,
    () => false
  );
assert.equal(await isOpen(), false, "Inspector port is already owned");
let ws;
let connected = false;
const pending = new Map();
let id = 0;
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => {
      pending.delete(n);
      reject(new Error("Inspector RPC timed out: " + method));
    }, 10000);
    pending.set(n, {
      resolve: (x) => {
        clearTimeout(timer);
        resolve(x);
      },
      reject: (x) => {
        clearTimeout(timer);
        reject(x);
      },
    });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
try {
  process.kill(pid, "SIGUSR1");
  let list;
  for (let i = 0; i < 30; i++) {
    list = await fetch("http://127.0.0.1:9229/json/list", {
      signal: AbortSignal.timeout(500),
    }).then(
      (r) => r.json(),
      () => null
    );
    if (list?.[0]?.webSocketDebuggerUrl) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(list?.[0]?.webSocketDebuggerUrl, "Inspector did not open");
  ws = new WebSocket(list[0].webSocketDebuggerUrl);
  ws.on("message", (data) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  ws.on("error", () => {});
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  connected = true;
  const identity = await rpc("Runtime.evaluate", {
    expression: "process.pid",
    returnByValue: true,
  });
  assert.equal(identity.result.value, pid);
  await rpc("Profiler.enable");
  await rpc("Profiler.setSamplingInterval", { interval: 1000 });
  await rpc("Profiler.start");
  await new Promise((r) => setTimeout(r, 6000));
  const { profile } = await rpc("Profiler.stop");
  const nodes = profile.nodes
    .map((n) => ({
      fn: n.callFrame.functionName,
      url: n.callFrame.url,
      line: n.callFrame.lineNumber + 1,
      hits: n.hitCount || 0,
    }))
    .sort((a, b) => b.hits - a.hits);
  const summary = {
    capturedAt: new Date().toISOString(),
    pid,
    durationUs: profile.endTime - profile.startTime,
    totalSamples: profile.samples?.length,
    top: nodes.slice(0, 50),
  };
  await fs.writeFile(out + ".cpuprofile", JSON.stringify(profile), { mode: 0o600 });
  await fs.writeFile(out + ".json", JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, top: nodes.slice(0, 18) }));
} finally {
  if (connected)
    await rpc("Runtime.evaluate", { expression: "process._debugEnd()", returnByValue: true }).catch(
      () => {}
    );
  ws?.terminate();
  console.log(JSON.stringify({ pid, inspectorClosed: !(await isOpen()) }));
}
