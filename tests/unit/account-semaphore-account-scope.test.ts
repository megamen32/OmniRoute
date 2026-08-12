import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { acquire, getStats, resetAll } from "../../open-sse/services/accountSemaphore.ts";

afterEach(() => resetAll());

test("account semaphore isolates providers and accounts but serializes one account", async () => {
  const codexA = "codex:account-a";
  const clineA = "clinepass:account-a";

  const releaseCodex = await acquire(codexA, { maxConcurrency: 1 });
  const releaseCline = await acquire(clineA, { maxConcurrency: 1 });
  assert.equal(getStats()[codexA].running, 1);
  assert.equal(getStats()[clineA].running, 1);

  const waitingCodex = acquire(codexA, { maxConcurrency: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(getStats()[codexA].queued, 1);
  assert.equal(getStats()[clineA].queued, 0);

  releaseCodex();
  const releaseWaitingCodex = await waitingCodex;
  releaseWaitingCodex();
  releaseCline();
});
