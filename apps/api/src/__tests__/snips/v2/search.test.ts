import {
  concurrentIf,
  describeIf,
  HAS_AI,
  HAS_PROXY,
  HAS_SEARCH,
  itIf,
  TEST_PRODUCTION,
} from "../lib";
import { search, searchRaw, idmux, Identity } from "./lib";
import { config } from "../../../config";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "search",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

// NOTE: if DDG gives us issues with this, we can disable if SEARXNG is not enabled
describeIf(TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY)("Search tests", () => {
  it.concurrent(
    "works",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
    },
    60000,
  );

  it.concurrent(
    "works with scrape",
    async () => {
      const res = await search(
        {
          query: "firecrawl.dev",
          limit: 5,
          scrapeOptions: {
            formats: ["markdown"],
          },
          timeout: 120000,
        },
        identity,
      );

      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);

      let markdownCount = 0;

      for (const doc of res.web ?? []) {
        if (doc.markdown) {
          markdownCount += 1;
        } else {
          // Search can return URLs that are not consistently scrapeable in test environments,
          // so log the failing entries to make partial scrape failures easier to debug.
          console.warn("Search scrape result missing markdown", {
            url: doc.url,
            error: doc.metadata?.error,
            statusCode: doc.metadata?.statusCode,
          });
          expect(doc.metadata?.error).toBeDefined();
        }
      }

      expect(markdownCount).toBeGreaterThan(0);
    },
    125000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "works for news",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["news"],
        },
        identity,
      );
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "works for images",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["images"],
        },
        identity,
      );
      expect(res.images).toBeDefined();
      expect(res.images?.length).toBeGreaterThan(0);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "works for multiple sources",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["web", "news", "images"],
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.images).toBeDefined();
      expect(res.images?.length).toBeGreaterThan(0);
    },
    60000,
  );

  it.concurrent(
    "respects limit for web",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 3,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(3);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "respects limit for news",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["news"],
          limit: 2,
        },
        identity,
      );
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.news?.length).toBeLessThanOrEqual(2);
    },
    60000,
  );

  it.concurrent(
    "respects limit for above 10",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 20,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(20);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "respects limit for above 10 images",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["images"],
          limit: 20,
        },
        identity,
      );
      expect(res.images).toBeDefined();
      expect(res.images?.length).toBeGreaterThan(0);
      expect(res.images?.length).toBeLessThanOrEqual(20);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "respects limit for above 10 multiple sources",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["web", "news"],
          limit: 20,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(20);
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.news?.length).toBeLessThanOrEqual(20);
    },
    60000,
  );

  it.concurrent(
    "country defaults to undefined when location is set",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          location: "San Francisco",
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
    },
    60000,
  );

  // SEARXNG-specific pagination tests
  concurrentIf(!!config.SEARXNG_ENDPOINT)(
    "searxng respects limit of 2 results",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 2,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(2);
    },
    60000,
  );

  concurrentIf(!!config.SEARXNG_ENDPOINT)(
    "searxng fetches multiple pages for 21 results",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 21,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(21);
    },
    60000,
  );

  // Query decomposition tests (sequential to avoid DDG rate limits)
  itIf(HAS_AI)(
    "auto decomposition returns results",
    async () => {
      const res = await search(
        {
          query: "web scraping best practices",
          decomposition: "auto",
          limit: 5,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(5);
    },
    120000,
  );

  itIf(HAS_AI)(
    "manual decomposition with numQueries and searchesPerQuery",
    async () => {
      const res = await search(
        {
          query: "javascript testing frameworks",
          decomposition: { numQueries: 2, searchesPerQuery: 2 },
          limit: 5,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(5);
    },
    120000,
  );

  itIf(HAS_AI)(
    "decomposition deduplicates results by URL",
    async () => {
      const res = await search(
        {
          query: "python web scraping tutorial",
          decomposition: { numQueries: 2, searchesPerQuery: 3 },
          limit: 8,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      const urls = res.web?.map(r => r.url) ?? [];
      const uniqueUrls = new Set(urls);
      expect(urls.length).toBe(uniqueUrls.size);
    },
    120000,
  );

  it.concurrent(
    "rejects invalid decomposition numQueries",
    async () => {
      const raw = await searchRaw(
        {
          query: "firecrawl",
          decomposition: { numQueries: 10 },
        } as any,
        identity,
      );
      expect(raw.statusCode).toBe(400);
    },
    60000,
  );
});
