/** Explicit account overrides, not a claim that quota preflight is enabled. */
export function codexCutoffOverrides(
  thresholds: Record<string, number> | null | undefined,
  quotas?: Record<string, unknown> | null
) {
  if (!thresholds) return [];
  return Object.entries(thresholds)
    .filter(
      ([, value]) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    )
    .map(([key, value]) => {
      const raw = quotas?.[key];
      const quota =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const seconds = quota?.windowSeconds;
      const displayName = quota?.displayName;
      const window =
        seconds === 604800
          ? "7d"
          : seconds === 18000
            ? "5h"
            : typeof displayName === "string" && displayName.trim()
              ? displayName.trim()
              : typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
                ? `${seconds}s`
                : key;
      return { window, value };
    });
}
