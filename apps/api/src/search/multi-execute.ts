import type { Logger } from "winston";
import { SearchV2Response } from "../lib/entities";
import { ScrapeOptions } from "../controllers/v2/types";
import {
  getItemsToScrape,
  scrapeSearchResults,
  mergeScrapedContent,
  calculateScrapeCredits,
} from "./scrape";
import {
  executeSearch,
  SearchOptions,
  SearchContext,
  SearchExecuteResult,
} from "./execute";

interface MultiSearchQuery {
  query: string;
  limit: number;
}

export async function executeMultiSearch(
  queries: MultiSearchQuery[],
  baseOptions: Omit<SearchOptions, "query" | "limit" | "scrapeOptions">,
  scrapeOptions: ScrapeOptions | undefined,
  context: SearchContext,
  totalLimit: number,
  logger: Logger,
): Promise<SearchExecuteResult> {
  logger.info("Starting multi-search execution", {
    queryCount: queries.length,
    totalLimit,
  });

  // Run all sub-queries in parallel WITHOUT scraping (scrape after dedup)
  // Use allSettled so one failing sub-query doesn't kill the whole operation
  const settled = await Promise.allSettled(
    queries.map((q, i) =>
      executeSearch(
        {
          ...baseOptions,
          query: q.query,
          limit: q.limit,
          scrapeOptions: undefined,
        },
        context,
        logger.child({ subQuery: i, query: q.query }),
      ),
    ),
  );

  const subResults: SearchExecuteResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      subResults.push(result.value);
    } else {
      logger.warn("Sub-query failed, continuing with remaining results", {
        error: result.reason?.message,
      });
    }
  }

  if (subResults.length === 0) {
    // All sub-queries failed — rethrow the first error
    const firstRejected = settled.find(
      r => r.status === "rejected",
    ) as PromiseRejectedResult;
    throw firstRejected.reason;
  }

  // Merge and deduplicate results
  const merged = mergeAndDedup(subResults, totalLimit);

  // Sum search credits from all sub-queries
  const searchCredits = subResults.reduce((sum, r) => sum + r.searchCredits, 0);
  let scrapeCredits = 0;

  // Single scrape pass on merged+deduped results
  const shouldScrape =
    scrapeOptions?.formats && scrapeOptions.formats.length > 0;

  if (shouldScrape && scrapeOptions) {
    const itemsToScrape = getItemsToScrape(merged, context.flags);

    if (itemsToScrape.length > 0) {
      const scrapeOpts = {
        teamId: context.teamId,
        origin: context.origin,
        timeout: baseOptions.timeout,
        scrapeOptions,
        bypassBilling: context.bypassBilling ?? false,
        apiKeyId: context.apiKeyId,
        zeroDataRetention: context.zeroDataRetention,
        requestId: context.requestId,
        billing: context.billing,
        agentIndexOnly: context.agentIndexOnly,
      };

      const allDocsWithCostTracking = await scrapeSearchResults(
        itemsToScrape.map(i => i.scrapeInput),
        scrapeOpts,
        logger,
        context.flags,
      );

      mergeScrapedContent(merged, itemsToScrape, allDocsWithCostTracking);
      scrapeCredits = calculateScrapeCredits(allDocsWithCostTracking);
    }
  }

  const totalResultsCount =
    (merged.web?.length ?? 0) +
    (merged.images?.length ?? 0) +
    (merged.news?.length ?? 0);

  return {
    response: merged,
    totalResultsCount,
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
  };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    // Strip trailing slash
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return url;
  }
}

function mergeAndDedup(
  results: SearchExecuteResult[],
  totalLimit: number,
): SearchV2Response {
  const seenUrls = new Set<string>();
  const merged: SearchV2Response = {};

  // Merge web results
  const allWeb = results.flatMap(r => r.response.web ?? []);
  if (allWeb.length > 0) {
    merged.web = [];
    for (const item of allWeb) {
      const norm = normalizeUrl(item.url);
      if (!seenUrls.has(norm)) {
        seenUrls.add(norm);
        merged.web.push(item);
      }
    }
    if (merged.web.length > totalLimit) {
      merged.web = merged.web.slice(0, totalLimit);
    }
  }

  // Merge news results
  const allNews = results.flatMap(r => r.response.news ?? []);
  if (allNews.length > 0) {
    merged.news = [];
    const seenNewsUrls = new Set<string>();
    for (const item of allNews) {
      if (!item.url) {
        merged.news.push(item);
        continue;
      }
      const norm = normalizeUrl(item.url);
      if (!seenNewsUrls.has(norm) && !seenUrls.has(norm)) {
        seenNewsUrls.add(norm);
        merged.news.push(item);
      }
    }
    if (merged.news.length > totalLimit) {
      merged.news = merged.news.slice(0, totalLimit);
    }
  }

  // Merge image results
  const allImages = results.flatMap(r => r.response.images ?? []);
  if (allImages.length > 0) {
    merged.images = [];
    const seenImageUrls = new Set<string>();
    for (const item of allImages) {
      const key = item.imageUrl ?? item.url ?? "";
      if (!key || !seenImageUrls.has(key)) {
        if (key) seenImageUrls.add(key);
        merged.images.push(item);
      }
    }
    if (merged.images.length > totalLimit) {
      merged.images = merged.images.slice(0, totalLimit);
    }
  }

  return merged;
}
