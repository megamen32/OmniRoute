# P0: default one-slot heavy admission rejects active clients

- Observed: 2026-07-29 16:28 UTC+3 in https://opencode.bezrabotnyi.com.
- Error: `Chat admission capacity is temporarily unavailable. Retry shortly.` (`503`, `chat_admission_busy`).
- Cause: `CHAT_MAX_HEAVY_IN_FLIGHT` defaults to 1; live service has no override and one heavyweight OmniRoute request is active.
- Safety boundary: retain body hard limit, heap guard, and user-owned work; adjust only the service environment for this instance.
- Removal condition: remove this file in the verified repair commit after source regression and live public request evidence.
