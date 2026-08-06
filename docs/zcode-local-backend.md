# ZCode local backend

OmniRoute can run a local ZCode app-server as provider `zcode` (alias `zc`). The
backend is intended for a local ZCode installation whose model provider is
`builtin:zai-coding-plan`.

## What it does

- starts the local ZCode app-server over stdio;
- performs the native JSON hello plus length-prefixed binary handshake;
- creates a ZCode coding session, selects a GLM model, sends one prompt turn,
  and polls the native session snapshot for the completed assistant message;
- exposes the result through the normal OpenAI Chat Completions route;
- keeps ZCode authentication in the local ZCode profile. OmniRoute does not
  accept, log, or persist the Z.ai credential for this backend.

The provider is **not** the remote ZCode free-quota proxy. It does not use the
captcha-gated `zcode.z.ai` coding-plan endpoint, a browser spoof, or the
remote desktop relay.

The built-in ACP Agents registry also includes a ZCode detection card. That card
confirms whether the local `zcode` binary is installed and shows the
`app-server` launch shape. Actual requests use the dedicated `ZcodeExecutor`
and ZCode's native length-prefixed stdio protocol; they are not sent through
OmniRoute's generic newline-based `AcpManager` transport.

## Configuration

The default command discovery is:

1. `$ZCODE_SERVER_NODE` with `$ZCODE_SERVER_ENTRY`;
2. `~/.zcode/server/node` with `~/.zcode/server/zcode-server.cjs` when present;
3. `$ZCODE_BIN` (default `zcode`) with `$ZCODE_ARGS` (default `["app-server"]`).

Optional variables:

| Variable | Purpose |
| --- | --- |
| `ZCODE_CWD` | Workspace passed to the local app-server. |
| `ZCODE_PROVIDER_ID` | Underlying ZCode model provider; defaults to `builtin:zai-coding-plan`. |
| `ZCODE_SERVER_RUNTIME_ROOT` | Root used for the local server fallback. |
| `ZCODE_SERVER_NODE` | Explicit ZCode server Node runtime. |
| `ZCODE_SERVER_ENTRY` | Explicit ZCode server entrypoint. |
| `ZCODE_BIN` | Explicit `zcode` executable. |
| `ZCODE_ARGS` | JSON array of app-server arguments. |
| `ZCODE_STARTUP_TIMEOUT_MS` | Handshake timeout; default 10000 ms. |
| `ZCODE_RPC_TIMEOUT_MS` | Individual RPC timeout; default 30000 ms. |
| `ZCODE_TURN_TIMEOUT_MS` | Maximum turn wait; default 120000 ms. |
| `ZCODE_POLL_INTERVAL_MS` | Session polling interval; default 250 ms. |

No shell interpolation is used for these command arguments. `ZCODE_ARGS` must
be a JSON array of at most 16 strings.

## Models and behavior

The provider reuses OmniRoute's GLM catalog, including `glm-5.2`,
`glm-5.2-high`, and `glm-5.2-max`. Clients can use the normal provider/model
form (for example `zcode/glm-5.2`) or the model id selected by the connection.

The native app-server turn is currently buffered: `stream=true` produces a
valid OpenAI SSE response only after the ZCode turn completes. This avoids
inventing a streaming protocol that the local app-server does not expose to
this adapter. Tool execution remains ZCode-local; OmniRoute does not attempt
to translate external OpenAI tool-call loops into ZCode's internal task model.
