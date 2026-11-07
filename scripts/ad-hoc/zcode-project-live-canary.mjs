import { getProviderConnections, getProviderConnectionById } from "../../src/lib/db/providers.ts";
import { fetchSignedZcodeProject } from "../../open-sse/executors/zcode/nativeProtocol.ts";
import { randomUUID } from "node:crypto";

const result = { phase: "account" };
try {
  const rows = (await getProviderConnections({ provider: "zcode" })).filter(
    (x) => x.providerSpecificData?.family === "bigmodel" && x.isActive
  );
  if (rows.length !== 1) throw Error("ambiguous_account");
  const c = await getProviderConnectionById(rows[0].id);
  if (!c.accessToken) throw Error("missing_token");
  const business = c.accessToken.trim().replace(/^Bearer\s+/i, "");
  async function get(url) {
    const response = await fetch(url, {
      headers: { authorization: business },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok || !["0", "200"].includes(String(value.code))) throw Error("lookup_refused");
    return value.data;
  }
  result.phase = "project";
  const customer = await get("https://bigmodel.cn/api/biz/customer/getCustomerInfo");
  const orgs = (customer.organizations || [])
    .map((x) => ({
      ...x,
      projects: (x.projects || []).filter((p) => String(p.projectType ?? "").trim() !== "2"),
    }))
    .filter((x) => x.organizationId && x.projects.length);
  const org = orgs.find((x) => x.organizationName?.includes("默认机构")) || orgs[0];
  const project =
    org?.projects.find((x) => x.projectName?.includes("默认项目")) || org?.projects[0];
  if (!org?.organizationId || !project?.projectId) throw Error("project_unavailable");
  const endpoint = `https://bigmodel.cn/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const keys = await get(endpoint);
  if (!Array.isArray(keys)) throw Error("invalid_key_list");
  const matches = keys.filter(
    (x) => x?.name === "zcode-api-key" && typeof x.apiKey === "string" && x.apiKey.trim()
  );
  if (matches.length !== 1) throw Error("missing_or_ambiguous_key");
  result.phase = "token_post";
  const started = Date.now();
  const response = await fetch(
    `${endpoint}/${encodeURIComponent(matches[0].apiKey)}/access_tokens`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${business}`, "content-type": "application/json" },
      body: JSON.stringify({ clientType: "zcode", clientVersion: "3.17.2" }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }
  );
  result.tokenHttp = response.status;
  const value = await response.json();
  result.tokenCode = String(value.code);
  if (!response.ok || !["0", "200"].includes(String(value.code))) throw Error("token_refused");
  const data = value.data;
  if (data?.enable === false) throw Error("token_disabled");
  if (
    typeof data?.accessToken !== "string" ||
    data.tokenType !== "Bearer" ||
    typeof data.expiresIn !== "number" ||
    typeof data.expiresAt !== "number" ||
    Math.min(data.expiresAt * 1000, started + data.expiresIn * 1000) <= Date.now()
  )
    throw Error("invalid_token_response");
  result.tokenValid = true;
  result.phase = "inference";
  const before = process.memoryUsage().rss;
  const begin = performance.now();
  const stream = await fetchSignedZcodeProject(
    data.accessToken,
    {
      model: "GLM-5.3-Flash",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "Ответь коротко: привет." }],
    },
    randomUUID(),
    fetch,
    AbortSignal.timeout(45000)
  );
  result.http = stream.status;
  result.contentType = stream.headers.get("content-type")?.split(";")[0];
  if (!stream.ok || !stream.body) {
    const errorBody = await stream.json().catch(() => null);
    const providerCode = errorBody?.code ?? errorBody?.error?.code;
    if (["string", "number"].includes(typeof providerCode)) {
      result.providerCode = String(providerCode)
        .slice(0, 40)
        .replace(/[^a-zA-Z0-9_.-]/g, "");
    }
    result.retryAfter = stream.headers.get("retry-after");
    throw Error("inference_refused");
  }
  const reader = stream.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    deltas = 0,
    first = null,
    stopped = false,
    peak = before;
  for (;;) {
    const chunk = await reader.read();
    peak = Math.max(peak, process.memoryUsage().rss);
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const event = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      for (const line of event.split("\n"))
        if (line.startsWith("data:")) {
          try {
            const obj = JSON.parse(line.slice(5));
            if (obj.type === "content_block_delta" && (obj.delta?.text || obj.delta?.thinking)) {
              deltas++;
              first ??= Math.round(performance.now() - begin);
            }
            if (obj.type === "message_stop") stopped = true;
          } catch {}
        }
    }
  }
  Object.assign(result, {
    firstDeltaMs: first,
    deltas,
    completedMs: Math.round(performance.now() - begin),
    completed: stopped,
    rssBefore: before,
    rssPeak: peak,
    phase: "done",
  });
} catch (error) {
  result.error = [
    "ambiguous_account",
    "missing_token",
    "lookup_refused",
    "project_unavailable",
    "invalid_key_list",
    "missing_or_ambiguous_key",
    "token_refused",
    "token_disabled",
    "invalid_token_response",
    "inference_refused",
  ].includes(error?.message)
    ? error.message
    : error?.name || "error";
}
console.log("RESULT " + JSON.stringify(result));
process.exit();
