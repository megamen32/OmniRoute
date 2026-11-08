import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { NativeZcodeHostClient } from "../../open-sse/executors/zcode/nativeHostClient.ts";
import type { NativeZcodeSessionBridge } from "../../open-sse/executors/zcode/nativeSession.ts";
const require = createRequire(import.meta.url);
const root = "/home/roomhacker/agents-projects/omniroute-zcode/.tmp/start-repair/stage";
async function load(name: string, id: number) {
  const chunk = require(join(root, name));
  const exported: Record<string, unknown> = {};
  let ready: Promise<unknown>;
  const deps: Record<number, unknown> = {
    977598: require("node:crypto"),
    937067: require("node:http"),
    51455: require("node:fs/promises"),
    176760: require("node:path"),
    42971: require("zod"),
  };
  const webpack = Object.assign(
    (n: number) => {
      if (!(n in deps)) throw Error("Unexpected import " + n);
      return deps[n];
    },
    {
      d: (target: object, defs: Record<string, () => unknown>) => {
        for (const [k, get] of Object.entries(defs)) Object.defineProperty(target, k, { get });
      },
      a: (_module: unknown, fn: Function) => {
        ready = new Promise((resolve, reject) => {
          fn(
            (values: unknown[]) => values,
            (error?: unknown) => (error ? reject(error) : resolve(null))
          );
        });
      },
    }
  );
  chunk.modules[id]({}, exported, webpack);
  await ready!;
  return exported.m as typeof NativeZcodeSessionBridge;
}
for (const [name, id] of [["14726.js", 11581]] as const) {
  const Bridge = await load(name, id);
  const connectionId =
    process.env.ZCODE_CANARY_CONNECTION_ID || "894dd166-f75c-407f-bcb4-1f92b0fc4bd3";
  const serverRoot = join(
    "/home/roomhacker/.omniroute/zcode-native",
    createHash("sha256").update(connectionId).digest("hex"),
    ".zcode/server"
  );
  const cc = new NativeZcodeHostClient({ serverRoot });
  await cc.start();
  const view = await cc.call("model-selection", "getView", []);
  const provider = (view as any).providers.find(
    (p: any) => p.providerId === "account:zai-start-plan"
  );
  const entry = provider.models.find(
    (m: any) => String(m.modelId).toLowerCase() === "glm-5.3-flash"
  );
  const chosen = {
    providerId: provider.providerId,
    modelId: entry.modelId,
    options: { reasoningLevel: "high" },
  };
  await cc.close();
  console.log("SELECTION", JSON.stringify(chosen));
  const bridge = new Bridge({
    clientFactory: () => {
      const c = new NativeZcodeHostClient({ serverRoot });
      const start = c.start.bind(c);
      let warmed = false;
      c.start = async () => {
        await start();
        if (!warmed) {
          warmed = true;
          await new Promise((r) => setTimeout(r, 3000));
        }
      };
      const call = c.call.bind(c);
      c.call = async (ch, m, args) => {
        try {
          const result = await call(ch, m, args);
          return result;
        } catch (e) {
          console.error("FAILED_RPC", m);
          throw e;
        }
      };
      return c;
    },
    workspaceRoot: join(tmpdir(), "omniroute-start-compiled-" + randomUUID()),
    timeoutMs: 120000,
  });
  try {
    const initial = {
      scope: "compiled-" + id,
      selection: chosen,
      messages: [
        {
          role: "system",
          content: "Use caller tools when needed. Never repeat a completed tool call.",
        },
        {
          role: "user",
          content:
            "Call caller_probe once with label compiled-check. Then reply exactly the value returned by the tool; do not call it again.",
        },
      ],
      tools: [
        {
          name: "caller_probe",
          description: "Return the caller random value",
          inputSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      ],
    };
    const first = await bridge.execute(initial);
    assert.equal(first.finishReason, "tool-calls");
    const run = [
      ...(
        bridge as unknown as {
          runs: Set<{ client: NativeZcodeHostClient; workspace: object; sessionId: string }>;
        }
      ).runs,
    ][0];
    console.log(
      "TASK_USAGE",
      JSON.stringify(
        await run.client.call("zcode-agent", "getTaskTokenUsage", [
          { ...run.workspace, sessionId: run.sessionId },
        ])
      )
    );

    const call = (first.toolCalls as Array<{ id: string; name: string; input: unknown }>)[0];
    assert.equal(call.name, "caller_probe");
    const value = "CANARY_" + randomUUID();
    const messages = [
      ...initial.messages,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      },
      { role: "tool", tool_call_id: call.id, content: value },
    ];
    messages[0] = {
      role: "system",
      content:
        "Updated caller context. Never repeat a completed tool call; report the returned value.",
    };
    const final = await bridge.execute({ ...initial, messages });
    assert.equal(final.finishReason, "stop");
    assert.equal(String(final.text).trim(), value);
    console.log(
      JSON.stringify({
        stage: "compiled-PASS",
        chunk: name,
        firstUsage: first.usage,
        finalUsage: final.usage,
        reconstructed: true,
      })
    );
  } finally {
    await bridge.close();
  }
}
