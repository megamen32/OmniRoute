import type { ExecuteInput, ExecutorExecuteResult } from "../base.ts";
import { translateSseResponse } from "../glm.ts";
import { translateNonStreamingResponse } from "../../handlers/responseTranslator.ts";
import { FORMATS } from "../../translator/formats.ts";
import { errorResponse } from "../../utils/error.ts";
import { ensureStreamReadiness } from "../../utils/streamReadiness.ts";
import { STREAM_READINESS_TIMEOUT_MS } from "../../config/constants.ts";
import { isDraining } from "../../../src/lib/gracefulShutdown.ts";
import { resolveSuppressThinkClose, THINKING_MARKER_HEADER } from "../../utils/thinkCloseMarker.ts";
import { readZcodePlanGatewayProfile, type ZcodeGatewayProfile } from "./profileAuth.ts";
import { formatZcodeTransportErrorDiagnostic } from "./transportError.ts";

type RecordValue = Record<string, unknown>;
const ZCODE_STREAM_BUFFER_BYTES = 1024;
// The Individual Coding Plan is the backward-compatible default endpoint.
// Start Plan uses its own ZCode host and Bearer credential.
const INDIVIDUAL_GATEWAY_URL = "https://api.z.ai/api/anthropic/v1/messages";
const GATEWAY_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
};
export type ZcodeRequestAuth = {
  apiKey: string;
  messagesUrl?: string;
  authScheme?: ZcodeGatewayProfile["authScheme"];
  headers?: Record<string, string>;
};
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
function normalizeEffort(value: unknown): "low" | "high" | "max" | null {
  if (value === undefined || value === null) return null;
  if (value === "none" || value === "low") return "low";
  if (value === "medium" || value === "high") return "high";
  if (value === "max") return "max";
  throw new Error("Invalid ZCode reasoning level");
}
function linkConsumerCancellation(response: Response, controller: AbortController): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          streamController.close();
        } else if (next.value) streamController.enqueue(next.value);
      } catch (error) {
        reader.releaseLock();
        streamController.error(error);
      }
    },
    cancel(reason) {
      controller.abort(reason);
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Input has already passed the same validation/image preparation as native RPC.
export function nativeZcodeBody(input: ExecuteInput, request: RecordValue): RecordValue {
  const model =
    input.model.toLowerCase() === "glm-5.3-flash"
      ? "GLM-5.3-Flash"
      : input.model.toLowerCase() === "glm-5.3"
        ? "GLM-5.3"
        : null;
  if (!model) throw new Error("Native gateway supports the ZCode individual plan GLM-5.3 models");
  const raw = record(input.body),
    requestedEfforts = [
      normalizeEffort(raw.reasoning_effort),
      normalizeEffort(record(raw.output_config).effort),
    ].filter((effort): effort is "low" | "high" | "max" => effort !== null),
    // These fields can contain both client intent and a router default. Keep the strongest
    // explicit level so a default low never downgrades a requested high or max.
    effort = requestedEfforts.includes("max")
      ? "max"
      : requestedEfforts.includes("high")
        ? "high"
        : (requestedEfforts[0] ?? "low");
  const messages: RecordValue[] = [],
    system: RecordValue[] = [];
  for (const value of request.messages as unknown[]) {
    const message = record(value),
      content: RecordValue[] = [];
    if (Array.isArray(message.content)) {
      for (const value of message.content) {
        const part = record(value);
        if (part.type === "image") {
          const url = String(part.dataUrl),
            comma = url.indexOf(",");
          if (!url.startsWith("data:") || comma < 0)
            throw new Error("ZCode image was not prepared");
          content.push({
            type: "image",
            source: { type: "base64", media_type: part.mediaType, data: url.slice(comma + 1) },
          });
        } else content.push({ type: "text", text: part.text });
      }
    } else if (message.content) content.push({ type: "text", text: String(message.content) });
    if (message.role === "system" && messages.length === 0) {
      system.push(...content);
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: String(message.content ?? ""),
          },
        ],
      });
      continue;
    }
    for (const value of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const tool = record(value);
      content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
    }
    messages.push({ role: message.role, content });
  }
  const tools = (request.tools as unknown[]).map((value) => {
    const tool = record(value);
    return {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      input_schema: tool.inputSchema,
    };
  });
  return {
    model,
    max_tokens: Math.min(Number(request.maxOutputTokens) || 128000, 128000),
    metadata: {},
    ...(system.length ? { system } : {}),
    messages,
    thinking: { type: "enabled" },
    output_config: { effort },
    ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
    ...(input.stream ? { stream: true } : {}),
  };
}

const PRE_STREAM_PLAN_REFUSALS = new Set([401, 403, 404, 429]);

function responseFromResult(result: ExecutorExecuteResult): Response {
  return result instanceof Response ? result : result.response;
}

/**
 * Use Start first when no profile is explicitly pinned. Only a definitive
 * pre-stream HTTP refusal can move the request to the separate Individual
 * credential. Network/5xx/readiness failures are ambiguous and never replayed.
 */
export async function executeZcodeGatewayWithPlanFallback(
  input: ExecuteInput,
  request: RecordValue,
  providerIds: string[],
  resolveProfile: (providerId: string) => Promise<ZcodeGatewayProfile> = readZcodePlanGatewayProfile
): Promise<ExecutorExecuteResult> {
  let lastProfileError: unknown;
  for (let index = 0; index < providerIds.length; index++) {
    const providerId = providerIds[index];
    let profile: ZcodeGatewayProfile;
    try {
      profile = await resolveProfile(providerId);
    } catch (error) {
      lastProfileError = error;
      if (index + 1 < providerIds.length && !input.signal?.aborted) {
        input.log?.info?.(
          "ZCODE_GATEWAY",
          `${providerId.includes("start-plan") ? "Start" : "Selected"} profile unavailable; checking the next explicitly separate plan`
        );
        continue;
      }
      return errorResponse(401, "The selected ZCode Coding Plan credential is unavailable.");
    }

    const result = await executeZcodeGateway(input, request, profile);
    const response = responseFromResult(result);
    const isStartProfile = profile.plan === "start";
    if (
      isStartProfile &&
      index + 1 < providerIds.length &&
      !input.signal?.aborted &&
      PRE_STREAM_PLAN_REFUSALS.has(response.status)
    ) {
      input.log?.warn?.(
        "ZCODE_GATEWAY",
        `Start Plan refused before streaming (HTTP ${response.status}); trying the separate Individual profile`
      );
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    if (result instanceof Response) return result;
    return {
      ...result,
      transformedBody: {
        ...(result.transformedBody || {}),
        zcodePlan: profile.plan,
      },
    };
  }

  if (lastProfileError) {
    return errorResponse(401, "No enabled ZCode Coding Plan profile is available.");
  }
  return errorResponse(401, "No ZCode Coding Plan profile is available.");
}

export async function executeZcodeGateway(
  input: ExecuteInput,
  request: RecordValue,
  requestAuth?: ZcodeRequestAuth
): Promise<ExecutorExecuteResult> {
  if (input.signal?.aborted || isDraining()) return errorResponse(499, "ZCode request cancelled");
  let body: RecordValue;
  try {
    body = nativeZcodeBody(input, request);
  } catch {
    return errorResponse(400, "Unsupported native ZCode request or reasoning level");
  }
  const apiKey = requestAuth?.apiKey.trim();
  if (!apiKey)
    return errorResponse(401, "Native ZCode gateway requires request-scoped account authorization");
  const consumerCancellation = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, consumerCancellation.signal])
    : consumerCancellation.signal;
  try {
    const apiUrl = requestAuth.messagesUrl || INDIVIDUAL_GATEWAY_URL;
    const authHeaders =
      requestAuth.authScheme === "bearer"
        ? { authorization: `Bearer ${apiKey}` }
        : { "x-api-key": apiKey };
    const upstream = await fetch(apiUrl, {
      method: "POST",
      headers: {
        ...GATEWAY_HEADERS,
        accept: input.stream ? "text/event-stream" : "application/json",
        ...(requestAuth.headers || {}),
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!upstream.ok) {
      if (input.signal?.aborted || isDraining()) {
        await upstream.body?.cancel();
        return errorResponse(499, "ZCode request cancelled");
      }
      const parsed = record(await upstream.json().catch(() => null)),
        error = record(parsed.error);
      const message = String(
        error.message ?? parsed.message ?? "Native ZCode request refused"
      ).replaceAll(apiKey, "[redacted]");
      const response = errorResponse(upstream.status, message);
      const retry = upstream.headers.get("retry-after");
      if (retry) response.headers.set("retry-after", retry);
      return response;
    }
    let response: Response;
    if (input.stream) {
      const ready = await ensureStreamReadiness(upstream, {
        timeoutMs: STREAM_READINESS_TIMEOUT_MS,
        provider: "zcode",
        model: input.model,
        log: input.log,
      });
      const clientHeaders = input.clientHeaders ?? {};
      const suppressThinkClose = resolveSuppressThinkClose({
        userAgent: clientHeaders["user-agent"] ?? clientHeaders["User-Agent"] ?? null,
        thinkingMarkerHeader:
          clientHeaders[THINKING_MARKER_HEADER] ??
          clientHeaders["x-omniroute-thinking-marker"] ??
          null,
        clientResponseFormat: input.clientResponseFormat ?? null,
      });
      response = ready.response.ok
        ? translateSseResponse(
            ready.response,
            "zcode",
            input.model,
            suppressThinkClose,
            ZCODE_STREAM_BUFFER_BYTES
          )
        : ready.response;
      response.headers.set("cache-control", "no-cache");
      response.headers.set("x-accel-buffering", "no");
    } else
      response = Response.json(
        translateNonStreamingResponse(await upstream.json(), FORMATS.CLAUDE, FORMATS.OPENAI)
      );
    response.headers.delete("set-cookie");
    response = linkConsumerCancellation(response, consumerCancellation);
    return {
      response,
      url: apiUrl,
      headers: {},
      transformedBody: {
        model: body.model,
        buffered: false,
        tools: (request.tools as unknown[]).length,
      },
      transport: "zcode-native-gateway",
      model: body.model,
    };
  } catch (error) {
    input.log?.warn?.("ZCODE_GATEWAY", formatZcodeTransportErrorDiagnostic(error));
    return errorResponse(
      input.signal?.aborted || isDraining() ? 499 : 502,
      input.signal?.aborted || isDraining()
        ? "ZCode request cancelled"
        : "ZCode Coding Plan transport failed"
    );
  }
}
