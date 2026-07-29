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
- Next action: run the focused admission regression, then apply the bounded systemd override.
