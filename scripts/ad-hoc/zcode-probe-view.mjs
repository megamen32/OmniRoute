// One-off probe: dump the native model-selection registry optionSpecs for a model.
// Usage: node --import tsx/esm scripts/ad-hoc/zcode-probe-view.mjs [modelId]
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZcodeAppServerClient } from "../../open-sse/executors/zcodeProtocol.ts";

const modelId = process.argv[2] || "glm-5.3-flash";
const runtimeRoot = process.env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server");
const serverNode = process.env.ZCODE_SERVER_NODE || join(runtimeRoot, "node");
const serverEntry = process.env.ZCODE_SERVER_ENTRY || join(runtimeRoot, "zcode-server.cjs");
const command =
  existsSync(serverNode) && existsSync(serverEntry)
    ? { command: serverNode, args: [serverEntry] }
    : { command: process.env.ZCODE_BIN || "zcode", args: ["app-server", "--stdio"] };
const client = new ZcodeAppServerClient(command);
try {
  await client.start();
  await client.call("zcode-agent", "initialize", [
    { workspacePath: process.cwd(), workspaceIdentity: process.cwd() },
  ]);
  const view = await client.call("model-selection", "getView", []);
  const providers = (view && typeof view === "object" ? view.providers : []) || [];
  for (const provider of providers) {
    for (const entry of provider.models || []) {
      if (String(entry.modelId).toLowerCase() !== modelId.toLowerCase()) continue;
      const spec = entry?.config?.optionSpecs ?? null;
      console.log(
        JSON.stringify(
          { providerId: provider.providerId, modelId: entry.modelId, optionSpecs: spec },
          null,
          2
        )
      );
    }
  }
} finally {
  await client.close().catch(() => undefined);
}
