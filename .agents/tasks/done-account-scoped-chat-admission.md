# Account-scoped chat admission

- Description: Replace the process-global heavyweight chat admission lease with a lease keyed by the selected provider connection (account), so independent providers and accounts do not block one another.
- Severity: P1
- Started: 2026-07-29 UTC+3
- Executor: L
- Scope:
  1. Retain hard request-size and structural safety limits before routing.
  2. Select the concurrency key only after the actual provider connection is selected.
  3. Enforce a configurable per-account limit; do not impose a global cross-provider limit.
  4. Keep model-level scoping optional and disabled by default.
- Acceptance: simultaneous heavy requests routed to different connection IDs are both admitted; a second request using the same connection is bounded and released correctly when its response completes or is cancelled.
- Result:
  - Removed the live route's process-global heavyweight lease; `/v1/chat/completions` retains its hard byte and message limits only before routing.
  - `chatCore` now defaults a selected connection to one account semaphore slot through `OMNIROUTE_ACCOUNT_MAX_CONCURRENT=1`; a positive `provider_connections.maxConcurrent` overrides it, and explicit zero retains unlimited-per-account behavior.
  - The semaphore key remains `provider:connectionId`; model is intentionally not part of the default key, so model choices within one account share that account's cap while unrelated provider/accounts do not contend.
  - Focused regressions passed: 34 account/admission checks and 11 route/parse-once checks; TypeScript typecheck passed.
  - Runtime deployed with the old `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` setting removed. Public authenticated ClinePass SSE returned HTTP 200 with `[DONE]` and no `chat_admission_busy`; service restarted once for deployment and remains at `NRestarts=0`.
