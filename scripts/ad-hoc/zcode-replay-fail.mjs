// One-off probe: replay the exact failing request shape straight against the native
// app-server (bypassing OmniRoute) and print the raw native error for each attempt.
// Server stderr is teed to a file so native provider diagnostics (providerCode etc.)
// can be inspected after the run. Never logs credentials.
import { ZcodeAppServerClient } from "../../open-sse/executors/zcodeProtocol.ts";
import { buildZcodeModelRequest } from "../../open-sse/executors/zcode.ts";
import { readFileSync } from "node:fs";

const body = JSON.parse(readFileSync(process.argv[2] || "/tmp/opencode/replay.json", "utf8"));
const modelId = String(process.argv[3] || "GLM-5.3");
const stderrLog = process.argv[4] || "/tmp/opencode/zcode-server-stderr.log";
const runtimeRoot = process.env.ZCODE_SERVER_RUNTIME_ROOT || "/home/roomhacker/.zcode/server";
const serverNode = process.env.ZCODE_SERVER_NODE || `${runtimeRoot}/node`;
const serverEntry =
  process.env.ZCODE_SERVER_ENTRY ||
  "/home/roomhacker/.zcode/server/asset-cache/components/linux-x64/server-bundle/a3c3fd85beac901fc6d0319d2d652a46040e6e1de544fe3fe1b73365306a8636/zcode-server.cjs";

// bash wrapper: keep stdout protocol intact, tee stderr into a diagnostics file
const command = "/bin/bash";
const args = ["-c", `exec "${serverNode}" "${serverEntry}" 2>>"${stderrLog}"`];

const client = new ZcodeAppServerClient({ command, args });
await client.start();
await client.call("zcode-agent", "initialize", [
  { workspacePath: "/tmp", workspaceIdentity: "/tmp" },
]);
const native = buildZcodeModelRequest(body);
const runs = Number(process.argv[5] || 3);
for (let i = 0; i < runs; i++) {
  try {
    const r = await client.call("zcode-agent", "generateWorkspaceText", [
      {
        workspacePath: "/tmp",
        workspaceKey: "/tmp",
        selection: {
          providerId: "account:zai-individual-coding-plan",
          modelId,
          options: { reasoningLevel: "high" },
        },
        ...native,
        maxOutputTokens: 128000,
        querySource: "omniroute-probe",
        requestTimeoutMs: 180000,
      },
    ]);
    console.log(`probe-${i}: OK len=${String(r.text || "").length} finish=${r.finishReason}`);
  } catch (e) {
    const err = /** @type {Error & { rawPayload?: unknown }} */ (e);
    const data =
      err.rawPayload && typeof err.rawPayload === "object" ? err.rawPayload.data : undefined;
    let code = "-";
    if (data && typeof data === "object" && "code" in data) code = String(data.code);
    console.log(`probe-${i}: ERR ${String(err.message).slice(0, 120)} | data.code=${code}`);
  }
}
await client.close().catch(() => undefined);
process.exit(0);
