#!/usr/bin/env node
// L34: read-only projection of the live WAL database; never import application DB core.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, "_tasks/research/2026-11-10-usage-by-project");
const dbPath = "/home/roomhacker/.omniroute/storage.sqlite";
const cutoff = "2026-11-10T15:00:00.000Z";
const start24h = "2026-11-09T15:00:00.000Z";
const startDay = "2026-11-09T21:00:00.000Z";
const ref = (v) => (v ? createHash("sha256").update(v).digest("hex").slice(0, 16) : null);
const sha = (v) => createHash("sha256").update(v).digest("hex");

if (process.argv.includes("--analyze")) {
  analyzeSnapshot();
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
db.pragma("query_only = ON");
if (!db.readonly || db.pragma("query_only", { simple: true }) !== 1) {
  throw new Error("Read-only protection is required");
}
const begin = performance.now();
db.exec("BEGIN");
try {
  const schema = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('call_logs', 'usage_history') ORDER BY type, name"
    )
    .all();
  const keys = new Map(
    db
      .prepare("SELECT id, name FROM api_keys")
      .all()
      .map((r) => [r.id, r.name])
  );
  const connections = new Map(
    db
      .prepare("SELECT id, provider, name FROM provider_connections")
      .all()
      .map((r) => [r.id, r])
  );
  const metadata = {
    task: "L34",
    captured_at: new Date().toISOString(),
    cutoff_utc_exclusive: cutoff,
    cutoff_msk_exclusive: "2026-11-10T18:00:00+03:00",
    windows: {
      day_msk: { from: startDay, to_exclusive: cutoff },
      last24h: { from: start24h, to_exclusive: cutoff },
    },
    database: dbPath,
    sqlite_version: db.prepare("SELECT sqlite_version() AS v").get().v,
    readonly: db.readonly,
    query_only: db.pragma("query_only", { simple: true }),
    journal_mode: db.pragma("journal_mode", { simple: true }),
    file_sizes: Object.fromEntries(
      ["", "-wal", "-shm"].map((s) => [s || "main", statSync(dbPath + s).size])
    ),
    schema,
    extraction: {},
    note: "One short read transaction, explicit projection only, no bodies/credentials/SQL application imports. API key IDs hashed before export.",
  };
  const queries = {
    call_logs: `SELECT id, timestamp, provider, model, requested_model, connection_id,
      api_key_id, api_key_name, status, tokens_in AS input, tokens_out AS output,
      tokens_cache_read AS cache_read, tokens_cache_creation AS cache_write,
      tokens_reasoning AS reasoning, cache_source, request_type, usage_provenance,
      combo_name, combo_step_id, combo_execution_key, correlation_id, error_type,
      queue_wait_ms, duration
      FROM call_logs INDEXED BY idx_cl_timestamp
      WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
    usage_history: `SELECT id, timestamp, provider, model, connection_id, api_key_id,
      api_key_name, status, success, tokens_input AS input, tokens_output AS output,
      tokens_cache_read AS cache_read, tokens_cache_creation AS cache_write,
      tokens_reasoning AS reasoning, combo_strategy, endpoint, error_code
      FROM usage_history INDEXED BY idx_uh_timestamp
      WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
  };
  for (const [table, sql] of Object.entries(queries)) {
    const started = performance.now();
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(start24h, cutoff);
    if (!plan.some((p) => /SEARCH .*timestamp/.test(p.detail))) {
      throw new Error("Expected indexed timestamp range: " + table);
    }
    const rows = db.prepare(sql).all(start24h, cutoff);
    const counted = db
      .prepare(
        `SELECT count(*) AS rows, min(timestamp) AS earliest, max(timestamp) AS latest
        FROM ${table} INDEXED BY ${table === "call_logs" ? "idx_cl_timestamp" : "idx_uh_timestamp"}
        WHERE timestamp >= ? AND timestamp < ?`
      )
      .get(start24h, cutoff);
    if (rows.length !== counted.rows) throw new Error("Row count mismatch");
    for (const row of rows) {
      row.key_ref = ref(row.api_key_id);
      row.current_api_key_name = keys.get(row.api_key_id) || null;
      row.connection_ref = ref(row.connection_id);
      row.connection_provider = connections.get(row.connection_id)?.provider || null;
      row.connection_name = connections.get(row.connection_id)?.name || null;
      delete row.api_key_id;
      delete row.connection_id;
    }
    const payload = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(resolve(out, table + ".sanitized.jsonl"), payload, { mode: 0o600 });
    metadata.extraction[table] = {
      ...counted,
      plan,
      elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000,
      exported_sha256: sha(payload),
      exported_bytes: Buffer.byteLength(payload),
    };
  }
  metadata.read_transaction_ms = Math.round((performance.now() - begin) * 1000) / 1000;
  db.exec("ROLLBACK");
  writeFileSync(resolve(out, "snapshot.json"), JSON.stringify(metadata, null, 2) + "\n");
  console.log(
    JSON.stringify({
      out,
      cutoff,
      extraction: metadata.extraction,
      read_transaction_ms: metadata.read_transaction_ms,
    })
  );
} finally {
  if (db.inTransaction) db.exec("ROLLBACK");
  db.close();
}

function identify(row) {
  const { provider, model = "" } = row;
  if (["connection-test", "model-sync"].includes(model) || row.request_type === "model-sync")
    return null;
  const native = {
    zcode: ["native Start (default alias)", "Z.ai"],
    "zcode-start": ["native Start", "Z.ai"],
    "zcode-cn-start": ["native Start", "BigModel CN"],
    "zcode-individual": ["native Individual", "Z.ai"],
    "zcode-cn-individual": ["native Individual", "BigModel CN"],
  };
  if (native[provider] && /^glm-/i.test(model))
    return { family: "GLM", channel: native[provider][0], region: native[provider][1] };
  if (provider === "glm" && /^glm-/i.test(model))
    return { family: "GLM", channel: "API (coding endpoint)", region: "Z.ai" };
  if (provider === "opencode-zen" && /^glm-/i.test(model))
    return { family: "GLM", channel: /free/i.test(model) ? "Free" : "API", region: "OpenCode Zen" };
  if (
    ["minimax", "minimax-code", "minimax-coding-plan"].includes(provider) &&
    /^minimax-/i.test(model)
  )
    return {
      family: "MiniMax",
      channel: provider === "minimax" ? "API" : "native coding plan",
      region: "MiniMax",
    };
  return null;
}

function isSuccess(row) {
  return Number(row.status) >= 200 && Number(row.status) < 300;
}

function dispatchEvidence(row) {
  if (row.queue_wait_ms !== null && row.queue_wait_ms !== undefined) return "dispatch_marker";
  if ((row.input || 0) + (row.output || 0) > 0) return "partial_usage_without_marker";
  return "no_dispatch_evidence";
}

function blankStats() {
  return {
    provider_identity_rows: 0,
    dispatch_marker_rows: 0,
    partial_usage_evidence_rows: 0,
    success_count: 0,
    success_reported_count: 0,
    success_estimated_count: 0,
    success_absent_count: 0,
    success_input: 0,
    success_output: 0,
    success_total_input_output: 0,
    success_reported_input_output: 0,
    success_cache_read_known_tokens: 0,
    success_cache_write_known_tokens: 0,
    success_cache_read_known_rows: 0,
    success_cache_write_known_rows: 0,
    success_cache_read_unreported_rows: 0,
    success_cache_write_unreported_rows: 0,
    error_dispatch_marked_count: 0,
    error_partial_usage_count: 0,
    error_no_dispatch_evidence_count: 0,
    error_recorded_input: 0,
    error_recorded_output: 0,
    error_recorded_cache_read: 0,
    error_recorded_cache_write: 0,
    earliest: null,
    latest: null,
  };
}

function updateStats(stats, row) {
  stats.provider_identity_rows++;
  stats.earliest =
    stats.earliest === null || row.timestamp < stats.earliest ? row.timestamp : stats.earliest;
  stats.latest =
    stats.latest === null || row.timestamp > stats.latest ? row.timestamp : stats.latest;
  const evidence = dispatchEvidence(row);
  if (evidence === "dispatch_marker") stats.dispatch_marker_rows++;
  if (evidence === "partial_usage_without_marker") stats.partial_usage_evidence_rows++;
  if (!isSuccess(row)) {
    if (evidence === "dispatch_marker") stats.error_dispatch_marked_count++;
    else if (evidence === "partial_usage_without_marker") stats.error_partial_usage_count++;
    else stats.error_no_dispatch_evidence_count++;
    stats.error_recorded_input += row.input || 0;
    stats.error_recorded_output += row.output || 0;
    stats.error_recorded_cache_read += row.cache_read || 0;
    stats.error_recorded_cache_write += row.cache_write || 0;
    return;
  }
  if (evidence === "no_dispatch_evidence" || row.cache_source === "semantic")
    throw new Error("Unexpected successful target row without upstream dispatch evidence");
  stats.success_count++;
  stats.success_input += row.input || 0;
  stats.success_output += row.output || 0;
  stats.success_total_input_output += (row.input || 0) + (row.output || 0);
  if (row.usage_provenance === "reported") {
    stats.success_reported_count++;
    stats.success_reported_input_output += (row.input || 0) + (row.output || 0);
  } else if (row.usage_provenance === "estimated") stats.success_estimated_count++;
  else stats.success_absent_count++;
  for (const field of ["cache_read", "cache_write"]) {
    if (row[field] === null || row[field] === undefined)
      stats["success_" + field + "_unreported_rows"]++;
    else {
      stats["success_" + field + "_known_rows"]++;
      stats["success_" + field + "_known_tokens"] += row[field];
    }
  }
}

function groupRows(rows, dimensions) {
  const groups = new Map();
  for (const row of rows) {
    const descriptor = Object.fromEntries(dimensions.map((k) => [k, row[k]]));
    const key = JSON.stringify(descriptor);
    if (!groups.has(key)) groups.set(key, { ...descriptor, ...blankStats() });
    updateStats(groups.get(key), row);
  }
  return [...groups.values()].sort(
    (a, b) => b.success_reported_input_output - a.success_reported_input_output
  );
}

function bounds(rows) {
  return {
    rows: rows.length,
    earliest: rows.length
      ? rows.reduce((a, r) => (r.timestamp < a ? r.timestamp : a), rows[0].timestamp)
      : null,
    latest: rows.length
      ? rows.reduce((a, r) => (r.timestamp > a ? r.timestamp : a), rows[0].timestamp)
      : null,
  };
}

function toCsv(rows) {
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    const s =
      v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  return (
    [fields.map(cell).join(","), ...rows.map((r) => fields.map((k) => cell(r[k])).join(","))].join(
      "\n"
    ) + "\n"
  );
}

function reconcile(clRows, uhRows) {
  const signature = (r) =>
    JSON.stringify([
      r.provider,
      r.model,
      r.api_key_name,
      r.key_ref,
      r.connection_ref,
      r.input || 0,
      r.output || 0,
      r.cache_read || 0,
      r.cache_write || 0,
      Number(r.status),
    ]);
  const remaining = new Map();
  for (const r of uhRows) {
    const k = signature(r);
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  const missing = [];
  for (const r of clRows) {
    const k = signature(r);
    if (remaining.get(k) > 0) remaining.set(k, remaining.get(k) - 1);
    else missing.push(r);
  }
  const extraCount = [...remaining.values()].reduce((a, b) => a + b, 0);
  const missingByGroup = new Map();
  for (const r of missing) {
    const desc = {
      provider: r.provider,
      model: r.model,
      project: r.api_key_name,
      status: r.status,
    };
    const key = JSON.stringify(desc);
    if (!missingByGroup.has(key))
      missingByGroup.set(key, { ...desc, count: 0, input: 0, output: 0 });
    const g = missingByGroup.get(key);
    g.count++;
    g.input += r.input || 0;
    g.output += r.output || 0;
  }
  const successMissing = missing.filter(isSuccess).length;
  if (successMissing || extraCount) throw new Error("Successful usage reconciliation failed");
  return {
    method:
      "Exact multiset by provider/model/project/key reference/connection reference/input/output/cache/status, independently within each time window; no fuzzy timestamp join or union of both tables.",
    call_logs_rows: clRows.length,
    usage_history_rows: uhRows.length,
    successful_multiset_equal: true,
    successful_rows_missing_in_usage_history: successMissing,
    rows_missing_in_usage_history: missing.length,
    extra_rows_in_usage_history: extraCount,
    missing_by_group: [...missingByGroup.values()],
  };
}

function analyzeSnapshot() {
  const metadata = JSON.parse(readFileSync(resolve(out, "snapshot.json"), "utf8"));
  const loadRows = (table) => {
    const payload = readFileSync(resolve(out, table + ".sanitized.jsonl"), "utf8");
    if (sha(payload) !== metadata.extraction[table].exported_sha256)
      throw new Error("Snapshot hash mismatch");
    const rows = payload
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (rows.length !== metadata.extraction[table].rows) throw new Error("Snapshot count mismatch");
    return rows;
  };
  const cl = loadRows("call_logs"),
    uh = loadRows("usage_history");
  const report = {
    metadata,
    method: {
      project:
        "Recorded api_key_name (apiKeyName), unchanged; missing names remain unattributed. Current names exported separately; never read key values.",
      success:
        "HTTP 2xx; every selected success is 200, usage_provenance=reported, upstream cache source, and has a dispatch marker in this snapshot.",
      actual_provider:
        "Exact provider identity and actual model, never requested_model or combo_name. Connection/model-sync probes excluded. Explicit native Start/Individual region identities kept.",
      dispatch:
        "queue_wait_ms != null proves dispatch; positive partial failure usage is separately evidence of execution. Missing marker with zero tokens is retained as unproven, excluded from dispatched totals.",
      total:
        "Exactly stored input + output. Logging preserves prompt_tokens/input as-is, and adds cache only to raw Anthropic input_tokens when no normalized input/prompt_tokens exists. Native ZCode copies native inputTokens and cache fields separately; its upstream billing interpretation is not inferred. Cache is never added on top of the selected reported-input-plus-output metric. No provider quota or billing percentage is derived.",
      cache:
        "Nullable call_logs counters retain unknown versus explicit zero; usage_history coalesces missing cache to zero and is only a reconciliation source.",
      scope:
        "All retained committed rows in a single read snapshot, fixed half-open windows by each table's completion/log timestamp. Not provider invoices, unique end-user prompts, in-flight requests or transport retries without separate rows.",
      error_tokens:
        "Partial usage recorded on failures is shown separately, excluded from successful ranking and quota claims; provenance of these partial counters may be unknown.",
    },
    windows: {},
  };
  const rankingCsv = [],
    modelCsv = [],
    providerModelCsv = [],
    providerCsv = [],
    errorCsv = [],
    coverageCsv = [];
  for (const [window, range] of Object.entries(metadata.windows)) {
    const allCl = cl.filter((r) => r.timestamp >= range.from && r.timestamp < range.to_exclusive);
    const allUh = uh.filter((r) => r.timestamp >= range.from && r.timestamp < range.to_exclusive);
    const target = allCl
      .filter((r) => identify(r))
      .map((r) => ({ ...r, ...identify(r), project: r.api_key_name || "(без apiKeyName)" }));
    const targetUh = allUh.filter((r) => identify(r));
    const families = groupRows(target, ["family"]);
    const familyTotal = Object.fromEntries(
      families.map((r) => [r.family, r.success_reported_input_output])
    );
    const projectFamilies = groupRows(target, ["project", "family"]);
    const projectNames = [...new Set(projectFamilies.map((r) => r.project))];
    const rankings = projectNames
      .map((project) => {
        const parts = projectFamilies.filter((r) => r.project === project);
        const result = { project };
        for (const family of ["GLM", "MiniMax"]) {
          const stat = parts.find((r) => r.family === family) || blankStats();
          result[family] = {
            ...stat,
            share_percent: familyTotal[family]
              ? (100 * stat.success_reported_input_output) / familyTotal[family]
              : 0,
          };
        }
        result.reported_total =
          result.GLM.success_reported_input_output + result.MiniMax.success_reported_input_output;
        return result;
      })
      .sort((a, b) => b.reported_total - a.reported_total);
    for (const [i, row] of rankings.entries()) {
      rankingCsv.push({
        window,
        rank: i + 1,
        project: row.project,
        reported_total: row.reported_total,
        ...Object.fromEntries(
          ["GLM", "MiniMax"].flatMap((f) =>
            Object.entries(row[f]).map(([k, v]) => [f + "_" + k, v])
          )
        ),
      });
    }
    const addShare = (rows) =>
      rows.map((r) => ({
        ...r,
        share_within_family_percent: familyTotal[r.family]
          ? (100 * r.success_reported_input_output) / familyTotal[r.family]
          : 0,
      }));
    const byProvider = addShare(groupRows(target, ["family", "channel", "region", "provider"]));
    const byModel = addShare(
      groupRows(target, ["family", "channel", "region", "provider", "model"])
    );
    const perProjectModel = addShare(
      groupRows(target, ["family", "project", "channel", "region", "provider", "model"])
    );
    providerCsv.push(...byProvider.map((r) => ({ window, ...r })));
    providerModelCsv.push(...byModel.map((r) => ({ window, ...r })));
    modelCsv.push(...perProjectModel.map((r) => ({ window, ...r })));
    const errors = new Map();
    for (const r of target.filter((r) => !isSuccess(r))) {
      const desc = {
        window,
        project: r.project,
        family: r.family,
        channel: r.channel,
        region: r.region,
        provider: r.provider,
        model: r.model,
        status: r.status,
        error_type: r.error_type,
        dispatch_evidence: dispatchEvidence(r),
      };
      const key = JSON.stringify(desc);
      if (!errors.has(key))
        errors.set(key, {
          ...desc,
          count: 0,
          input: 0,
          output: 0,
          total_input_output: 0,
          cache_read_known_tokens: 0,
          cache_write_known_tokens: 0,
        });
      const e = errors.get(key);
      e.count++;
      e.input += r.input || 0;
      e.output += r.output || 0;
      e.total_input_output += (r.input || 0) + (r.output || 0);
      e.cache_read_known_tokens += r.cache_read || 0;
      e.cache_write_known_tokens += r.cache_write || 0;
    }
    errorCsv.push(...errors.values());
    const relevantProbe = allCl.filter(
      (r) =>
        ["connection-test", "model-sync"].includes(r.model) &&
        /glm|zcode|minimax/i.test(r.provider || "")
    );
    const outer = allCl.filter(
      (r) =>
        !identify(r) &&
        /glm|minimax/i.test(r.provider || "") &&
        !["connection-test", "model-sync"].includes(r.model)
    );
    const coverage = {
      call_logs: bounds(allCl),
      usage_history: bounds(allUh),
      provider_identity_rows: bounds(target),
      dispatched_rows: bounds(target.filter((r) => dispatchEvidence(r) !== "no_dispatch_evidence")),
      successful_dispatched_rows: bounds(target.filter(isSuccess)),
      dispatch_marker_rows: target.filter((r) => dispatchEvidence(r) === "dispatch_marker").length,
      partial_usage_without_marker_rows: target.filter(
        (r) => dispatchEvidence(r) === "partial_usage_without_marker"
      ).length,
      no_dispatch_evidence_rows: target.filter(
        (r) => dispatchEvidence(r) === "no_dispatch_evidence"
      ).length,
      excluded_relevant_probes: relevantProbe.length,
      excluded_outer_combo_rows: outer.length,
      excluded_outer_combo_providers: [...new Set(outer.map((r) => r.provider))],
      unrelated_rows: allCl.length - target.length - relevantProbe.length - outer.length,
      key_name_drift_rows: target.filter(
        (r) => r.api_key_name && r.current_api_key_name && r.api_key_name !== r.current_api_key_name
      ).length,
      missing_project_success_rows: target.filter((r) => isSuccess(r) && !r.api_key_name).length,
    };
    for (const [scope, v] of Object.entries(coverage))
      if (v && typeof v === "object" && !Array.isArray(v))
        coverageCsv.push({ window, scope, ...v });
    const successTotal = families.reduce((s, r) => s + r.success_total_input_output, 0);
    if (successTotal !== rankings.reduce((s, r) => s + r.reported_total, 0))
      throw new Error("Rank total mismatch");
    if (successTotal !== byModel.reduce((s, r) => s + r.success_total_input_output, 0))
      throw new Error("Model total mismatch");
    if (successTotal !== perProjectModel.reduce((s, r) => s + r.success_total_input_output, 0))
      throw new Error("Project/model total mismatch");
    report.windows[window] = {
      range,
      coverage,
      families,
      ranking: rankings,
      by_provider: byProvider,
      by_model: byModel,
      per_project_model: perProjectModel,
      errors: [...errors.values()],
      reconciliation: reconcile(target, targetUh),
    };
  }
  for (const [name, rows] of Object.entries({
    ranking: rankingCsv,
    "per-model": modelCsv,
    "provider-model": providerModelCsv,
    "provider-totals": providerCsv,
    errors: errorCsv,
    coverage: coverageCsv,
  })) {
    writeFileSync(resolve(out, name + ".csv"), toCsv(rows));
  }
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(report.windows).map(([k, v]) => [
          k,
          {
            coverage: v.coverage,
            families: v.families,
            ranking: v.ranking.map((r) => ({
              project: r.project,
              GLM: r.GLM.success_reported_input_output,
              MiniMax: r.MiniMax.success_reported_input_output,
              total: r.reported_total,
              GLM_share: r.GLM.share_percent,
              MM_share: r.MiniMax.share_percent,
            })),
            reconciliation: v.reconciliation,
          },
        ])
      ),
      null,
      2
    )
  );
}
