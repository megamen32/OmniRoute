import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { z } from "zod";
import { installZcodeNativeRuntime } from "../../scripts/ops/install-zcode-native-runtime.mjs";

const source = process.env.ZCODE_REASONING_TEST_SOURCE;

// The proprietary bundles are supplied by the operator. Exercise both native
// projections using their real code and the same reasoning-part shape returned
// by the model executor. No live provider, credential or customer prompt.
test(
  "native workspace result carries only present visible reasoning through both IPC schemas",
  {
    skip: !source,
  },
  () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zcode-reasoning-"));
    try {
      const { runtime } = installZcodeNativeRuntime({ source, dataDir, visibleReasoning: true });
      const worker = readFileSync(join(runtime, "zcode.cjs"), "utf8");
      const host = readFileSync(join(runtime, "server-core.js"), "utf8");
      assert.ok(
        worker.includes("reasoning:lt,toolCalls:Ie"),
        "SDK wrapper supplies reasoning parts"
      );

      function between(code: string, start: string, end: string) {
        const left = code.indexOf(start);
        const right = code.indexOf(end, left + start.length);
        assert.ok(left >= 0 && right > left, start);
        return code.slice(left, right);
      }
      const parts = runInNewContext(
        "(" + between(worker, "function amt(", "}function ").concat("}") + ")",
        { yD: () => false }
      );
      const visible = runInNewContext(
        "(" + between(worker, "function $uo(", "async function yea(") + ")",
        { amt: parts }
      );
      const sdk = between(worker, "async function EHa(", "function XGo(");
      const sdkResult = sdk.slice(sdk.lastIndexOf(",{text:D.text,") + 1, -1);
      const rpc = between(worker, "async function lbi(", "function izn(");
      const rpcResult = between(rpc, "return{text:u.text,", "}finally{").slice("return".length);
      const workerStart = worker.indexOf("Aps=m.object({text:m.string(),reasoning:");
      const workerEnd = worker.indexOf(",Qon=", workerStart);
      assert.ok(workerStart >= 0 && workerEnd > workerStart && workerEnd - workerStart < 1000);
      const schemas = [
        runInNewContext(worker.slice(workerStart + 4, workerEnd), {
          m: z,
          Nl: z.any(),
          axr: z.any(),
        }),
        runInNewContext(
          between(
            host,
            "var zcodeWorkspaceGenerateTextResultSchema =",
            "var zcodeWorkspaceCancelGenerateTextParamsSchema"
          ) + "zcodeWorkspaceGenerateTextResultSchema",
          { z77: z, modelSelectionSchema: z.any(), zcodeWorkspaceModelToolCallSchema: z.any() }
        ),
      ];
      const selection = { providerId: "fixture", modelId: "fixture" };
      for (const finishReason of ["stop", "tool-calls"]) {
        const toolCalls =
          finishReason === "tool-calls" ? [{ id: "test-tool", name: "probe", input: {} }] : [];
        for (const [reasoning, expected] of [
          [
            [
              { type: "reasoning", text: "one" },
              { type: "reasoning", text: "two" },
            ],
            "one\n\ntwo",
          ],
          [
            [
              { type: "reasoning", text: "", providerMetadata: { signature: "opaque" } },
              { type: "text", text: "ordinary" },
            ],
            undefined,
          ],
          [undefined, undefined],
        ] as const) {
          const usage = { reasoningTokens: 7 };
          const model = { text: "answer", reasoning, finishReason, usage };
          const inner = runInNewContext("(" + sdkResult + ")", {
            D: model,
            B: toolCalls,
            n: selection,
            $uo: visible,
          });
          const result = runInNewContext("(" + rpcResult + ")", { u: inner });
          for (const schema of schemas) {
            const wire = schema.parse(result);
            assert.equal(wire.reasoning, expected);
            assert.equal(Object.hasOwn(wire, "reasoning"), expected !== undefined);
            assert.equal(wire.text, "answer");
            assert.equal(wire.usage.reasoningTokens, 7);
            assert.equal(wire.finishReason, finishReason);
            assert.equal(wire.toolCalls?.length ?? 0, toolCalls.length);
          }
        }
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
