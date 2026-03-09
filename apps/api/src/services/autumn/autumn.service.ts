import { logger } from "../../lib/logger";
import { getACUCTeam } from "../../controllers/auth";
import { RateLimiterMode } from "../../types";
import { supabase_rr_service } from "../supabase";
import { autumnClient } from "./client";
import type {
  CreateEntityParams,
  EnsureOrgProvisionedParams,
  EnsureTeamProvisionedParams,
  GetEntityParams,
  GetOrCreateCustomerParams,
  TrackCreditsParams,
  TrackParams,
} from "./types";

const CREDITS_FEATURE_ID = "CREDITS";

const AUTUMN_DEFAULT_PLAN_ID = "free";
const AUTUMN_PROVISIONING_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * Wraps Autumn customer/entity provisioning and usage tracking for team credit billing.
 */
class AutumnService {
  private customerOrgCache = new Map<string, string>();
  private ensuredOrgs = new Set<string>();
  private ensuredTeams = new Set<string>();
  private backfillRunning = false;
  /** Serialises concurrent backfills per team (see backfillUsageIfNeeded). */
  private backfillQueue = new Map<string, Promise<void>>();

  private isPreviewTeam(teamId: string): boolean {
    return teamId === "preview" || teamId.startsWith("preview_");
  }

  private async lookupOrgIdForTeam(teamId: string): Promise<string> {
    const { data, error } = await supabase_rr_service
      .from("teams")
      .select("org_id")
      .eq("id", teamId)
      .single();

    if (error) throw error;
    if (!data?.org_id) {
      throw new Error(`Missing org_id for team ${teamId}`);
    }

    return data.org_id;
  }

  private getErrorStatus(error: unknown): number | undefined {
    const status = (error as any)?.statusCode ?? (error as any)?.status;
    if (typeof status === "number") return status;
    const responseStatus = (error as any)?.response?.status;
    return typeof responseStatus === "number" ? responseStatus : undefined;
  }

  private async getOrCreateCustomer({
    customerId,
    name,
    email,
    autoEnablePlanId = AUTUMN_DEFAULT_PLAN_ID,
  }: GetOrCreateCustomerParams): Promise<unknown | null> {
    if (!autumnClient) return null;
    if (!customerId) return null;

    try {
      const customer = await autumnClient.customers.getOrCreate({
        customerId,
        name: name ?? undefined,
        email: email ?? undefined,
        autoEnablePlanId,
      });
      logger.info("Autumn getOrCreateCustomer succeeded", { customerId });
      return customer;
    } catch (error) {
      logger.warn("Autumn getOrCreateCustomer failed", { customerId, error });
      return null;
    }
  }

  private async getEntity({
    customerId,
    entityId,
  }: GetEntityParams): Promise<unknown | null> {
    if (!autumnClient) return null;

    try {
      return await autumnClient.entities.get({ customerId, entityId });
    } catch (error) {
      const status = this.getErrorStatus(error);
      if (status === 404) {
        return null;
      }
      logger.warn("Autumn getEntity failed", { customerId, entityId, error });
      return null;
    }
  }

  private async createEntity({
    customerId,
    entityId,
    featureId,
    name,
  }: CreateEntityParams): Promise<unknown | null> {
    if (!autumnClient) return null;

    try {
      const entity = await autumnClient.entities.create({
        customerId,
        entityId,
        featureId,
        name: name ?? undefined,
      });
      logger.info("Autumn createEntity succeeded", {
        customerId,
        entityId,
        featureId,
      });
      return entity;
    } catch (error) {
      const status = this.getErrorStatus(error);
      if (status === 409) {
        return null;
      }
      logger.warn("Autumn createEntity failed", {
        customerId,
        entityId,
        featureId,
        error,
      });
      return null;
    }
  }

  private async track({
    customerId,
    entityId,
    featureId,
    value,
    properties,
  }: TrackParams): Promise<void> {
    if (!autumnClient) return;

    try {
      await autumnClient.track({
        customerId,
        entityId,
        featureId,
        value,
        properties,
      });
      logger.info("Autumn track succeeded", {
        customerId,
        entityId,
        featureId,
        value,
      });
    } catch (error) {
      logger.warn("Autumn track failed", {
        customerId,
        entityId,
        featureId,
        value,
        error,
      });
    }
  }

  private getFeatureUsage(entity: unknown, featureId: string): number {
    const usage = (entity as any)?.balances?.[featureId]?.usage;
    return typeof usage === "number" ? usage : 0;
  }

  /**
   * Ensures the Autumn customer exists for an org, caching successful lookups in-process.
   */
  async ensureOrgProvisioned({
    orgId,
    name,
    email,
  }: EnsureOrgProvisionedParams): Promise<void> {
    if (this.ensuredOrgs.has(orgId)) return;
    const customer = await this.getOrCreateCustomer({
      customerId: orgId,
      name,
      email,
    });
    if (customer) {
      this.ensuredOrgs.add(orgId);
    }
  }

  /**
   * Ensures the Autumn entity exists for a team under its org customer.
   */
  async ensureTeamProvisioned({
    teamId,
    orgId,
    name,
  }: EnsureTeamProvisionedParams): Promise<void> {
    if (this.isPreviewTeam(teamId)) return;

    const resolvedOrgId = orgId ?? await this.lookupOrgIdForTeam(teamId);
    this.customerOrgCache.set(teamId, resolvedOrgId);
    await this.ensureOrgProvisioned({ orgId: resolvedOrgId });

    if (this.ensuredTeams.has(teamId)) return;
    const entity = await this.getEntity({
      customerId: resolvedOrgId,
      entityId: teamId,
    });

    if (!entity) {
      await this.createEntity({
        customerId: resolvedOrgId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        name,
      });
      const createdEntity = await this.getEntity({
        customerId: resolvedOrgId,
        entityId: teamId,
      });
      if (!createdEntity) {
        return;
      }
    }
    this.ensuredTeams.add(teamId);
  }

  /**
   * Resolves and warms the Autumn customer/entity context needed before tracking usage.
   */
  private async ensureTrackingContext(teamId: string): Promise<string> {
    const cached = this.customerOrgCache.get(teamId);
    if (cached) {
      await this.ensureTeamProvisioned({ teamId, orgId: cached });
      return cached;
    }

    const orgId = await this.lookupOrgIdForTeam(teamId);
    await this.ensureTeamProvisioned({ teamId, orgId });
    return orgId;
  }

  /**
   * Temporary migration shim.
   *
   * Backfills missing Autumn usage from Firecrawl by tracking only the delta
   * between Firecrawl's combined (scrape + extract) current-period usage and
   * Autumn's recorded usage.
   *
   * `currentValue` is the number of credits about to be tracked for the
   * current event.  It is subtracted from the Firecrawl total before computing
   * the delta so that the event is not counted twice (once in the backfill and
   * once by the explicit track() call that follows).
   *
   * Calls are serialised per team so that two concurrent invocations never
   * both read a stale autumnUsage of 0 and each replay the full historical
   * delta (double-counting prior usage in Autumn).
   *
   * Remove this once the Autumn migration is complete.
   */
  private backfillUsageIfNeeded(
    teamId: string,
    customerId: string,
    currentValue: number,
  ): Promise<void> {
    const prev = this.backfillQueue.get(teamId) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // don't stall the queue on errors from the previous call
      .then(() => this._backfillUsageIfNeeded(teamId, customerId, currentValue));
    this.backfillQueue.set(teamId, next);
    next.finally(() => {
      if (this.backfillQueue.get(teamId) === next) {
        this.backfillQueue.delete(teamId);
      }
    });
    return next;
  }

  private async _backfillUsageIfNeeded(
    teamId: string,
    customerId: string,
    currentValue: number,
  ): Promise<void> {
    // Fetch both modes in parallel so the combined Firecrawl total is
    // comparable to Autumn's single shared TEAM_CREDITS counter.
    const [scrapeChunk, extractChunk] = await Promise.all([
      getACUCTeam(teamId, false, true, RateLimiterMode.Scrape),
      getACUCTeam(teamId, false, true, RateLimiterMode.Extract),
    ]);
    const firecrawlTotal =
      (scrapeChunk?.adjusted_credits_used ?? 0) +
      (extractChunk?.adjusted_credits_used ?? 0);

    // Exclude the current event's credits from the backfill: they will be
    // tracked separately by the track() call in trackCredits().
    const firecrawlHistorical = firecrawlTotal - currentValue;
    if (firecrawlHistorical <= 0) return;

    const entity = await this.getEntity({
      customerId,
      entityId: teamId,
    });
    const autumnUsage = this.getFeatureUsage(entity, CREDITS_FEATURE_ID);
    const delta = firecrawlHistorical - autumnUsage;
    if (delta <= 0) return;

    // Use whichever chunk has period metadata; prefer scrape as the default.
    const periodChunk = scrapeChunk ?? extractChunk;
    await this.track({
      customerId,
      entityId: teamId,
      featureId: CREDITS_FEATURE_ID,
      value: delta,
      properties: {
        source: "autumn_backfill",
        firecrawlBackfill: true,
        periodStart: periodChunk?.sub_current_period_start ?? null,
        periodEnd: periodChunk?.sub_current_period_end ?? null,
      },
    });
  }

  /**
   * Tracks billed credits against the team's Autumn entity.
   */
  async trackCredits({
    teamId,
    value,
    properties,
  }: TrackCreditsParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      await this.backfillUsageIfNeeded(teamId, customerId, value);
      await this.track({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value,
        properties,
      });
    } catch (error) {
      logger.warn("Autumn trackCredits failed", {
        teamId,
        value,
        error,
      });
    }
  }

  /**
   * Replays recent org/team provisioning to repair missed webhook events.
   */
  async backfillRecentProvisioning(
    lookbackMs = AUTUMN_PROVISIONING_LOOKBACK_MS,
  ): Promise<void> {
    if (!autumnClient || this.backfillRunning) return;

    this.backfillRunning = true;
    try {
      const createdAfter = new Date(Date.now() - lookbackMs).toISOString();
      const [orgsResult, teamsResult] = await Promise.all([
        supabase_rr_service
          .from("organizations")
          .select("id,name")
          .gte("created_at", createdAfter),
        supabase_rr_service
          .from("teams")
          .select("id,org_id,name")
          .gte("created_at", createdAfter),
      ]);

      if (orgsResult.error) throw orgsResult.error;
      if (teamsResult.error) throw teamsResult.error;

      await Promise.all(
        (orgsResult.data ?? []).map(org =>
          this.ensureOrgProvisioned({ orgId: org.id, name: org.name }),
        ),
      );
      await Promise.all(
        (teamsResult.data ?? []).map(team =>
          this.ensureTeamProvisioned({
            teamId: team.id,
            orgId: team.org_id,
            name: team.name,
          }),
        ),
      );
    } catch (error) {
      logger.warn("Autumn provisioning backfill failed", { error });
    } finally {
      this.backfillRunning = false;
    }
  }
}

export const autumnService = new AutumnService();
