import { createHash } from "node:crypto";

type Identity = {
  connectionId: string;
  family: "bigmodel" | "zai";
  accessToken: string;
  accessTokenFormat?: unknown;
};
type CacheEntry = { token?: string; refreshAt?: number; pending?: Promise<string> };
type Obj = Record<string, unknown>;
function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Resolves a project token without creating keys or persisting project credentials. */
export class ZcodeProjectTokenResolver {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly request: typeof fetch = (...args) => fetch(...args)) {}

  async resolve(identity: Identity): Promise<string> {
    const business = identity.accessToken.trim().replace(/^Bearer\s+/i, "");
    if (!identity.connectionId || !["bigmodel", "zai"].includes(identity.family) || !business)
      throw new Error("ZCode project authorization unavailable");
    const key = createHash("sha256")
      .update(JSON.stringify([identity.connectionId, identity.family, business]))
      .digest("hex");
    let entry = this.cache.get(key);
    if (entry?.token && entry.refreshAt && entry.refreshAt > Date.now()) return entry.token;
    if (entry?.pending) return entry.pending;
    if (!entry) {
      if (this.cache.size >= 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      entry = {};
      this.cache.set(key, entry);
    }
    const current = entry;
    const pending = this.issue(business, identity.family, identity.accessTokenFormat === "business")
      .then(({ token, refreshAt }) => {
        current.token = token;
        current.refreshAt = refreshAt;
        return token;
      })
      .catch((error) => {
        if (this.cache.get(key) === current) this.cache.delete(key);
        throw error;
      })
      .finally(() => {
        current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }

  private async issue(
    business: string,
    family: Identity["family"],
    alreadyBusiness = false
  ): Promise<{ token: string; refreshAt: number }> {
    const origin = family === "zai" ? "https://api.z.ai" : "https://bigmodel.cn";
    let businessExpiry = Infinity;
    if (family === "zai" && !alreadyBusiness) {
      const started = Date.now();
      const response = await this.request(`${origin}/api/auth/z/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: business }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const envelope = obj(await response.json()),
        data = obj(envelope.data);
      if (
        !response.ok ||
        envelope.success === false ||
        (envelope.code !== undefined && !["0", "200"].includes(String(envelope.code)))
      )
        throw new Error("ZCode business authorization unavailable");
      const exchanged = str(data.access_token) || str(data.accessToken);
      if (!exchanged) throw new Error("ZCode business authorization unavailable");
      business = exchanged;
      if (
        typeof data.expires_in === "number" &&
        Number.isFinite(data.expires_in) &&
        data.expires_in > 0
      )
        businessExpiry = started + data.expires_in * 1000;
    }
    const get = async (url: string, keyList = false) => {
      const response = await this.request(url, {
        headers: { authorization: keyList && family === "zai" ? `Bearer ${business}` : business },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const envelope = obj(await response.json());
      if (!response.ok || !["0", "200"].includes(String(envelope.code)))
        throw new Error("ZCode project lookup refused");
      return envelope.data;
    };
    const customer = obj(await get(`${origin}/api/biz/customer/getCustomerInfo`));
    const organizations = (Array.isArray(customer.organizations) ? customer.organizations : [])
      .map(obj)
      .map((o) => ({
        ...o,
        projects: (Array.isArray(o.projects) ? o.projects : [])
          .map(obj)
          .filter((p) => String(p.projectType ?? "").trim() !== "2"),
      }))
      .filter((o) => str(o.organizationId) && o.projects.length);
    const org =
      organizations.find((o) => str(o.organizationName).includes("默认机构")) ?? organizations[0];
    const project =
      org?.projects.find((p) => str(p.projectName).includes("默认项目")) ?? org?.projects[0];
    if (!org || !project || !str(project.projectId))
      throw new Error("ZCode personal project unavailable");
    const url = `${origin}/api/biz/v1/organization/${encodeURIComponent(str(org.organizationId))}/projects/${encodeURIComponent(str(project.projectId))}/api_keys`;
    const keys = await get(url, true);
    if (!Array.isArray(keys)) throw new Error("ZCode project key list invalid");
    const matches = keys.map(obj).filter((key) => key.name === "zcode-api-key");
    if (matches.length !== 1 || !str(matches[0].apiKey))
      throw new Error("ZCode project key unavailable or ambiguous");
    const start = Date.now();
    const response = await this.request(
      `${url}/${encodeURIComponent(str(matches[0].apiKey))}/access_tokens`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${business}`, "content-type": "application/json" },
        body: JSON.stringify({ clientType: "zcode", clientVersion: "3.17.2" }),
      }
    );
    const envelope = obj(await response.json()),
      data = obj(envelope.data);
    if (
      !response.ok ||
      !["0", "200"].includes(String(envelope.code)) ||
      data.enable === false ||
      data.tokenType !== "Bearer" ||
      !str(data.accessToken) ||
      typeof data.expiresIn !== "number" ||
      typeof data.expiresAt !== "number"
    )
      throw new Error("ZCode project token unavailable");
    const expiry = Math.min(data.expiresAt * 1000, start + data.expiresIn * 1000);
    if (!Number.isFinite(expiry) || expiry <= Date.now())
      throw new Error("ZCode project token expired");
    return {
      token: str(data.accessToken),
      refreshAt: Math.max(start, Math.min(expiry - 120000, businessExpiry - 300000)),
    };
  }
}
