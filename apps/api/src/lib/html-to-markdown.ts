import koffi from "koffi";
import { config } from "../config";
import "../services/sentry";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import type { Logger } from "winston";
import { stat } from "fs/promises";
import { HTML_TO_MARKDOWN_PATH } from "../natives";
import { convertHTMLToMarkdownWithHttpService } from "./html-to-markdown-client";
import { postProcessMarkdown, convertHtmlToMarkdownSimd } from "@mendable/firecrawl-rs";

// TODO: add a timeout to the Go parser

class GoMarkdownConverter {
  private static instance: GoMarkdownConverter;
  private convert: any;
  private free: any;

  private constructor() {
    const lib = koffi.load(HTML_TO_MARKDOWN_PATH);
    this.free = lib.func("FreeCString", "void", ["string"]);
    const cstn = "CString:" + crypto.randomUUID();
    const freedResultString = koffi.disposable(cstn, "string", this.free);
    this.convert = lib.func("ConvertHTMLToMarkdown", freedResultString, [
      "string",
    ]);
  }

  public static async getInstance(): Promise<GoMarkdownConverter> {
    if (!GoMarkdownConverter.instance) {
      try {
        await stat(HTML_TO_MARKDOWN_PATH);
      } catch (_) {
        throw Error("Go shared library not found");
      }
      GoMarkdownConverter.instance = new GoMarkdownConverter();
    }
    return GoMarkdownConverter.instance;
  }

  public async convertHTMLToMarkdown(html: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.convert.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}

// Extract content words from markdown, stripping syntax
function extractWords(md: string): Set<string> {
  return new Set(
    md
      .replace(/```[\s\S]*?```/g, " ") // strip code blocks (keep words outside)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // strip images
      .replace(/[#*_~`|>\-\[\]()\\]/g, " ") // strip markdown punctuation
      .replace(/https?:\/\/\S+/g, " ") // strip bare URLs
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

// Parse markdown table cells as flat array of trimmed cell text
function extractTableCells(md: string): string[] {
  const cells: string[] = [];
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|[\s\-:|]+\|$/.test(trimmed)) continue; // skip separators
    for (const cell of trimmed.split("|").slice(1, -1)) {
      const text = cell.trim();
      if (text) cells.push(text.toLowerCase());
    }
  }
  return cells;
}

// Count structural markdown elements
function countStructure(md: string) {
  return {
    headings: (md.match(/^#{1,6}\s/gm) || []).length,
    links: (md.match(/\[[^\]]+\]\([^)]+\)/g) || []).length,
    codeBlocks: (md.match(/^```/gm) || []).length / 2,
    images: (md.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length,
    listItems: (md.match(/^[\s]*[-*+]\s|^[\s]*\d+\.\s/gm) || []).length,
  };
}

function shadowSimdConversion(
  html: string,
  goResult: string,
  contextLogger: Logger,
  requestId?: string,
) {
  try {
    const start = performance.now();
    const simdResult = convertHtmlToMarkdownSimd(html);
    const durationMs = performance.now() - start;

    // Word coverage: are all content words from Go present in SIMD?
    const goWords = extractWords(goResult);
    const simdWords = extractWords(simdResult);
    const missingWords: string[] = [];
    for (const w of goWords) {
      if (!simdWords.has(w)) missingWords.push(w);
    }
    const wordCoverage =
      goWords.size > 0 ? 1 - missingWords.length / goWords.size : 1;

    // Table cell comparison
    const goCells = extractTableCells(goResult);
    const simdCells = extractTableCells(simdResult);
    const simdCellSet = new Set(simdCells);
    const missingCells = goCells.filter((c) => !simdCellSet.has(c));
    const tableCellCoverage =
      goCells.length > 0 ? 1 - missingCells.length / goCells.length : 1;

    // Structural comparison
    const goStruct = countStructure(goResult);
    const simdStruct = countStructure(simdResult);

    contextLogger.info("simd-shadow", {
      module: "html-to-markdown",
      shadow: true,
      durationMs: Math.round(durationMs * 100) / 100,
      htmlLen: html.length,
      goLen: goResult.length,
      simdLen: simdResult.length,
      tokenSavings: goResult.length - simdResult.length,
      wordCoverage: Math.round(wordCoverage * 1000) / 1000,
      missingWordCount: missingWords.length,
      missingWordSample: missingWords.slice(0, 10).join(", "),
      tableCellCoverage: Math.round(tableCellCoverage * 1000) / 1000,
      missingCellCount: missingCells.length,
      tableCountGo: goCells.length,
      tableCountSimd: simdCells.length,
      headingDiff: simdStruct.headings - goStruct.headings,
      linkDiff: simdStruct.links - goStruct.links,
      codeBlockDiff: simdStruct.codeBlocks - goStruct.codeBlocks,
      imageDiff: simdStruct.images - goStruct.images,
      listItemDiff: simdStruct.listItems - goStruct.listItems,
      ...(requestId ? { requestId } : {}),
    });
  } catch (error) {
    contextLogger.error("simd-shadow: error", {
      module: "html-to-markdown",
      shadow: true,
      error: error instanceof Error ? error.message : String(error),
      ...(requestId ? { requestId } : {}),
    });
  }
}

export async function parseMarkdown(
  html: string | null | undefined,
  context?: {
    logger?: Logger;
    requestId?: string;
  },
): Promise<string> {
  if (!html) {
    return "";
  }

  const contextLogger = context?.logger || logger;
  const requestId = context?.requestId;

  // Try HTTP service first if enabled
  if (config.HTML_TO_MARKDOWN_SERVICE_URL) {
    try {
      let markdownContent = await convertHTMLToMarkdownWithHttpService(html, {
        logger: contextLogger,
        requestId,
      });
      markdownContent = await postProcessMarkdown(markdownContent);
      setImmediate(() => shadowSimdConversion(html, markdownContent, contextLogger, requestId));
      return markdownContent;
    } catch (error) {
      contextLogger.error(
        "Error converting HTML to Markdown with HTTP service, falling back to original parser",
        { error },
      );
      Sentry.captureException(error, {
        tags: {
          fallback: "original_parser",
          ...(requestId ? { request_id: requestId } : {}),
        },
      });
    }
  }

  try {
    if (config.USE_GO_MARKDOWN_PARSER) {
      const converter = await GoMarkdownConverter.getInstance();
      let markdownContent = await converter.convertHTMLToMarkdown(html);
      markdownContent = await postProcessMarkdown(markdownContent);
      setImmediate(() => shadowSimdConversion(html, markdownContent, contextLogger, requestId));
      return markdownContent;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Go shared library not found"
    ) {
      Sentry.captureException(error, {
        tags: {
          ...(requestId ? { request_id: requestId } : {}),
        },
      });
      contextLogger.error(
        `Error converting HTML to Markdown with Go parser: ${error}`,
      );
    } else {
      contextLogger.warn(
        "Tried to use Go parser, but it doesn't exist in the file system.",
        { HTML_TO_MARKDOWN_PATH },
      );
    }
  }

  // Fallback to TurndownService if Go parser fails or is not enabled
  var TurndownService = require("turndown");
  var turndownPluginGfm = require("joplin-turndown-plugin-gfm");

  const turndownService = new TurndownService();
  turndownService.addRule("inlineLink", {
    filter: function (node, options) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        node.getAttribute("href")
      );
    },
    replacement: function (content, node) {
      var href = node.getAttribute("href").trim();
      var title = node.title ? ' "' + node.title + '"' : "";
      return "[" + content.trim() + "](" + href + title + ")\n";
    },
  });
  var gfm = turndownPluginGfm.gfm;
  turndownService.use(gfm);

  try {
    let markdownContent = await turndownService.turndown(html);
    markdownContent = await postProcessMarkdown(markdownContent);
    setImmediate(() => shadowSimdConversion(html, markdownContent, contextLogger, requestId));
    return markdownContent;
  } catch (error) {
    contextLogger.error("Error converting HTML to Markdown", { error });
    return ""; // Optionally return an empty string or handle the error as needed
  }
}

function processMultiLineLinks(markdownContent: string): string {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char == "[") {
      linkOpenCount++;
    } else if (char == "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char == "\n") {
      newMarkdownContent += "\\" + "\n";
    } else {
      newMarkdownContent += char;
    }
  }
  return newMarkdownContent;
}

function removeSkipToContentLinks(markdownContent: string): string {
  // Remove [Skip to Content](#page) and [Skip to content](#skip)
  const newMarkdownContent = markdownContent.replace(
    /\[Skip to Content\]\(#[^\)]*\)/gi,
    "",
  );
  return newMarkdownContent;
}
