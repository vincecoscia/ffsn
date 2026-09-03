/**
 * Repairs `leagueSeasons.champion`/`runnerUp`/`regularSeasonChampion` from the bracket itself
 * (`convex/lib/playoffs.ts#deriveSeasonResults`) whenever the stored value disagrees with it, or is
 * unmistakably a sync artifact (`isCorruptedSeasonResult`: a 0-0 record, or owner "Unknown").
 *
 * Spec (owner ask, Sept 2026 - "can we check prod and see who the champion was?"): prod league
 * jn74dn16bts1gg94596srgsvh17nevtq's 2025 season stored champion "joey's Scary Team" - a 0-0
 * record, owner "Unknown" - evidently a rolled-over 2026 payload (`convex/espnSync.ts`
 * ~L1141-1230's `rankCalculatedFinal`/playoff-seed/win% fallback chain, run against the WRONG
 * season's teams). The bracket - `matchups` rows and their `winner` - is ground truth and cannot be
 * corrupted the same way; 2020-2024 in prod were already correct and this leaves them untouched.
 *
 * Dry run first, then drop `dryRun` (or set it `false`) to actually write:
 *   npx convex run --prod seasonResults:repairSeasonResults '{"leagueId":"jn74dn16bts1gg94596srgsvh17nevtq","seasonId":2025,"dryRun":true}'
 * Omit `seasonId` to check/repair every season of the league in one call.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deriveSeasonResults, isCorruptedSeasonResult } from "./lib/playoffs";
import { parseEspnLeagueSettings } from "./lib/espnSettings";

type DbCtx = QueryCtx | MutationCtx;

/** The `leagueSeasons.champion`/`runnerUp`/`regularSeasonChampion` shape (schema.ts). */
const storedSeasonResultValidator = v.object({
  teamId: v.string(),
  teamName: v.string(),
  owner: v.string(),
  record: v.object({ wins: v.number(), losses: v.number(), ties: v.number() }),
  pointsFor: v.optional(v.number()),
});
type StoredSeasonResult = {
  teamId: string;
  teamName: string;
  owner: string;
  record: { wins: number; losses: number; ties: number };
  pointsFor?: number;
};

const repairEntryValidator = v.object({
  seasonId: v.number(),
  before: v.object({
    champion: v.optional(storedSeasonResultValidator),
    runnerUp: v.optional(storedSeasonResultValidator),
    regularSeasonChampion: v.optional(storedSeasonResultValidator),
  }),
  after: v.object({
    champion: storedSeasonResultValidator,
    runnerUp: v.optional(storedSeasonResultValidator),
    regularSeasonChampion: v.optional(storedSeasonResultValidator),
  }),
});
type RepairEntry = {
  seasonId: number;
  before: {
    champion?: StoredSeasonResult;
    runnerUp?: StoredSeasonResult;
    regularSeasonChampion?: StoredSeasonResult;
  };
  after: {
    champion: StoredSeasonResult;
    runnerUp?: StoredSeasonResult;
    regularSeasonChampion?: StoredSeasonResult;
  };
};

/** A bracket-derived `BracketTeam` (record `"10-4-0"`) into the stored shape (record as an object). */
function toStoredResult(
  bracketTeam: { teamId: string; name: string; record: string; pointsFor: number },
  owner: string
): StoredSeasonResult {
  const [wins, losses, ties] = bracketTeam.record.split("-").map(Number);
  return {
    teamId: bracketTeam.teamId,
    teamName: bracketTeam.name,
    owner,
    record: { wins: wins || 0, losses: losses || 0, ties: ties || 0 },
    pointsFor: bracketTeam.pointsFor,
  };
}

/** Same team, same wins/losses/ties - the only two things that matter to "is this the same result". */
function sameResult(a: StoredSeasonResult | undefined, b: StoredSeasonResult | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.teamId === b.teamId &&
    a.record.wins === b.record.wins &&
    a.record.losses === b.record.losses &&
    a.record.ties === b.record.ties
  );
}

/**
 * What `repairSeasonResults` would do for one `leagueSeasons` row - `null` when there's nothing to
 * derive (no decided winners-bracket game yet: the season hasn't reached or finished its playoffs)
 * or nothing to fix (the derived result already matches what's stored, and what's stored isn't
 * obviously corrupted). Shared by the mutation and the read-only preview query below so the two can
 * never disagree about what counts as a repair.
 */
async function computeRepairForSeason(
  ctx: DbCtx,
  leagueId: Id<"leagues">,
  season: Doc<"leagueSeasons">
): Promise<RepairEntry | null> {
  const [teams, matchups] = await Promise.all([
    ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", season.seasonId))
      .collect(),
    ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", season.seasonId))
      .collect(),
  ]);

  const winnersBracketGames = matchups.filter((m) => m.playoffTier === "WINNERS_BRACKET");
  if (winnersBracketGames.length === 0) return null; // no playoff bracket synced for this season yet

  const parsed = parseEspnLeagueSettings(season.settings);
  const derived = deriveSeasonResults({
    teams: teams.map((t) => ({
      externalId: t.externalId,
      name: t.name,
      record: {
        wins: t.record.wins,
        losses: t.record.losses,
        ties: t.record.ties,
        pointsFor: t.record.pointsFor,
        playoffSeed: t.record.playoffSeed,
      },
    })),
    matchups: winnersBracketGames.map((g) => ({
      matchupPeriod: g.matchupPeriod,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      winner: g.winner,
      playoffTier: g.playoffTier,
    })),
    format: {
      playoffTeamCount: parsed.playoffTeamCount,
      regularSeasonMatchupPeriods: parsed.regularSeasonMatchupPeriods,
      playoffMatchupPeriodLength: parsed.playoffMatchupPeriodLength,
      playoffSeedingRule: parsed.playoffSeedingRule,
    },
    throughWeek: Math.max(...winnersBracketGames.map((g) => g.matchupPeriod)),
  });
  if (!derived.champion) return null; // championship game not decided yet - nothing to derive

  const ownerFor = (teamId: string) => teams.find((t) => t.externalId === teamId)?.owner ?? "Unknown";
  const champion = toStoredResult(derived.champion, ownerFor(derived.champion.teamId));
  const runnerUp = derived.runnerUp ? toStoredResult(derived.runnerUp, ownerFor(derived.runnerUp.teamId)) : undefined;
  const regularSeasonChampion = derived.regularSeasonChampion
    ? toStoredResult(derived.regularSeasonChampion, ownerFor(derived.regularSeasonChampion.teamId))
    : undefined;

  const storedChampion = season.champion as StoredSeasonResult | undefined;
  const disagrees = !sameResult(storedChampion, champion);
  const corrupted = isCorruptedSeasonResult(storedChampion);
  if (!disagrees && !corrupted) return null; // already correct

  return {
    seasonId: season.seasonId,
    before: { champion: season.champion, runnerUp: season.runnerUp, regularSeasonChampion: season.regularSeasonChampion },
    after: { champion, runnerUp, regularSeasonChampion },
  };
}

/** The season row(s) a call should check: one specific season, or every season of the league. */
async function seasonsToCheck(
  ctx: DbCtx,
  leagueId: Id<"leagues">,
  seasonId: number | undefined
): Promise<Doc<"leagueSeasons">[]> {
  if (seasonId !== undefined) {
    const row = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .first();
    return row ? [row] : [];
  }
  return ctx.db
    .query("leagueSeasons")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .collect();
}

/**
 * Read-only preview of exactly what `repairSeasonResults` would change, with no `dryRun` mutation
 * call needed - useful for checking prod before deciding to run the mutation at all.
 */
export const previewSeasonResults = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  returns: v.object({ checked: v.number(), repaired: v.array(repairEntryValidator) }),
  handler: async (ctx, args) => {
    const seasons = await seasonsToCheck(ctx, args.leagueId, args.seasonId);
    const repaired: RepairEntry[] = [];
    for (const season of seasons) {
      const repair = await computeRepairForSeason(ctx, args.leagueId, season);
      if (repair) repaired.push(repair);
    }
    return { checked: seasons.length, repaired };
  },
});

/**
 * Patches `champion`/`runnerUp`/`regularSeasonChampion` on the season(s) whose bracket-derived
 * result disagrees with what's stored (see `computeRepairForSeason`). `dryRun: true` computes and
 * returns the same `{checked, repaired}` shape without writing anything - run that first.
 */
export const repairSeasonResults = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({ checked: v.number(), repaired: v.array(repairEntryValidator) }),
  handler: async (ctx, args) => {
    const seasons = await seasonsToCheck(ctx, args.leagueId, args.seasonId);
    const repaired: RepairEntry[] = [];
    for (const season of seasons) {
      const repair = await computeRepairForSeason(ctx, args.leagueId, season);
      if (!repair) continue;
      repaired.push(repair);
      if (!args.dryRun) {
        await ctx.db.patch(season._id, {
          champion: repair.after.champion,
          runnerUp: repair.after.runnerUp,
          regularSeasonChampion: repair.after.regularSeasonChampion,
        });
      }
    }
    return { checked: seasons.length, repaired };
  },
});
