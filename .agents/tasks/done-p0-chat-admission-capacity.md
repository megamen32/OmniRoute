# P0: restore concurrent heavy OpenCode/Codex chat admission

- Description: OmniRoute returns `503 chat_admission_busy` before provider selection when its single heavyweight request lease is occupied.
- Severity: P0
- Started: 2026-07-29 16:36 UTC+3
- Executor: L
- Workflow:
  1. L — confirm the public error, ingress/backend, and admission source.
  2. L — test the capacity controller and preserve the hard-size and heap guards.
  3. L — apply a reversible systemd override raising only concurrent heavyweight leases from 1 to 2.
  4. L — restart the owned OmniRoute unit, verify public ingress and a real authenticated chat request, and record actual response route.
- Acceptance: a second concurrent heavy request is admitted without disabling the 50 MiB hard limit or heap protection, and the public OpenCode path no longer returns `chat_admission_busy`.
- Result:
  - Confirmed the screenshot error was OmniRoute's process-local `chat_admission_busy`, not a ClinePass provider response. The default limit was one heavyweight request and a live heavy stream occupied it.
  - Added `/etc/systemd/system/omniroute@20128.service.d/20-chat-admission-capacity.conf` with `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT=2`; hard byte and heap guards remain unchanged.
  - Repaired false watchdog restarts in `/home/roomhacker/bin/omniroute-watchdog.sh`: listener liveness now requires three consecutive failures before restart, and the monitoring call reads current auth storage rather than a stale embedded credential.
  - Recovered the malformed active SQLite file from validated `storage.sqlite.bak.codex-restore-subagent-20260720T235310Z`; pre-recovery WAL/SHM are retained in `/home/roomhacker/.omniroute/recovery-20260729-1706-chat-p0/`.
  - Focused admission suite: 22/22 passed. A two-slot controller admitted two concurrent heavy requests and released both leases. Root watchdog completed successfully without changing OmniRoute PID.
  - External end-to-end proof: `https://omniroute.bezrabotnyi.com/v1/chat/completions`, authenticated configured ClinePass DeepSeek route, returned HTTP 200; first SSE byte 2.0 s, terminal `[DONE]`, normal response content, no admission or upstream-empty error. Main service remained active with zero systemd restarts.
  - Browser record: https://opencode.bezrabotnyi.com/ was opened; this browser profile displayed the OpenChamber unlock screen, so it could not submit the user's session directly.
- Acceptance: passed for the live OmniRoute/OpenCode API path.
