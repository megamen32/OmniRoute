import assert from "node:assert/strict";
import { test } from "node:test";
import { bypassPageCSPForBridge } from "../../open-sse/utils/chatgptWebFirstParty.ts";

// Purpose: unblock bridge startup when a subresource prevents load; fast unit, expected <1s, maximum 5s.
test("CSP bridge reload continues when DOM is ready but a subresource never loads", async () => {
  const page = {
    context: () => ({ newCDPSession: async () => ({ send: async () => {} }) }),
    url: () => "http://127.0.0.1/fixture",
    reload: async ({ waitUntil }: { waitUntil: string }) => {
      if (waitUntil === "load") return new Promise(() => {});
      return null;
    },
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;
  const result = await Promise.race([
    bypassPageCSPForBridge(page, "test"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked by subresource"), 100)),
  ]);
  assert.equal(result, true);
});
