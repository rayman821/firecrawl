import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../lib/generic-ai";
import { config } from "../config";
import type { Logger } from "winston";

const decomposeSchema = z.object({
  queries: z.array(
    z.object({
      query: z.string().describe("A SERP-optimized search query"),
      intent: z.string().describe("What this sub-query aims to find"),
    }),
  ),
});

export async function decomposeQuery(
  query: string,
  numQueries: number | "auto",
  logger: Logger,
): Promise<{ query: string; intent: string }[]> {
  if (!config.OPENAI_API_KEY && !config.OLLAMA_BASE_URL) {
    throw new Error(
      "Query decomposition requires an AI provider. Set OPENAI_API_KEY or OLLAMA_BASE_URL.",
    );
  }

  const countInstruction =
    numQueries === "auto" ? "2 to 4" : String(numQueries);

  const result = await generateObject({
    model: getModel("gpt-4o-mini"),
    schema: decomposeSchema,
    messages: [
      {
        role: "system",
        content: `You are a search query optimizer. Given a user's search query, decompose it into ${countInstruction} distinct, SERP-optimized search queries that together provide comprehensive coverage of the topic.

Rules:
- Each query should target a different facet or angle of the original query
- Keep queries concise and optimized for search engines
- Do not repeat the same query with minor variations
- The first query should be a concise, direct version of the original
- Today's date is ${new Date().toISOString().split("T")[0]}`,
      },
      {
        role: "user",
        content: query,
      },
    ],
  });

  logger.info("Query decomposition complete", {
    originalQuery: query,
    decomposedCount: result.object.queries.length,
  });

  const maxQueries = typeof numQueries === "number" ? numQueries : 10;
  return result.object.queries.slice(0, maxQueries);
}
