// node --import tsx scripts/ad-hoc/verify-zcode-stability-20261110.mjs baseline
// After delivery: ... after --expect-build=<installed SHA> [--leg=zcode-start]
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { getCliToken } from "../../bin/cli/utils/cliToken.mjs";
import { decrypt } from "../../src/lib/db/encryption.ts";

const root = new URL("../../", import.meta.url).pathname;
const receipts = new URL("../../_tasks/research/2026-11-10-zcode-timeouts/", import.meta.url);
const args = process.argv.slice(2);
const phase = args.shift() || "baseline";
if (phase === "selftest") {
  const row = {
    provider: "zcode-start",
    connection_id: "account",
    status: 429,
    error_summary: "[429] Upstream quota exhausted",
  };
  const fixture = (trace) => ({
    provider: "zcode-start",
    connectionId: "account",
    temporaryComboName: "canary",
    trace,
  });
  const native = fixture([row]);
  classifyTrace(native);
  assert.equal(native.provider429, true);
  assert.equal(native.dispatchProven, true);
  const aggregate = fixture([
    {
      ...row,
      provider: "canary",
      connection_id: null,
      error_summary: "[429] all targets were skipped by pre-dispatch filters",
    },
  ]);
  classifyTrace(aggregate);
  assert.equal(aggregate.provider429, false);
  assert.equal(aggregate.dispatchProven, false);
  assert.equal(aggregate.localGateObserved, true);
  assert.equal(aggregate.httpOutcomes[0].scope, "local_gate");
  const unknownQuota = fixture([{ ...row, error_summary: "[429] Unknown upstream error" }]);
  classifyTrace(unknownQuota);
  assert.equal(unknownQuota.provider429, false);
  const abort = fixture([
    {
      ...row,
      provider: "canary",
      connection_id: null,
      status: 499,
      error_summary: "Request aborted",
    },
  ]);
  classifyTrace(abort);
  assert.equal(abort.localGateObserved, false);
  assert.equal(abort.httpOutcomes[0].scope, "client_abort");
  assert.equal(earlyStopDecision(aggregate.trace, aggregate).kind, "local_gate");
  assert.equal(earlyStopDecision(native.trace, native).kind, "provider_quota");
  assert.equal(earlyStopDecision(unknownQuota.trace, unknownQuota), undefined);
  assert.equal(earlyStopDecision([{ ...row, status: 200 }], native), undefined);
  console.log(JSON.stringify({ selftest: "GREEN", assertions: 13, networkRequests: 0 }));
  process.exit(0);
}
assert(["baseline", "after"].includes(phase), "Use baseline or after");
const option = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
assert(args.every((arg) => /^--(expect-build|expect-source|leg|timeout-ms|base|combo)=/.test(arg)));
const expectedSource = option("--expect-source");
assert(!expectedSource || /^[a-f0-9]{40}$/.test(expectedSource));
const ordinaryCombo = option("--combo");
assert(!ordinaryCombo || ordinaryCombo === "glm-5.3-flash-minimax-m3.1");
assert(!ordinaryCombo || !option("--leg"));
const expectedBuild = option("--expect-build") || (phase === "baseline" ? "30bae46b37" : "");
assert(/^[a-f0-9]{7,40}$/.test(expectedBuild), "Supply --expect-build after delivery");
const base = option("--base") || "http://127.0.0.1:20128";
assert(["http://127.0.0.1:20128", "http://127.0.0.1:20130"].includes(base));
const timeoutMs = Number(option("--timeout-ms") || 240_000);
assert(timeoutMs >= 30_000 && timeoutMs <= 600_000);
const definitions = [
  ["zcode-start", "9381af1f-793f-4de8-971b-1ddb672c2fc1"],
  ["zcode-cn-start", "7ce2765a-6284-444c-89af-d5b50ae8b7ac"],
  ["zcode-individual", "9381af1f-793f-4de8-971b-1ddb672c2fc1"],
  ["zcode-cn-individual", "7ce2765a-6284-444c-89af-d5b50ae8b7ac"],
];
const selectedProviders = option("--leg")?.split(",");
assert(
  !selectedProviders ||
    selectedProviders.every((name) => definitions.some(([provider]) => name === provider))
);
const legs = ordinaryCombo
  ? [["ordinary-combo", null]]
  : definitions.filter(([provider]) => !selectedProviders || selectedProviders.includes(provider));
assert(legs.length, "Unknown leg");
const binary = await realpath("/home/roomhacker/.npm-global/bin/opencode");
const clientVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.equal(clientVersion, "opencode v2.2.4");
const runId = randomUUID();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const prefix = "consumer-" + phase + "-" + stamp + "-" + runId.slice(0, 8);
await mkdir(receipts, { recursive: true, mode: 0o700 });
const secrets = [];
const scrub = (value) => {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
    .replace(
      /(\"(?:apiKey|authorization|accessToken|refreshToken)\"\s*:\s*\")[^\"]*/gi,
      "$1[REDACTED]"
    );
};
async function save(suffix, value) {
  const file = new URL(prefix + suffix, receipts);
  await writeFile(
    file,
    scrub(typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n",
    { mode: 0o600 }
  );
  return file.pathname;
}
const db = new Database("/home/roomhacker/.omniroute/storage.sqlite", {
  readonly: true,
  fileMustExist: true,
});
db.pragma("query_only=ON");
db.pragma("busy_timeout=5000");
const cliToken = await getCliToken();
assert(cliToken, "CLI management token unavailable");
secrets.push(cliToken);
const protectedEnv = execFileSync("sudo", ["-n", "cat", "/etc/omniroute/storage-encryption.env"], {
  encoding: "utf8",
});
const encryptionKey = protectedEnv
  .match(/^STORAGE_ENCRYPTION_KEY=(.+)$/m)?.[1]
  .trim()
  .replace(/^["']|["']$/g, "");
assert(encryptionKey, "Existing protected encryption reference unavailable");
secrets.push(encryptionKey);
process.env.STORAGE_ENCRYPTION_KEY = encryptionKey;
const stored = db
  .prepare("SELECT key FROM api_keys WHERE name=? AND is_active=1 AND revoked_at IS NULL")
  .get("opencode-100");
assert(stored, "Existing opencode-100 key unavailable");
const apiKey = decrypt(stored.key, { quiet: true });
assert(apiKey && !apiKey.startsWith("enc:"), "Existing consumer key cannot be decrypted");
secrets.push(apiKey, stored.key);
const summary = {
  runId,
  phase,
  startedAt: new Date().toISOString(),
  base,
  expectedBuild,
  expectedSource,
  client: clientVersion + " official installed standalone",
  binary,
  authority: "Current owner canary scope; .agents/TEST_ACCESS.md references only",
  scope: ordinaryCombo
    ? "One ordinary combo roundtrip; existing combo read-only; actual fallback trace; no build/restart/deploy or breaker reset"
    : "Sequential, pinned account, no fallback, no build/restart/deploy, no breaker reset",
  legs: [],
};
let interrupted = false;
let activeChild;
const stopChild = (signal = "SIGTERM") => {
  if (activeChild?.pid) {
    try {
      process.kill(-activeChild.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
const interrupt = () => {
  interrupted = true;
  stopChild();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function management(route, method = "GET", body) {
  const response = await fetch(base + route, {
    method,
    headers: { "x-omniroute-cli-token": cliToken, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert(response.ok, "Management HTTP " + response.status + ": " + scrub(text).slice(0, 500));
  return text ? JSON.parse(text) : null;
}
async function buildIdentity(leg) {
  const packageRoot = base.endsWith("20128") ? root : "/home/roomhacker/.omniroute-standby/pkg/";
  const sha = (await readFile(path.join(packageRoot, "dist/BUILD_SHA"), "utf8")).trim();
  assert(
    sha.startsWith(expectedBuild) || expectedBuild.startsWith(sha),
    "Installed build changed: " + sha
  );
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(packageRoot, "dist/RUNTIME_PATCHES.json"), "utf8")
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (manifest) {
    const files = [];
    for (const file of manifest.files || []) {
      const absolute = path.resolve(packageRoot, "dist", file.path);
      assert(absolute.startsWith(path.resolve(packageRoot, "dist") + path.sep));
      const sha256 = createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex");
      files.push({ path: file.path, expected: file.after, sha256, matches: sha256 === file.after });
    }
    leg.runtimePatchReadback = {
      sourceSha: manifest.sourceSha,
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      compiledOn: manifest.compiledOn,
      appliedAt: manifest.appliedAt,
      files,
    };
    assert(
      files.length && files.every((file) => file.matches),
      "Installed patch file hashes differ from manifest"
    );
  }
  if (phase === "after" && sha === "30bae46b37") {
    assert(
      leg.runtimePatchReadback?.sourceSnapshotSha256,
      "After-patch canary requires the installed patch manifest on this base build"
    );
    assert.equal(leg.runtimePatchReadback.compiledOn, "server-44");
  }
  if (expectedSource)
    assert.equal(
      leg.runtimePatchReadback?.sourceSha,
      expectedSource,
      "Unexpected installed patch source"
    );
  leg.serviceMainPid = Number(
    execFileSync(
      "systemctl",
      ["show", "omniroute@" + new URL(base).port + ".service", "-p", "MainPID", "--value"],
      { encoding: "utf8" }
    ).trim()
  );
  return sha;
}
function comboFingerprint() {
  // Exclude only this run's disposable combos. Do not serialize main combo configuration.
  const rows = db
    .prepare("SELECT * FROM combos WHERE name NOT LIKE ? ORDER BY id")
    .all("consumer-timeout-" + runId.slice(0, 8) + "%");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
const traceQuery = db.prepare(
  "SELECT id,timestamp,provider,model,connection_id,status,duration,ttft_ms,queue_wait_ms,added_wait_ms,error_summary,error_type,requested_model,combo_name,correlation_id,client_session_id,api_key_name,resilience_actions FROM call_logs WHERE correlation_id=? OR (api_key_name='opencode-100' AND (requested_model=? OR combo_name=?)) ORDER BY timestamp,id"
);
function childEnv(scratch, config) {
  // Allowlist: no inherited provider credentials, global OpenCode config or personal sessions.
  return {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    USER: process.env.USER || "roomhacker",
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_DATA_HOME: path.join(scratch, "data"),
    XDG_STATE_HOME: path.join(scratch, "state"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTO_INSTALL: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}
function isLocalGate(row) {
  return /pre.dispatch filters|ALL_TARGETS_SKIPPED|all_targets_skipped|pipeline.?gate|circuit.breaker|circuit.*open|model_lockout|resource_pressure|all.*cooldown/i.test(
    row.error_summary || ""
  );
}
function isQuotaError(row) {
  return (
    row.status === 429 &&
    /quota|rate.?limit|usage limit|token.*limit|limit.*(?:reached|exceed)|too many requests/i.test(
      row.error_summary || ""
    )
  );
}
function earlyStopDecision(rows, target) {
  const latest = rows.at(-1);
  if (latest && isLocalGate(latest)) return { kind: "local_gate", row: latest };
  const quota = rows.find(
    (row) =>
      row.provider === target.provider &&
      row.connection_id === target.connectionId &&
      !isLocalGate(row) &&
      isQuotaError(row)
  );
  if (quota) return { kind: "provider_quota", row: quota };
}
function classifyTrace(leg) {
  const native = leg.trace.filter(
    (row) =>
      row.provider === leg.provider && row.connection_id === leg.connectionId && !isLocalGate(row)
  );
  leg.dispatchProven = native.length > 0;
  leg.provider429Candidates = native.filter((row) => row.status === 429).map((row) => row.id);
  leg.provider429 = native.some(isQuotaError);
  leg.localGateObserved = leg.trace.some(isLocalGate);
  leg.unexpectedTrace = leg.trace.filter(
    (row) =>
      row.provider &&
      !(row.provider === leg.temporaryComboName && !row.connection_id) &&
      (row.provider !== leg.provider ||
        row.connection_id !== leg.connectionId ||
        row.model !== "glm-5.3-flash")
  );
  leg.httpOutcomes = leg.trace.map((row) => ({
    id: row.id,
    http: row.status,
    durationMs: row.duration,
    ttftMs: row.ttft_ms,
    error: row.error_summary,
    scope: isLocalGate(row)
      ? "local_gate"
      : !row.connection_id && row.status === 499
        ? "client_abort"
        : !row.connection_id && row.provider === leg.temporaryComboName
          ? "aggregate_error"
          : row.provider === leg.provider && row.connection_id === leg.connectionId
            ? "native_provider_attempt"
            : "unresolved",
  }));
  leg.classificationVersion = 2;
}
async function runClient(command, cwd, env, budget, onEvent, observeTrace, watchTarget) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let stdout = "",
    stderr = "",
    buffer = "",
    timedOut = false;
  const events = [];
  let stoppedAfterLocalGate;
  let stoppedAfterProviderQuota;
  let earlyKillTimer;
  const child = spawn(binary, command, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild = child;
  const timer = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, budget);
  const killTimer = setTimeout(() => stopChild("SIGKILL"), budget + 5000);
  const observer =
    observeTrace &&
    setInterval(() => {
      const decision = earlyStopDecision(observeTrace(), watchTarget);
      if (decision && !stoppedAfterLocalGate && !stoppedAfterProviderQuota) {
        const { row, kind } = decision;
        const observation = {
          id: row.id,
          http: row.status,
          reason: row.error_summary,
          elapsedMs: Math.round(performance.now() - start),
        };
        if (kind === "local_gate") stoppedAfterLocalGate = observation;
        else stoppedAfterProviderQuota = observation;
        stopChild();
        earlyKillTimer = setTimeout(() => stopChild("SIGKILL"), 5000);
      }
    }, 250);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(line);
        events.push(event);
        onEvent?.(event, Math.round(performance.now() - start));
      } catch {
        /* Non-JSON CLI diagnostics remain in sanitized stdout. */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let exitCode, signal, spawnError;
  try {
    await new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error.message;
        resolve();
      });
      child.once("close", (code, value) => {
        exitCode = code;
        signal = value;
        resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearInterval(observer);
    clearTimeout(earlyKillTimer);
    // This process group belongs solely to this private standalone invocation.
    stopChild();
    activeChild = undefined;
  }
  return {
    command,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - start),
    exitCode,
    signal,
    timedOut,
    stoppedAfterLocalGate,
    stoppedAfterProviderQuota,
    spawnError,
    stdout: scrub(stdout),
    stderr: scrub(stderr),
    events,
  };
}
function historyMessages(exported) {
  const data = exported?.data || exported;
  const messages = data?.messages || data?.session?.messages || [];
  return messages.map((message) => ({
    info: message.info || {
      id: message.id,
      role: message.role || message.type,
      model: message.model,
    },
    parts: (message.parts || []).map((part) => ({
      type: part.type,
      id: part.id,
      messageID: part.messageID,
      tool: part.tool,
      callID: part.callID,
      text: part.text,
      state: part.state,
      time: part.time,
    })),
  }));
}
summary.comboFingerprintBefore = comboFingerprint();
await save("-sequence.json", summary);
try {
  for (const [provider, connectionId] of legs) {
    if (interrupted) break;
    const leg = {
      phase,
      base,
      runId,
      clientVersion,
      provider,
      connectionId,
      startedAt: new Date().toISOString(),
      correlationId: randomUUID(),
      trace: [],
    };
    summary.legs.push(leg);
    const receiptSuffix = "-" + provider + ".json";
    let scratch;
    const name = ordinaryCombo || "consumer-timeout-" + runId.slice(0, 8) + "-" + provider;
    if (!ordinaryCombo) leg.temporaryComboName = name;
    else leg.existingComboName = name;
    try {
      leg.installedBuild = await buildIdentity(leg);
      scratch = await mkdtemp(path.join(os.tmpdir(), "omni-oc-timeout-"));
      const workspace = path.join(scratch, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const nonce = "ZCODE_NONCE_" + randomUUID();
      await writeFile(path.join(workspace, "nonce.txt"), nonce + "\n", { mode: 0o600 });
      leg.expectedNonce = nonce;
      leg.scratchWorkspace = workspace;
      if (ordinaryCombo) {
        leg.temporaryComboCreated = false;
        const existing = await management("/api/combos/7a4a012a-ee6a-4553-8d78-18279dc79885");
        assert.equal(existing.name, ordinaryCombo);
        leg.existingComboReadback = {
          id: existing.id,
          name: existing.name,
          strategy: existing.strategy,
          modelCount: existing.models.length,
          sha256: createHash("sha256").update(JSON.stringify(existing)).digest("hex"),
        };
      } else {
        leg.temporaryComboIntent = {
          name,
          strategy: "priority",
          models: [
            {
              kind: "model",
              model: provider + "/glm-5.3-flash",
              providerId: provider,
              connectionId,
            },
          ],
          config: {
            maxRetries: 0,
            retryDelayMs: 0,
            fallbackDelayMs: 0,
            disableSessionStickiness: true,
          },
        };
        await save(receiptSuffix, leg);
        const combo = await management("/api/combos", "POST", leg.temporaryComboIntent);
        leg.temporaryComboId = combo.id;
        assert(combo.id && combo.name === name);
        const readback = await management("/api/combos/" + combo.id);
        assert.equal(readback.models.length, 1);
        assert.equal(readback.models[0].connectionId, connectionId);
        assert.equal(readback.models[0].providerId, provider);
        leg.temporaryComboReadback = readback;
      }
      const config = {
        model: "timeout-canary/" + name,
        small_model: "timeout-canary/" + name,
        autoupdate: false,
        share: "disabled",
        snapshot: false,
        mcp: {},
        plugin: [],
        instructions: [],
        permission: { "*": "deny", read: "allow" },
        agent: {
          canary: {
            mode: "primary",
            prompt: "Follow the user's short file-read task exactly. Use only the read tool.",
            steps: 3,
          },
        },
        provider: {
          "timeout-canary": {
            npm: "@ai-sdk/openai-compatible",
            name: "Pinned ZCode timeout canary",
            options: {
              baseURL: base + "/v1",
              apiKey,
              maxRetries: 0,
              headers: { "x-correlation-id": leg.correlationId },
            },
            models: { [name]: { name, limit: { context: 131072, output: 1024 } } },
          },
        },
      };
      const env = childEnv(scratch, config);
      leg.requestedModel = config.model;
      const configCheck = await runClient(
        ["debug", "config", "--standalone"],
        workspace,
        env,
        20000
      );
      assert.equal(
        configCheck.exitCode,
        0,
        "Isolated config cannot be resolved: " + configCheck.stderr
      );
      const configSources = JSON.parse(configCheck.stdout);
      leg.configSources = JSON.parse(scrub(JSON.stringify(configSources)));
      const documents = configSources.filter((source) => source.type === "document");
      assert.equal(documents.length, 1, "Unexpected additional config source");
      const resolved = documents[0].info;
      assert.equal(resolved.model.providerID, "timeout-canary");
      assert.equal(resolved.model.model, name);
      assert.deepEqual(Object.keys(resolved.providers), ["timeout-canary"]);
      assert.deepEqual(resolved.mcp || {}, {});
      assert.deepEqual(resolved.plugins || [], []);
      const prompt =
        "Use the Read tool to read nonce.txt. Then reply with exactly the complete file contents, without markup or any other words. Do not use any other tool.";
      leg.prompt = prompt;
      await save(receiptSuffix, leg);
      console.log(
        JSON.stringify({
          event: "leg_started",
          provider,
          correlationId: leg.correlationId,
          installedBuild: leg.installedBuild,
          at: new Date().toISOString(),
        })
      );
      leg.consumer = await runClient(
        [
          "run",
          "--standalone",
          "--format",
          "json",
          "--agent",
          "canary",
          "--model",
          config.model,
          "--title",
          "ZCode timeout " + provider,
          prompt,
        ],
        workspace,
        env,
        timeoutMs,
        (event, elapsedMs) => {
          if (event.sessionID) leg.sessionID = event.sessionID;
          if (leg.firstEventMs === undefined) leg.firstEventMs = elapsedMs;
          if (event.type === "tool_use" && leg.firstToolMs === undefined)
            leg.firstToolMs = elapsedMs;
          if (event.type === "text" && leg.firstTextMs === undefined) leg.firstTextMs = elapsedMs;
        },
        ordinaryCombo ? undefined : () => traceQuery.all(leg.correlationId, name, name),
        { provider, connectionId }
      );
      const events = leg.consumer.events;
      const read = events.find(
        (event) => event.type === "tool_use" && event.part?.tool?.toLowerCase() === "read"
      );
      leg.readToolObserved = Boolean(read);
      leg.readCompleted = read?.part?.state?.status === "completed";
      leg.readReturnedNonce = Boolean(read?.part?.state?.output?.includes(nonce));
      leg.answer = events
        .filter((event) => event.type === "text")
        .map((event) => event.part?.text || "")
        .join("")
        .trim();
      leg.answerMatchesNonce = leg.answer === nonce;
      if (!leg.sessionID) {
        const sessions = await runClient(
          ["session", "list", "--standalone"],
          workspace,
          env,
          15000
        );
        leg.sessionList = sessions.stdout;
        leg.sessionID = sessions.stdout.match(/ses_[A-Za-z0-9]+/)?.[0];
      }
      if (leg.sessionID) {
        const exported = await runClient(
          ["session", "export", "--standalone", leg.sessionID],
          workspace,
          env,
          20000
        );
        leg.historyExportStatus = {
          exitCode: exported.exitCode,
          elapsedMs: exported.elapsedMs,
          stderr: exported.stderr,
        };
        if (exported.exitCode === 0) {
          const history = JSON.parse(exported.stdout);
          leg.history = historyMessages(history);
          leg.historyExport = history;
          leg.historyTopLevelKeys = Object.keys(history);
          leg.historyReadResult = leg.history.some((message) =>
            message.parts.some(
              (part) =>
                part.tool?.toLowerCase() === "read" &&
                part.state?.status === "completed" &&
                part.state?.output?.includes(nonce)
            )
          );
          leg.historyFinalNonce = leg.history.some(
            (message) =>
              message.info?.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && part.text?.trim() === nonce)
          );
          // OpenCode 2 exports typed messages with nested steps, unlike v1's info/parts.
          const exportedText = JSON.stringify(history);
          const nodes = (value) =>
            value && typeof value === "object"
              ? [value, ...Object.values(value).flatMap(nodes)]
              : [];
          const assistantMessages = (history.messages || []).filter(
            (message) => message.type === "assistant" || message.info?.role === "assistant"
          );
          leg.historyFinalNonce ||= assistantMessages.some((message) =>
            nodes(message).some((node) => node.text === nonce || node.content === nonce)
          );
          leg.historyReadResult ||= Boolean(
            leg.readCompleted &&
            leg.readReturnedNonce &&
            read?.part?.id &&
            exportedText.includes(read.part.id) &&
            exportedText.includes(nonce)
          );
          leg.historyContinuationObserved = leg.historyReadResult && leg.historyFinalNonce;
        }
      }
    } catch (error) {
      leg.harnessFailure = { name: error.name, message: scrub(error.message).slice(0, 1500) };
    } finally {
      await delay(2000);
      // The public combo has other callers/history: include only our correlation.
      leg.trace = traceQuery.all(
        leg.correlationId,
        ordinaryCombo ? runId : name,
        ordinaryCombo ? runId : name
      );
      // A timed-out create is reconciled by the unique name, never replayed.
      const owned = ordinaryCombo
        ? undefined
        : db.prepare("SELECT id FROM combos WHERE name=?").get(name);
      if (owned) {
        leg.temporaryComboId ||= owned.id;
        try {
          await management("/api/combos/" + owned.id, "DELETE");
        } catch (error) {
          leg.cleanupError = scrub(error.message).slice(0, 500);
        }
      }
      leg.temporaryComboRemoved = ordinaryCombo
        ? true
        : !db.prepare("SELECT id FROM combos WHERE name=?").get(name);
      leg.actualPinnedTrace = leg.trace.some(
        (row) =>
          row.provider === provider &&
          row.connection_id === connectionId &&
          row.status === 200 &&
          row.api_key_name === "opencode-100" &&
          row.client_session_id === leg.sessionID
      );
      const diagnosticText = JSON.stringify({
        events: leg.consumer?.events,
        stderr: leg.consumer?.stderr,
        trace: leg.trace,
      });
      classifyTrace(leg);
      if (ordinaryCombo) {
        leg.actualProviderTrace = leg.trace.filter((row) => row.connection_id);
        const isNamedZcode = (row) =>
          definitions.some(
            ([providerId, account]) =>
              row.provider === providerId &&
              row.connection_id === account &&
              row.model === "glm-5.3-flash"
          );
        const success = leg.actualProviderTrace.filter((row) => row.status === 200);
        leg.actualPinnedTrace =
          success.length >= 2 &&
          success.every(
            (row) =>
              isNamedZcode(row) &&
              row.client_session_id === leg.sessionID &&
              row.api_key_name === "opencode-100"
          );
        leg.unexpectedTrace = leg.actualProviderTrace.filter((row) => !isNamedZcode(row));
        leg.dispatchProven = leg.actualProviderTrace.length > 0;
        leg.provider429 = leg.actualProviderTrace.some(
          (row) => isNamedZcode(row) && !isLocalGate(row) && isQuotaError(row)
        );
        leg.nonZcodeSuccess = success.filter((row) => !isNamedZcode(row));
        for (const outcome of leg.httpOutcomes) {
          const row = leg.trace.find((row) => row.id === outcome.id);
          if (row.connection_id)
            outcome.scope = isNamedZcode(row)
              ? "native_provider_attempt"
              : "other_provider_attempt";
          else if (row.provider === name && !isLocalGate(row)) outcome.scope = "aggregate_error";
        }
        try {
          const existing = await management("/api/combos/7a4a012a-ee6a-4553-8d78-18279dc79885");
          leg.existingComboUnchanged =
            leg.existingComboReadback?.sha256 ===
            createHash("sha256").update(JSON.stringify(existing)).digest("hex");
        } catch (error) {
          leg.existingComboUnchanged = false;
          leg.existingComboVerificationError = scrub(error.message).slice(0, 500);
        }
      }
      leg.hostClosedObserved = /host client is closed/i.test(diagnosticText);
      leg.hostTimeoutObserved = /host request timed out/i.test(diagnosticText);
      leg.consumerRoundtrip = Boolean(
        leg.readCompleted &&
        leg.readReturnedNonce &&
        leg.answerMatchesNonce &&
        leg.historyContinuationObserved &&
        leg.consumer?.exitCode === 0
      );
      leg.status = leg.harnessFailure
        ? "HARNESS_ERROR"
        : leg.readCompleted &&
            leg.readReturnedNonce &&
            leg.answerMatchesNonce &&
            leg.historyContinuationObserved &&
            leg.actualPinnedTrace &&
            leg.unexpectedTrace.length === 0 &&
            (!ordinaryCombo || leg.existingComboUnchanged) &&
            leg.consumer?.exitCode === 0
          ? "GREEN"
          : "RED";
      if (scratch) {
        await rm(scratch, { recursive: true, force: true });
        leg.scratchRemoved = true;
      }
      leg.finishedAt = new Date().toISOString();
      leg.receipt = await save(receiptSuffix, leg);
      await save("-sequence.json", summary);
      console.log(
        JSON.stringify({
          event: "leg_finished",
          provider,
          status: leg.status,
          elapsedMs: leg.consumer?.elapsedMs,
          sessionID: leg.sessionID,
          http: leg.trace.map((row) => row.status),
          cleanup: leg.temporaryComboRemoved,
          receipt: leg.receipt,
        })
      );
    }
    leg.clientAbortConfirmed = Boolean(
      leg.consumer?.timedOut && leg.trace.some((row) => row.status === 499)
    );
    // A recorded 499 confirms cancellation at the gateway. Never replay an unresolved turn.
    if (
      !leg.temporaryComboRemoved ||
      (leg.consumer?.timedOut && !leg.clientAbortConfirmed) ||
      leg.harnessFailure
    )
      break;
  }
} finally {
  stopChild();
  summary.comboFingerprintAfter = comboFingerprint();
  summary.preexistingCombosUnchanged =
    summary.comboFingerprintBefore === summary.comboFingerprintAfter;
  summary.interrupted = interrupted;
  summary.finishedAt = new Date().toISOString();
  summary.status =
    !interrupted &&
    summary.legs.length === legs.length &&
    summary.legs.every((leg) => leg.status === "GREEN" && leg.temporaryComboRemoved)
      ? "GREEN"
      : "RED";
  const receipt = await save("-sequence.json", summary);
  db.close();
  console.log(
    JSON.stringify({
      event: "sequence_finished",
      status: summary.status,
      legs: summary.legs.length,
      preexistingCombosUnchanged: summary.preexistingCombosUnchanged,
      receipt,
    })
  );
  if (summary.status !== "GREEN") process.exitCode = 1;
}
