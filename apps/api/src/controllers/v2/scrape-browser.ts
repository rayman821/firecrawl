import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  insertBrowserSession,
  updateBrowserSessionActivity,
  updateBrowserSessionCreditsUsed,
  claimBrowserSessionDestroyed,
  getActiveBrowserSessionCount,
  invalidateActiveBrowserSessionCount,
  MAX_ACTIVE_BROWSER_SESSIONS_PER_TEAM,
  getBrowserSessionFromScrape,
} from "../../lib/browser-sessions";
import { RequestWithAuth } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { logRequest } from "../../services/logging/log_job";
import { integrationSchema } from "../../utils/integration";
import { supabaseGetScrapeById } from "../../lib/supabase-jobs";
import { rewriteUrl } from "../../scraper/scrapeURL/lib/rewriteUrl";

const BROWSER_CREDITS_PER_HOUR = 120;

/**
 * Calculate credits to bill for a browser session based on its duration.
 * Prorates to the millisecond. Minimum charge is 1 credit.
 */
function calculateBrowserSessionCredits(durationMs: number): number {
  const hours = durationMs / 3_600_000;
  return Math.max(1, Math.ceil(hours * BROWSER_CREDITS_PER_HOUR));
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.object({
  ttl: z.number().min(30).max(3600).default(600),
  activityTtl: z.number().min(10).max(3600).default(300),
  streamWebView: z.boolean().default(true),
  integration: integrationSchema.optional().transform(val => val || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
});

const browserExecuteRequestSchema = z.object({
  code: z.string().min(1).max(100_000),
  language: z.enum(["python", "node", "bash"]).default("node"),
  timeout: z.number().min(1).max(300).default(30),
  origin: z.string().optional(),
});

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  stdout?: string;
  result?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  error?: string;
}

interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  creditsBilled?: number;
  error?: string;
}

interface BrowserListResponse {
  success: boolean;
  sessions?: Array<{
    id: string;
    status: string;
    cdpUrl: string;
    liveViewUrl: string;
    interactiveLiveViewUrl: string;
    streamWebView: boolean;
    createdAt: string;
    lastActivity: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build headers for authenticating against the browser service.
 */
function browserServiceHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
  if (config.BROWSER_SERVICE_API_KEY) {
    headers["Authorization"] = `Bearer ${config.BROWSER_SERVICE_API_KEY}`;
  }
  return headers;
}

class BrowserServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Call the browser service and return parsed JSON.
 * Throws on non-2xx responses.
 */
async function browserServiceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.BROWSER_SERVICE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: browserServiceHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BrowserServiceError(
      res.status,
      `Browser service ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Browser service response types
// ---------------------------------------------------------------------------

interface BrowserServiceCreateResponse {
  sessionId: string;
  cdpUrl: string;
  viewUrl: string;
  iframeUrl: string;
  interactiveIframeUrl: string;
  expiresAt: string;
}

interface BrowserServiceExecResponse {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

interface BrowserServiceDeleteResponse {
  ok: boolean;
  sessionDurationMs: number;
}

interface ScrapeContextRow {
  id: string;
  team_id: string;
  url: string | null;
  options: unknown;
}

type ReplayAction =
  | { type: "wait"; milliseconds?: number; selector?: string }
  | { type: "click"; selector: string; all?: boolean }
  | { type: "write"; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction?: "up" | "down"; selector?: string }
  | { type: "executeJavascript"; script: string }
  | { type: "screenshot" | "pdf" | "scrape" };

type ScrapeReplayContext = {
  targetUrl: string;
  waitForMs: number;
  actions: ReplayAction[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function clampPositiveInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.min(Math.floor(value), max);
}

function sanitizeReplayActions(rawActions: unknown): ReplayAction[] {
  if (!Array.isArray(rawActions)) return [];

  const actions: ReplayAction[] = [];

  for (const rawAction of rawActions) {
    if (!isRecord(rawAction)) continue;
    const type = rawAction.type;

    if (type === "wait") {
      const milliseconds = clampPositiveInteger(rawAction.milliseconds, 60_000);
      const selector =
        typeof rawAction.selector === "string" &&
        rawAction.selector.trim().length > 0
          ? rawAction.selector
          : undefined;
      if (
        (milliseconds === undefined && !selector) ||
        (milliseconds && selector)
      ) {
        continue;
      }
      actions.push({
        type,
        ...(milliseconds !== undefined ? { milliseconds } : {}),
        ...(selector ? { selector } : {}),
      });
      continue;
    }

    if (type === "click") {
      if (
        typeof rawAction.selector !== "string" ||
        rawAction.selector.length === 0
      ) {
        continue;
      }
      actions.push({
        type,
        selector: rawAction.selector,
        all: rawAction.all === true,
      });
      continue;
    }

    if (type === "write") {
      if (typeof rawAction.text !== "string") continue;
      actions.push({ type, text: rawAction.text });
      continue;
    }

    if (type === "press") {
      if (typeof rawAction.key !== "string") continue;
      actions.push({ type, key: rawAction.key });
      continue;
    }

    if (type === "scroll") {
      const direction = rawAction.direction === "up" ? "up" : "down";
      const selector =
        typeof rawAction.selector === "string" &&
        rawAction.selector.trim().length > 0
          ? rawAction.selector
          : undefined;
      actions.push({
        type,
        direction,
        ...(selector ? { selector } : {}),
      });
      continue;
    }

    if (type === "executeJavascript") {
      if (typeof rawAction.script !== "string") continue;
      actions.push({ type, script: rawAction.script });
      continue;
    }

    if (type === "screenshot" || type === "pdf" || type === "scrape") {
      actions.push({ type });
    }
  }

  return actions;
}

function buildReplayContextFromScrape(scrape: ScrapeContextRow): {
  context?: ScrapeReplayContext;
  error?: string;
} {
  if (
    typeof scrape.url !== "string" ||
    scrape.url.trim().length === 0 ||
    scrape.url.startsWith("<redacted")
  ) {
    return {
      error:
        "Replay context is unavailable for this scrape job because the source URL was not retained.",
    };
  }

  if (!isRecord(scrape.options)) {
    return {
      error:
        "Replay context is unavailable for this scrape job because scrape options were not retained.",
    };
  }

  let targetUrl: string;
  try {
    targetUrl = rewriteUrl(scrape.url) ?? scrape.url;
  } catch {
    return {
      error:
        "Replay context is unavailable for this scrape job because the stored URL is invalid.",
    };
  }

  const waitForMs = clampPositiveInteger(scrape.options.waitFor, 60_000) ?? 0;
  const actions = sanitizeReplayActions(scrape.options.actions);

  return {
    context: {
      targetUrl,
      waitForMs,
      actions,
    },
  };
}

function estimateReplayTimeoutSeconds(context: ScrapeReplayContext): number {
  const actionWaitMs = context.actions.reduce((total, action) => {
    if (action.type !== "wait") return total;
    if (typeof action.milliseconds === "number")
      return total + action.milliseconds;
    if (action.selector) return total + 1_000;
    return total;
  }, 0);

  const waitBudgetMs = context.waitForMs + actionWaitMs;
  return Math.min(300, Math.max(30, Math.ceil((waitBudgetMs + 45_000) / 1000)));
}

function buildReplayScript(context: ScrapeReplayContext): string {
  const payload = JSON.stringify(context);
  return `
const replay = ${payload};

const failReplay = (step, error) => {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  throw new Error(\`\${step}: \${reason}\`);
};

try {
  await page.goto(replay.targetUrl, { waitUntil: "domcontentloaded" });
} catch (error) {
  failReplay("Failed to load scrape URL", error);
}

if (typeof replay.waitForMs === "number" && replay.waitForMs > 0) {
  await page.waitForTimeout(Math.min(replay.waitForMs, 30000));
}

for (let i = 0; i < replay.actions.length; i += 1) {
  const action = replay.actions[i];
  const step = \`Replay action #\${i + 1} (\${action.type})\`;

  try {
    switch (action.type) {
      case "wait":
        if (typeof action.milliseconds === "number") {
          await page.waitForTimeout(Math.min(action.milliseconds, 60000));
        } else if (typeof action.selector === "string") {
          await page.waitForSelector(action.selector, { timeout: 60000 });
        }
        break;
      case "click":
        if (action.all) {
          const locator = page.locator(action.selector);
          const count = await locator.count();
          for (let idx = 0; idx < count; idx += 1) {
            await locator.nth(idx).click();
          }
        } else {
          await page.click(action.selector);
        }
        break;
      case "write":
        await page.keyboard.type(action.text);
        break;
      case "press":
        await page.keyboard.press(action.key);
        break;
      case "scroll":
        if (typeof action.selector === "string") {
          await page.evaluate(
            ({ selector, direction }) => {
              const el = document.querySelector(selector);
              if (!el) {
                throw new Error(\`Selector not found: \${selector}\`);
              }
              const delta = direction === "up" ? -window.innerHeight : window.innerHeight;
              if (typeof el.scrollBy === "function") {
                el.scrollBy(0, delta);
              } else {
                window.scrollBy(0, delta);
              }
            },
            { selector: action.selector, direction: action.direction ?? "down" },
          );
        } else {
          await page.mouse.wheel(0, action.direction === "up" ? -800 : 800);
        }
        break;
      case "executeJavascript": {
        const wrapped = \`(async () => { \${action.script} })()\`;
        await page.evaluate(script => (0, eval)(script), wrapped);
        break;
      }
      case "screenshot":
      case "pdf":
      case "scrape":
        console.log(\`[firecrawl-replay] skipping output-only action: \${action.type}\`);
        break;
      default:
        console.log(\`[firecrawl-replay] skipping unsupported action type: \${String(action.type)}\`);
        break;
    }
  } catch (error) {
    failReplay(step, error);
  }
}
`;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export async function scrapeExecuteController(
  req: RequestWithAuth<
    { jobId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  req.body = browserExecuteRequestSchema.parse(req.body);

  const scrapeId = req.params.jobId;
  const { code, language, timeout, origin } = req.body;

  let logger = _logger.child({
    scrapeId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserExecuteController",
  });

  const scrape = (await supabaseGetScrapeById(
    scrapeId,
  )) as ScrapeContextRow | null;
  if (!scrape) {
    return res.status(404).json({
      success: false,
      error: "Job not found.",
    });
  }

  if (scrape.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  const replay = buildReplayContextFromScrape(scrape);
  if (!replay.context) {
    return res.status(409).json({
      success: false,
      error:
        replay.error ??
        "Replay context is unavailable for this scrape job. Please rerun the scrape.",
    });
  }
  const replayContext = replay.context;

  logger = logger.child({
    replayTargetUrl: replayContext.targetUrl,
    replayWaitForMs: replayContext.waitForMs,
    replayActions: replayContext.actions.length,
  });

  // Look up session from Supabase
  let session = await getBrowserSessionFromScrape(scrapeId);

  if (!session) {
    const sessionId = uuidv7();
    const { ttl, activityTtl, streamWebView, profile, integration } =
      browserCreateRequestSchema.parse({});

    if (!config.BROWSER_SERVICE_URL) {
      return res.status(503).json({
        success: false,
        error:
          "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
      });
    }

    logger.info("No browser session found for scrape. Creating one.", {
      scrapeId,
      ttl,
      activityTtl,
    });

    // 0a. Check if team has enough credits for the full TTL
    const estimatedCredits = calculateBrowserSessionCredits(ttl * 1000);
    if (req.acuc && req.acuc.remaining_credits < estimatedCredits) {
      logger.warn("Insufficient credits for browser session TTL", {
        estimatedCredits,
        remainingCredits: req.acuc.remaining_credits,
        ttl,
      });
      return res.status(402).json({
        success: false,
        error: `Insufficient credits for a ${ttl}s browser session (requires ~${estimatedCredits} credits). For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.`,
      });
    }

    // 0b. Enforce per-team active session limit
    const activeCount = await getActiveBrowserSessionCount(req.auth.team_id);
    if (activeCount >= MAX_ACTIVE_BROWSER_SESSIONS_PER_TEAM) {
      logger.warn("Active browser session limit reached", {
        activeCount,
        limit: MAX_ACTIVE_BROWSER_SESSIONS_PER_TEAM,
      });
      return res.status(429).json({
        success: false,
        error: `You have reached the maximum number of active browser sessions (${MAX_ACTIVE_BROWSER_SESSIONS_PER_TEAM}). Please destroy existing sessions before creating new ones.`,
      });
    }

    // 1. Create a browser session via the browser service (retry up to 3 times)
    const MAX_CREATE_RETRIES = 3;
    let svcResponse: BrowserServiceCreateResponse | undefined;
    let lastCreateError: unknown;

    // Build persistentStorage from profile if provided
    let persistentStorage: { uniqueId: string; write: boolean } | undefined;
    if (profile) {
      const teamHash = createHash("sha256")
        .update(req.auth.team_id)
        .digest("hex")
        .slice(0, 16);
      persistentStorage = {
        uniqueId: `${teamHash}_${profile.name}`,
        write: profile.saveChanges !== false,
      };
    }

    for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
      try {
        svcResponse = await browserServiceRequest<BrowserServiceCreateResponse>(
          "POST",
          "/browsers",
          {
            ttl,
            ...(activityTtl !== undefined ? { activityTtl } : {}),
            ...(persistentStorage !== undefined ? { persistentStorage } : {}),
          },
        );
        break;
      } catch (err) {
        // 409 means the profile is locked by another writer — don't retry
        if (err instanceof BrowserServiceError && err.status === 409) {
          logger.warn("Profile is locked", {
            profileName: profile?.name,
            error: err,
          });
          return res.status(409).json({
            success: false,
            error:
              "Another session is currently writing to this profile. Only one writer is allowed at a time. You can still access it with saveChanges: false, or try again later.",
          });
        }

        lastCreateError = err;
        logger.warn("Browser session creation attempt failed", {
          attempt,
          maxRetries: MAX_CREATE_RETRIES,
          error: err,
        });
        if (attempt < MAX_CREATE_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 200 * attempt));
        }
      }
    }

    if (!svcResponse) {
      logger.error("Failed to create browser session after all retries", {
        error: lastCreateError,
        attempts: MAX_CREATE_RETRIES,
      });
      return res.status(502).json({
        success: false,
        error: "Failed to create browser session.",
      });
    }

    // 2. Replay original scrape context into the fresh browser session
    try {
      const replayResult =
        await browserServiceRequest<BrowserServiceExecResponse>(
          "POST",
          `/browsers/${svcResponse.sessionId}/exec`,
          {
            code: buildReplayScript(replayContext),
            language: "node",
            timeout: estimateReplayTimeoutSeconds(replayContext),
            origin: "scrape_replay",
          },
        );

      const replayFailed = replayResult.exitCode !== 0 || replayResult.killed;
      if (replayFailed) {
        throw new Error(
          replayResult.stderr?.trim() ||
            replayResult.stdout?.trim() ||
            "Replay script exited with an error.",
        );
      }
    } catch (err) {
      logger.error("Failed to initialize scrape browser session context", {
        error: err,
      });
      await browserServiceRequest(
        "DELETE",
        `/browsers/${svcResponse.sessionId}`,
      ).catch(() => {});
      return res.status(409).json({
        success: false,
        error:
          "Failed to initialize browser session from the original scrape context. Please rerun the scrape and try again.",
      });
    }

    // 3. Persist session in Supabase
    try {
      await logRequest({
        id: sessionId,
        kind: "browser",
        api_version: "v2",
        team_id: req.auth.team_id,
        target_hint: "Browser session",
        origin: "api",
        integration: integration ?? null,
        zeroDataRetention: false,
        api_key_id: req.acuc?.api_key_id ?? null,
      });
      session = await insertBrowserSession({
        id: sessionId,
        team_id: req.auth.team_id,
        scrape_id: scrapeId,
        browser_id: svcResponse.sessionId,
        workspace_id: "",
        context_id: "",
        cdp_url: svcResponse.cdpUrl,
        cdp_path: svcResponse.iframeUrl, // repurposed: stores view URL
        cdp_interactive_path: svcResponse.interactiveIframeUrl, // repurposed: stores interactive view URL
        stream_web_view: streamWebView,
        status: "active",
        ttl_total: ttl,
        ttl_without_activity: activityTtl ?? null,
        credits_used: null,
      });
    } catch (err) {
      // If we can't persist, tear down the browser session
      logger.error("Failed to persist browser session, cleaning up", {
        error: err,
      });
      await browserServiceRequest(
        "DELETE",
        `/browsers/${svcResponse.sessionId}`,
      ).catch(() => {});
      return res.status(500).json({
        success: false,
        error: "Failed to persist browser session.",
      });
    }

    // Invalidate cached count so next check reflects the new session
    invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});

    logger = logger.child({
      sessionId: session.id,
      browserId: session.browser_id,
    });
    logger.info("Browser session created for scrape", {
      scrapeId,
      sessionId: session.id,
      browserId: session.browser_id,
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  if (session.status === "destroyed") {
    return res.status(410).json({
      success: false,
      error: "Browser session has been destroyed.",
    });
  }

  // Update activity timestamp (fire-and-forget)
  updateBrowserSessionActivity(session.id).catch(() => {});

  logger.info("Executing code in browser session", { language, timeout });

  // Execute code via the browser service
  let execResult: BrowserServiceExecResponse;
  try {
    execResult = await browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/browsers/${session.browser_id}/exec`,
      { code, language, timeout, origin },
    );
  } catch (err) {
    logger.error("Failed to execute code via browser service", { error: err });
    return res.status(502).json({
      success: false,
      error: "Failed to execute code in browser session.",
    });
  }

  logger.debug("Execution result", {
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    stdoutLength: execResult.stdout?.length,
    stderrLength: execResult.stderr?.length,
  });

  enqueueBrowserSessionActivity({
    team_id: req.auth.team_id,
    session_id: session.id,
    language,
    timeout,
    exit_code: execResult.exitCode ?? null,
    killed: execResult.killed ?? false,
  });

  const hasError = execResult.exitCode !== 0 || execResult.killed;

  return res.status(200).json({
    success: true,
    stdout: execResult.stdout,
    result: execResult.result,
    stderr: execResult.stderr,
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    ...(hasError ? { error: execResult.stderr || "Execution failed" } : {}),
  });
}

export async function scrapeBrowserDeleteController(
  req: RequestWithAuth<{ jobId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  let logger = _logger.child({
    scrapeId: req.params.jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "scrapeBrowserDeleteController",
  });

  const session = await getBrowserSessionFromScrape(req.params.jobId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  logger = logger.child({
    sessionId: session.id,
    browserId: session.browser_id,
  });

  logger.info("Deleting browser session");

  // Release the browser session via the browser service
  let sessionDurationMs: number | undefined;
  try {
    const deleteResult =
      await browserServiceRequest<BrowserServiceDeleteResponse>(
        "DELETE",
        `/browsers/${session.browser_id}`,
      );
    sessionDurationMs = deleteResult?.sessionDurationMs;
  } catch (err) {
    logger.warn("Failed to delete browser session via browser service", {
      error: err,
    });
  }

  const claimed = await claimBrowserSessionDestroyed(session.id);

  // Invalidate cached count so next check reflects the destroyed session
  invalidateActiveBrowserSessionCount(session.team_id).catch(() => {});

  if (!claimed) {
    // The webhook (or another DELETE call) already transitioned and billed.
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
    });
    return res.status(200).json({
      success: true,
    });
  }

  const durationMs =
    sessionDurationMs ?? Date.now() - new Date(session.created_at).getTime();
  const creditsBilled = calculateBrowserSessionCredits(durationMs);

  updateBrowserSessionCreditsUsed(session.id, creditsBilled).catch(error => {
    logger.error("Failed to update credits_used on browser session", {
      error,
      sessionId: session.id,
      creditsBilled,
    });
  });

  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    creditsBilled,
    req.acuc?.api_key_id ?? null,
    { endpoint: "browser", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for browser session", {
      error,
      creditsBilled,
      durationMs,
    });
  });

  logger.info("Browser session destroyed", {
    sessionDurationMs: durationMs,
    creditsBilled,
  });

  return res.status(200).json({
    success: true,
  });
}
