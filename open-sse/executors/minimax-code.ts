import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BaseExecutor,
  type ExecuteInput,
  type ExecutorExecuteResult,
  type ProviderCredentials,
} from "./base.ts";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import { MINIMAX_CODE_MODELS } from "../config/providers/registry/minimax-code/index.ts";

/**
 * MiniMax Code provider.
 *
 * Requests are executed by the locally installed MiniMax Code CLI
 * (`mcode exec`), which runs the same agent runtime the desktop app uses and
 * keeps the credential in the local MiniMax profile (`~/.minimax`). OmniRoute
 * never receives or stores the MiniMax credential.
 *
 * The CLI reports its run as JSONL (`--output-format stream-json`):
 *   exec.started / session.started / turn.started
 *   item.started | item.updated   -> assistant text deltas
 *   item.completed                -> final assistant message
 *   turn.completed                -> usage
 *   exec.completed                -> final result (status + output)
 */

const MINIMAX_CODE_URL = "minimax-code://cli/exec";
const MINIMAX_CODE_PROVIDER_ID = "minimax";
const DEFAULT_MODEL = MINIMAX_CODE_MODELS[0]?.id || "MiniMax-M3.1-Flash";
const MINIMAX_CODE_MODEL_ALLOWLIST = new Set(MINIMAX_CODE_MODELS.map((model) => model.id));
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_STEPS = 1;

type JsonRecord = Record<string, unknown>;
type OpenAIMsg = { role?: string; content?: unknown };

export interface MinimaxCodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface MinimaxCodeExecEvent {
  type?: string;
  item?: { type?: string; contentDelta?: string; content?: string };
  result?: {
    status?: string;
    output?: string;
    usage?: MinimaxCodeUsage;
    error?: string;
    message?: string;
  };
  usage?: MinimaxCodeUsage;
  model?: { providerId?: string; modelId?: string };
}

export interface MinimaxCodeExecState {
  text: string;
  usage: MinimaxCodeUsage | null;
  status: string | null;
  error: string | null;
}

export interface MinimaxCodeRunOptions {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal | null;
  env?: NodeJS.ProcessEnv;
  onDelta?: (delta: string) => void;
}

export interface MinimaxCodeRunResult {
  text: string;
  usage: MinimaxCodeUsage | null;
  state: MinimaxCodeExecState;
}

export interface MinimaxCodeExecutorOptions {
  /** Path to the `mcode` binary (default: `mcode` from PATH). */
  command?: string;
  /** Replaces the computed `mcode exec` arguments — used by tests. */
  args?: string[];
  /** Workspace directory handed to the agent. */
  cwd?: string;
  /** Maximum assistant steps for one run (default: 1 — a single answer). */
  maxSteps?: number;
  /** Tool permission policy handed to the CLI (default: `off`). */
  permission?: string;
  /** Run timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra CLI arguments appended to the run. */
  extraArgs?: string[];
  /** Injection point for the process runner (tests). */
  runner?: (options: MinimaxCodeRunOptions) => Promise<MinimaxCodeRunResult>;
  env?: NodeJS.ProcessEnv;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (record.type === "text" || record.type === "input_text" || record.type === "output_text") {
        return typeof record.text === "string" ? record.text : "";
      }
      return "";
    })
    .join("");
}

/** Convert an OpenAI conversation into one explicit MiniMax Code prompt. */
export function buildMinimaxCodePrompt(messages: OpenAIMsg[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const text = textFromContent(message.content).trim();
    if (!text) continue;
    const role = String(message.role || "user");
    const label = role === "system" ? "System" : role === "assistant" ? "Assistant" : "User";
    parts.push(`[${label}]\n${text}`);
  }
  return parts.join("\n\n") || "(empty)";
}

export function resolveMinimaxCodeModel(
  model: unknown
): { ok: true; model: string } | { ok: false; error: string } {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) return { ok: true, model: DEFAULT_MODEL };
  if (requested.startsWith("-")) {
    return {
      ok: false,
      error: `Invalid MiniMax Code model "${requested}": model must not start with "-".`,
    };
  }
  // The catalog namespaces provider models by alias, so both the provider id
  // and its alias must resolve to the runtime model id.
  const namespace = ["minimax-code/", "mmcode/"].find((prefix) => requested.startsWith(prefix));
  const normalized = namespace ? requested.slice(namespace.length) : requested;
  if (!MINIMAX_CODE_MODEL_ALLOWLIST.has(normalized)) {
    return {
      ok: false,
      error: `Unknown MiniMax Code model "${requested}". Supported models: ${[...MINIMAX_CODE_MODEL_ALLOWLIST].join(", ")}.`,
    };
  }
  return { ok: true, model: normalized };
}

/** Build the `mcode exec` command line for one run. */
export function buildMinimaxCodeExecArgs(options: {
  model: string;
  cwd: string;
  maxSteps?: number;
  permission?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}): string[] {
  const args = [
    "exec",
    "--model",
    `${MINIMAX_CODE_PROVIDER_ID}/${options.model}`,
    "--permission",
    options.permission || "off",
    "--output-format",
    "stream-json",
    "--input",
    "-",
    "--input-format",
    "text",
    "--cwd",
    options.cwd,
  ];
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (Number.isFinite(maxSteps) && maxSteps > 0) args.push("--max-steps", String(maxSteps));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0)
    args.push("--timeout", `${Math.ceil(timeoutMs / 1000)}s`);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

export function createExecState(): MinimaxCodeExecState {
  return { text: "", usage: null, status: null, error: null };
}

/**
 * Fold one `mcode exec` event into the run state.
 * Returns the assistant text delta carried by the event ("" when there is none).
 */
export function applyExecEvent(state: MinimaxCodeExecState, event: MinimaxCodeExecEvent): string {
  const type = typeof event.type === "string" ? event.type : "";
  if ((type === "item.started" || type === "item.updated") && event.item) {
    if (
      event.item.type === "agent_message" &&
      typeof event.item.contentDelta === "string" &&
      event.item.contentDelta
    ) {
      state.text += event.item.contentDelta;
      return event.item.contentDelta;
    }
    return "";
  }
  if (
    type === "item.completed" &&
    event.item?.type === "agent_message" &&
    typeof event.item.content === "string"
  ) {
    // The completed item carries the full assistant message.
    state.text = event.item.content;
    return "";
  }
  if (type === "turn.completed" && event.usage) {
    state.usage = event.usage;
    return "";
  }
  if (type === "exec.completed" || type === "exec.failed") {
    const result = event.result ?? {};
    if (typeof result.status === "string") state.status = result.status;
    if (typeof result.output === "string") state.text = result.output;
    if (result.usage) state.usage = result.usage;
    const message = result.error ?? result.message;
    if (type === "exec.failed" || (state.status && state.status !== "succeeded")) {
      state.error =
        typeof message === "string" && message.trim()
          ? message.trim()
          : `MiniMax Code run failed (${state.status ?? "unknown"})`;
    }
  }
  return "";
}

/** Parse JSONL output of `mcode exec --output-format stream-json`. */
export function parseExecJsonl(chunk: string): MinimaxCodeExecEvent[] {
  const events: MinimaxCodeExecEvent[] = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") events.push(parsed as MinimaxCodeExecEvent);
    } catch {
      // Ignore partial or non-JSON lines.
    }
  }
  return events;
}

/** Run one MiniMax Code prompt through the local CLI. */
export async function runMinimaxCodeExec(
  options: MinimaxCodeRunOptions
): Promise<MinimaxCodeRunResult> {
  const state = createExecState();
  let stderr = "";
  let buffer = "";
  let timedOut = false;

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  timer.unref?.();

  const onAbort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdin.on("error", () => undefined);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const event of parseExecJsonl(line)) {
        const delta = applyExecEvent(state, event);
        if (delta) options.onDelta?.(delta);
      }
      index = buffer.indexOf("\n");
    }
  });

  const completion = new Promise<number>((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code ?? 0));
  });

  child.stdin.end(options.prompt, "utf8");

  let code = 0;
  try {
    code = await completion;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (buffer.trim()) {
    for (const event of parseExecJsonl(buffer)) {
      const delta = applyExecEvent(state, event);
      if (delta) options.onDelta?.(delta);
    }
  }

  if (timedOut) throw new Error(`MiniMax Code run timed out after ${options.timeoutMs} ms`);
  if (state.error) throw new Error(state.error);
  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new Error(`MiniMax Code run failed (exit ${code})${tail ? `: ${tail}` : ""}`);
  }
  if (!state.text.trim()) throw new Error("MiniMax Code run produced no assistant response");
  return { text: state.text, usage: state.usage, state };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function completionResponse(
  model: string,
  prompt: string,
  content: string,
  usage: MinimaxCodeUsage | null
): Response {
  const promptTokens = usage?.inputTokens ?? estimateTokens(prompt);
  const completionTokens = usage?.outputTokens ?? estimateTokens(content);
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  return new Response(
    JSON.stringify({
      id: `chatcmpl-minimax-code-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        estimated: usage === null,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function sseChunk(model: string, delta: JsonRecord, finishReason: string | null = null): string {
  const chunk = {
    id: `chatcmpl-minimax-code-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function sseErrorResponse(status: number, message: string): Response {
  const body = `data: ${JSON.stringify(buildErrorBody(status, message))}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export class MinimaxCodeExecutor extends BaseExecutor {
  private readonly options: MinimaxCodeExecutorOptions;

  constructor(options: MinimaxCodeExecutorOptions = {}) {
    super("minimax-code", { id: "minimax-code", baseUrl: MINIMAX_CODE_URL, format: "openai" });
    this.options = options;
  }

  buildUrl(): string {
    return MINIMAX_CODE_URL;
  }

  transformRequest(): null {
    return null;
  }

  private resolveCwd(): string {
    return this.options.cwd || process.env.MINIMAX_CODE_CWD || process.cwd();
  }

  private resolveCommand(): string {
    return this.options.command || process.env.MINIMAX_CODE_BIN || "mcode";
  }

  private resolveTimeoutMs(): number {
    return (
      this.options.timeoutMs ??
      Number(process.env.MINIMAX_CODE_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS)
    );
  }

  private resolveMaxSteps(): number {
    const raw =
      this.options.maxSteps ?? Number(process.env.MINIMAX_CODE_MAX_STEPS || DEFAULT_MAX_STEPS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_STEPS;
  }

  private resolvePermission(): string {
    return this.options.permission || process.env.MINIMAX_CODE_PERMISSION || "off";
  }

  private buildRunOptions(
    model: string,
    prompt: string,
    signal?: AbortSignal | null
  ): MinimaxCodeRunOptions {
    const cwd = this.resolveCwd();
    const args =
      this.options.args ??
      buildMinimaxCodeExecArgs({
        model,
        cwd,
        maxSteps: this.resolveMaxSteps(),
        permission: this.resolvePermission(),
        timeoutMs: this.resolveTimeoutMs(),
        extraArgs: this.options.extraArgs,
      });
    return {
      command: this.resolveCommand(),
      args,
      cwd,
      prompt,
      timeoutMs: this.resolveTimeoutMs(),
      signal,
      env: this.options.env,
    };
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const resolution = resolveMinimaxCodeModel(input.model);
    if (!resolution.ok) {
      const message = "error" in resolution ? resolution.error : "Invalid MiniMax Code model";
      return input.stream ? sseErrorResponse(400, message) : errorResponse(400, message);
    }

    const body = asRecord(input.body);
    const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMsg[]) : [];
    const prompt = buildMinimaxCodePrompt(messages);
    const runner = this.options.runner ?? runMinimaxCodeExec;
    input.log?.info?.("MINIMAX_CODE", `local run started model=${resolution.model}`);

    if (input.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          void (async () => {
            try {
              controller.enqueue(
                encoder.encode(sseChunk(resolution.model, { role: "assistant", content: "" }))
              );
              await runner({
                ...this.buildRunOptions(resolution.model, prompt, input.signal),
                onDelta: (delta) => {
                  controller.enqueue(
                    encoder.encode(sseChunk(resolution.model, { content: delta }))
                  );
                },
              });
              controller.enqueue(encoder.encode(sseChunk(resolution.model, {}, "stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (error) {
              const message = sanitizeErrorMessage(
                error instanceof Error ? error.message : String(error)
              );
              input.log?.warn?.("MINIMAX_CODE", message);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(buildErrorBody(502, message))}\n\ndata: [DONE]\n\n`
                )
              );
            } finally {
              controller.close();
            }
          })();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    try {
      const result = await runner(this.buildRunOptions(resolution.model, prompt, input.signal));
      return completionResponse(resolution.model, prompt, result.text, result.usage);
    } catch (error) {
      const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
      input.log?.warn?.("MINIMAX_CODE", message);
      return errorResponse(502, message);
    }
  }

  // Credentials are intentionally ignored: the local MiniMax Code profile owns auth.
  override buildHeaders(_credentials: ProviderCredentials): Record<string, string> {
    return {};
  }
}

/** Default data dir helper kept for parity with the other local CLI executors. */
export function defaultMinimaxCodeProfileDir(): string {
  return join(homedir(), ".minimax");
}
