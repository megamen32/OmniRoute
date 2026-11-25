/** Check native, account- and tariff-scoped quota observations before dispatch.
 * Start remains fail-closed on unknown quota. Individual remains dispatchable
 * until a fresh observation proves no plan or an exhausted window.
 */
export function evaluateZcodeTariffQuota(
  provider: string,
  authType: string | null | undefined,
  cache: { quotaGroups?: Array<Record<string, unknown>> } | null,
  enabled: boolean,
  minRemaining: (window: string) => number,
  now = Date.now(),
  maxAgeMs = 300_000
): { blocked: boolean; reasons: string[]; resetAt: string | null } | null {
  if (authType !== "oauth") return null;
  const plan = ["zcode-start", "zcode-cn-start"].includes(provider)
    ? "start"
    : ["zcode-individual", "zcode-cn-individual"].includes(provider)
      ? "individual"
      : null;
  if (!plan) return null;
  const group = cache?.quotaGroups?.find((item) => item.plan === plan);
  const observed = typeof group?.observedAt === "string" ? Date.parse(group.observedAt) : NaN;
  const fresh = Number.isFinite(observed) && observed <= now + 30_000 && now - observed <= maxAgeMs;
  const allowUnknownIndividual = plan === "individual";
  const deny = (reason: string, resetAt: string | null = null) => ({
    blocked: true,
    reasons: [`zcode:${plan}:${reason}`],
    resetAt,
  });
  const unknown = () =>
    allowUnknownIndividual ? { blocked: false, reasons: [], resetAt: null } : deny("unknown");
  if (fresh && group?.status === "no_plan" && plan === "start") return deny("no_plan");
  if (!enabled) return null;
  if (!fresh || group?.status !== "available") return unknown();
  const quotas = group.quotas as
    Record<string, { remainingPercentage?: unknown; resetAt?: unknown }> | undefined;
  const windows = Object.entries(quotas || {});
  if (!windows.length) return unknown();
  const required = plan === "start" ? ["tokens"] : ["session", "weekly"];
  if (!required.every((key) => Object.hasOwn(quotas || {}, key))) return unknown();
  for (const [name, quota] of windows) {
    const percent = quota?.remainingPercentage;
    const reset = typeof quota?.resetAt === "string" ? quota.resetAt : null;
    const resetMs = reset ? Date.parse(reset) : NaN;
    if (Number.isFinite(resetMs) && resetMs <= now) return unknown();
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
      return unknown();
    if (percent <= 0 || percent <= minRemaining(name))
      return deny(`quota_${name}`, Number.isFinite(resetMs) ? reset : null);
  }
  return { blocked: false, reasons: [], resetAt: null };
}
