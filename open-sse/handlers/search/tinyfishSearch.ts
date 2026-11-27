import type { SearchProviderConfig } from "../../config/searchRegistry.ts";
import type { SearchResult } from "../search.ts";
import { searchFilterDomain } from "./resultFilters.ts";

interface TinyfishSearchParams {
  query: string;
  searchType?: string;
  maxResults: number;
  token?: string;
  country?: string;
  language?: string;
  timeRange?: string;
  offset?: number;
  domainFilter?: string[];
}

const RECENCY_MINUTES: Record<string, number> = {
  hour: 60,
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

/**
 * The reference documents pages 0..10 and no result-count parameter:
 * https://docs.tinyfish.ai/tinysearch/reference
 * Offset conversion uses a ten-result page as an adapter assumption.
 */
export function buildTinyfishSearchRequest(
  config: SearchProviderConfig,
  params: TinyfishSearchParams
): { url: string; init: RequestInit } {
  const offset = params.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 109) {
    throw new Error("TinyFish Search supports offsets from 0 to 109");
  }
  const qp = new URLSearchParams({
    query: params.query,
    domain_type: params.searchType === "news" ? "news" : "web",
  });
  if (params.country) qp.set("location", params.country.toUpperCase());
  if (params.language) qp.set("language", params.language);
  const includes = (params.domainFilter ?? [])
    .filter((d) => !d.startsWith("-"))
    .map(searchFilterDomain);
  const excludes = (params.domainFilter ?? [])
    .filter((d) => d.startsWith("-"))
    .map((d) => searchFilterDomain(d.slice(1)));
  if (includes.length) qp.set("include_domains", includes.join(","));
  if (excludes.length) qp.set("exclude_domains", excludes.join(","));
  const recency = RECENCY_MINUTES[params.timeRange ?? ""];
  if (recency) qp.set("recency_minutes", String(recency));
  if (offset) qp.set("page", String(Math.floor(offset / 10)));
  return {
    url: config.baseUrl + "?" + qp,
    init: {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(params.token ? { "X-API-Key": params.token } : {}),
      },
    },
  };
}

type MakeResult = (
  provider: string,
  item: {
    title?: string;
    url?: string;
    snippet?: string;
    published_at?: string;
    source_type?: string;
    author?: string;
  },
  index: number,
  now: string
) => SearchResult;

export function normalizeTinyfishSearchResponse(
  data: unknown,
  makeResult: MakeResult
): { results: SearchResult[]; totalResults: number | null } {
  const rows = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(rows)) return { results: [], totalResults: null };
  const now = new Date().toISOString();
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const results = rows
    .filter(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row)
    )
    .map((row, index) =>
      makeResult(
        "tinyfish-search",
        {
          title: text(row.title),
          url: text(row.url),
          snippet: text(row.snippet),
          published_at: text(row.date),
          source_type: text(row.site_name),
          author: text(row.publisher),
        },
        index,
        now
      )
    );
  return { results, totalResults: results.length };
}
