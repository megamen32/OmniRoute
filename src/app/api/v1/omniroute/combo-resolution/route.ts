import { NextResponse } from "next/server";

import {
  getComboResolvedModel,
  listComboResolvedModels,
} from "@/domain/comboResolvedModelRegistry";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";

function errorJson(status: number, message: string) {
  return NextResponse.json({ error: { message, type: "invalid_request" } }, { status });
}

async function requireInferenceAuth(request: Request): Promise<Response | null> {
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (!apiKey) return errorJson(401, "Authentication required");
  try {
    if (!(await isValidApiKey(apiKey))) return errorJson(403, "Invalid API key");
  } catch {
    return NextResponse.json(
      { error: { message: "Service temporarily unavailable", type: "server_error" } },
      { status: 503 }
    );
  }
  return null;
}

export async function GET(request: Request) {
  const authError = await requireInferenceAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("requestId") || searchParams.get("request_id");
  const sessionId = searchParams.get("sessionId") || searchParams.get("session_id");
  const comboName =
    searchParams.get("comboName") || searchParams.get("combo") || searchParams.get("model");
  const requestedModel = searchParams.get("requestedModel") || searchParams.get("requested_model");
  const limitRaw = searchParams.get("limit");

  if (requestId || searchParams.get("latest") === "1" || searchParams.get("latest") === "true") {
    const record = getComboResolvedModel({ requestId, sessionId, comboName, requestedModel });
    if (!record) return NextResponse.json({ found: false }, { status: 404 });
    return NextResponse.json({ found: true, resolution: record });
  }

  const records = listComboResolvedModels({
    sessionId,
    comboName,
    requestedModel,
    limit: limitRaw ? Number(limitRaw) : undefined,
  });
  return NextResponse.json({ found: records.length > 0, resolutions: records });
}
