import type { SearchResult } from "../search.ts";

/** URL() repairs "http:///go/..." into a host called "go"; reject that raw form first. */
export function validSearchResultUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\\s]+/i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function searchFilterDomain(value: string): string {
  try {
    return new URL("https://" + value.trim().replace(/^https?:\/\//i, "")).hostname.toLowerCase();
  } catch {
    throw new Error("Invalid search domain filter");
  }
}

export function filterSearchResults(
  results: SearchResult[],
  domainFilter?: string[]
): SearchResult[] {
  const includes = (domainFilter ?? []).filter((d) => !d.startsWith("-")).map(searchFilterDomain);
  const excludes = (domainFilter ?? [])
    .filter((d) => d.startsWith("-"))
    .map((d) => searchFilterDomain(d.slice(1)));
  const matches = (host: string, domain: string) => host === domain || host.endsWith("." + domain);
  return results.filter((result) => {
    if (!validSearchResultUrl(result.url)) return false;
    const host = new URL(result.url).hostname.toLowerCase();
    return (
      (!includes.length || includes.some((domain) => matches(host, domain))) &&
      !excludes.some((domain) => matches(host, domain))
    );
  });
}
