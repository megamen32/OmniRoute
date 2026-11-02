import { randomBytes } from "node:crypto";
import { ZAI_CONFIG } from "../constants/oauth";

/**
 * Z.ai (ZCode) OAuth provider — device_code flow over zcode.z.ai's CLI flow API.
 *
 * Drives the exact contract the official ZCode CLI uses (verified against the
 * installed 3.17.1 runtime):
 *   POST {flowBaseUrl}/oauth/cli/init  {provider:"zai"}  Authorization: Bearer <pollToken>
 *     -> {code, data:{flow_id, authorize_url, expires_at, poll_interval_sec}}
 *   GET  {flowBaseUrl}/oauth/cli/poll/{flow_id}          Authorization: Bearer <pollToken>
 *     -> {status:"pending"|"failed"|"ready", token?, user?, accessToken?, refreshToken?}
 *
 * The pollToken is a locally generated 32-byte hex string; z.ai binds the flow
 * to it, so no shared secret exists. z.ai returns a refresh_token when the
 * account has one; it is preserved for open-sse's generic token refresh.
 */

const EMPTY_STANDARD_TOKEN_FIELDS = {
  idToken: null,
  tokenType: null,
  scope: null,
  oauthExpiresIn: null,
} as const;

interface ZaiInitData {
  flow_id: string;
  authorize_url: string;
  expires_at: number;
  poll_interval_sec: number;
}

interface ZaiDeviceState {
  flowId: string;
  pollToken: string;
}

function parseEnvelope(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Z.ai OAuth flow returned a non-JSON response");
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (typeof record.code !== "number" || (record.code !== 200 && record.code !== 0)) {
    throw new Error(
      `Z.ai OAuth flow error ${JSON.stringify(record.code ?? record.msg ?? "unknown")}`
    );
  }
  return (record.data && typeof record.data === "object" ? record.data : {}) as Record<
    string,
    unknown
  >;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function encodeState(state: ZaiDeviceState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeState(deviceCode: string): ZaiDeviceState {
  const raw = JSON.parse(
    Buffer.from(deviceCode, "base64url").toString("utf8")
  ) as Partial<ZaiDeviceState>;
  if (!raw.flowId || !raw.pollToken) throw new Error("Invalid Z.ai device state");
  return { flowId: raw.flowId, pollToken: raw.pollToken };
}

async function flowApi(
  path: string,
  init: RequestInit,
  pollToken: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`${ZAI_CONFIG.flowBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "user-agent": "ZCode/3.17.1",
      "x-app-id": "zcode",
      authorization: `Bearer ${pollToken}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  if (response.status === 408 || response.status === 429) {
    return { __httpStatus: response.status };
  }
  if (!response.ok) {
    throw new Error(`Z.ai OAuth flow HTTP ${response.status}`);
  }
  return parseEnvelope(body);
}

export const zai = {
  config: ZAI_CONFIG,
  flowType: "device_code" as const,

  async requestDeviceCode() {
    const pollToken = randomBytes(32).toString("hex");
    const data = (await flowApi(
      "/oauth/cli/init",
      { method: "POST", body: JSON.stringify({ provider: ZAI_CONFIG.pollProvider }) },
      pollToken
    )) as unknown as ZaiInitData;
    if (!data.flow_id || !data.authorize_url) {
      throw new Error("Z.ai OAuth init response is missing flow_id/authorize_url");
    }
    const state: ZaiDeviceState = { flowId: data.flow_id, pollToken };
    return {
      deviceCode: encodeState(state),
      verificationUri: data.authorize_url,
      verification_uri: data.authorize_url,
      authorizeUrl: data.authorize_url,
      url: data.authorize_url,
      userCode: null,
      interval: Math.max(1, Math.round(data.poll_interval_sec ?? 2)),
      expiresAt: new Date(data.expires_at * 1000).toISOString(),
    };
  },

  async pollToken(_config: unknown, deviceCode: string) {
    const state = decodeState(deviceCode);
    const data = await flowApi(
      `/oauth/cli/poll/${encodeURIComponent(state.flowId)}`,
      { method: "GET" },
      state.pollToken
    );
    const status = asString(data.status) ?? "pending";
    if (status === "pending") {
      return { ok: true as const, data: { error: "authorization_pending" } };
    }
    if (status === "failed") {
      return {
        ok: true as const,
        data: {
          error: "access_denied",
          error_description: "Z.ai authorization was rejected or expired",
        },
      };
    }
    if (status !== "ready") {
      return { ok: true as const, data: { error: "authorization_pending" } };
    }
    const accessToken = asString(data.accessToken) ?? asString(data.access_token);
    if (!accessToken) throw new Error("Z.ai OAuth ready response is missing accessToken");
    return {
      ok: true as const,
      data: {
        access_token: accessToken,
        refresh_token: asString(data.refreshToken) ?? asString(data.refresh_token),
        zcode_jwt: asString(data.token),
        user_id: (data.user as Record<string, unknown> | undefined)?.user_id ?? null,
      },
    };
  },

  mapTokens(tokens: Record<string, unknown>) {
    return {
      accessToken: String(tokens.access_token ?? ""),
      refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : null,
      expiresIn: null as number | null,
      ...EMPTY_STANDARD_TOKEN_FIELDS,
      providerSpecific: {
        zcodeJwt: tokens.zcode_jwt ? String(tokens.zcode_jwt) : null,
        zaiUserId: tokens.user_id ? String(tokens.user_id) : null,
      },
    };
  },
};
