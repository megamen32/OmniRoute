function safeErrorField(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : null;
}

/** Extract transport exception classes/codes without logging message text or secrets. */
export function formatZcodeTransportErrorDiagnostic(error: unknown): string {
  const outer = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const cause =
    outer.cause && typeof outer.cause === "object" ? (outer.cause as Record<string, unknown>) : {};
  const parts = [
    `name=${safeErrorField(outer.name) ?? "Unknown"}`,
    `code=${safeErrorField(outer.code) ?? "none"}`,
    `causeName=${safeErrorField(cause.name) ?? "none"}`,
    `causeCode=${safeErrorField(cause.code) ?? "none"}`,
  ];
  return `Native transport exception (${parts.join(" ")})`;
}
