type AuthRequestHeaders = Headers | Record<string, string | string[] | undefined>;

// Keep this helper independent from auth.ts.  auth.ts imports this module for
// the Gemini-specific fallback, so importing its general header helper here
// creates a circular ESM dependency.  The MCP esbuild bundle turns that cycle
// into an invalid `await` inside a synchronous module initializer.
function readHeaderValue(
  headers: AuthRequestHeaders | null | undefined,
  name: string
): string | null {
  if (!headers) return null;

  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name) || (headers as Headers).get(name.toLowerCase());
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  const recordHeaders = headers as Record<string, string | string[] | undefined>;
  const value =
    recordHeaders[name] || recordHeaders[name.toLowerCase()] || recordHeaders[name.toUpperCase()];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" && value[0].trim().length > 0 ? value[0].trim() : null;
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Issue #7034: `gemini-cli` (and any `@google/genai`-based client) sends its
 * credential exclusively via `x-goog-api-key`, and it is not
 * client-configurable to use `Authorization`/`x-api-key` instead — accept it
 * unconditionally, mirroring the existing `x-api-key` fallback shape, just
 * without an `anthropic-version`-style gate (the header name is unambiguous).
 *
 * Extracted to its own module so the two call sites — the real enforcement
 * gate in `src/server/authz/policies/clientApi.ts::extractBearer()` and the
 * general extractor `extractApiKey()` in `./auth.ts` — stay in lockstep
 * without growing the frozen `auth.ts` file (`config/quality/file-size-baseline.json`).
 */
export function extractGoogApiKeyHeader(
  headers: AuthRequestHeaders | null | undefined
): string | null {
  return readHeaderValue(headers, "x-goog-api-key") || readHeaderValue(headers, "X-Goog-Api-Key");
}
