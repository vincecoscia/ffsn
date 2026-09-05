// @vitest-environment node
/**
 * Interview CONTEXT harness: replays real league data through the production
 * `commentRequests.buildConversationContext` query and checks every field Sam Ortega is
 * allowed to state against an independent oracle computed straight from the raw rows.
 *
 * It is a harness, not a unit test: it only runs when pointed at an export directory.
 *
 *   INTERVIEW_HARNESS_DATA=<dir of <table>.jsonl exports> \
 *   INTERVIEW_HARNESS_LEAGUE=<league _id in that export> \
 *   INTERVIEW_HARNESS_OUT=<contexts.json to write> \
 *   npx vitest run tests/interviewContextHarness.test.ts
 *
 * Exports come from `npx convex data <table> --format jsonl --limit N` (read-only). Every
 * document is re-inserted into an in-memory convex-test database with its ids remapped, so
 * nothing here touches a deployment. The output file feeds `scripts/interview-harness.ts`,
 * which runs the live model half (opener, simulated reply, follow-up, close).
 *
 * Findings (code / severity) are attached per scenario:
 *   result_mismatch      block  score, opponent, margin or win/loss differ from the matchup row
 *   season_fallback      block  a week with no scores yet was answered with another season's game
 *   ir_as_starter        block  a slot-21 (IR) player counted as a starter / under- or over-performer
 *   ir_in_bench          warn   IR points counted as bench points
 *   record_not_as_of_week warn  standing/record is the final (or last-synced) record, not week N's
 *   rank_mismatch        warn   rank differs from wins-then-points ordering as of week N
 *   week_zero            block  the fact block would say "Week 0"/"Week undefined"
 *   unknown_identity     block  "Unknown Team" / "Unknown manager" for a claimed team
 *   transactions_mismatch warn  adds/drops/bids differ from the transactions table
 *   draft_picks_missing  block  draft_rankings with no picks for a team that drafted
 *   draft_picks_wrong_team block a pick attributed to another team
 *   trade_mismatch       warn   trades differ from the trades table
 *   rivalry_mismatch     warn   all-time record differs from the rivalries table
 *   prior_quote_label    block  a "prior quote" is a topic label, not something the manager said
 *   prior_quote_other_season warn a prior quote from another season
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildInterviewFactBlock, type ConversationContext } from "../src/lib/ai/conversation-service";

const modules = import.meta.glob("../convex/**/*.*s");

const DATA_DIR = process.env.INTERVIEW_HARNESS_DATA;
const LEAGUE = process.env.INTERVIEW_HARNESS_LEAGUE;
const OUT = process.env.INTERVIEW_HARNESS_OUT;
const PLAYED_SEASON = Number(process.env.INTERVIEW_HARNESS_SEASON ?? 2025);
const NEXT_SEASON = PLAYED_SEASON + 1;
/** Limit the weekly scenarios per content type (e.g. for a quick smoke run). */
const WEEK_LIMIT = Number(process.env.INTERVIEW_HARNESS_WEEKS ?? 17);

const BENCH = 20;
const IR = 21;

type Row = Record<string, any>;

interface Finding {
  code: string;
  severity: "block" | "warn" | "info";
  detail: string;
}

interface Scenario {
  id: string;
  label: string;
  contentType: string;
  seasonId: number | undefined;
  week: number | undefined;
  teamExternalId: string;
  teamName: string;
  owner: string;
}

/* -------------------------------------------------------------------------- */
/* Export loading + id remapping                                               */
/* -------------------------------------------------------------------------- */

function loadTable(name: string): Row[] {
  if (!DATA_DIR) return [];
  const file = path.join(DATA_DIR, `${name}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);
}

/** Insert order: every table before the tables that reference it. */
const TABLE_ORDER = [
  "leagues",
  "users",
  "nflSeasons",
  "teams",
  "teamClaims",
  "leagueSeasons",
  "matchups",
  "transactions",
  "trades",
  "rivalries",
  "playersEnhanced",
  "aiContent",
  "contentSchedules",
  "scheduledContent",
  "commentRequests",
  "commentResponses",
  "writerRelationships",
  "relationshipEvents",
] as const;

/** Fields that are optional ids in the schema and may point at rows we did not import. */
const DROPPABLE_REFS: Record<string, string[]> = {
  relationshipEvents: ["articleId", "commentRequestId"],
  commentResponses: ["manualContentId"],
  commentRequests: ["scheduledContentId", "manualContentId"],
  scheduledContent: ["contentScheduleId", "generatedContentId", "aiContentId"],
  aiContent: ["bannerImageId"],
  teamClaims: ["rolledOverFromClaimId"],
};

/* -------------------------------------------------------------------------- */
/* Oracle: computed from the raw export, independently of the Convex code      */
/* -------------------------------------------------------------------------- */

interface Oracle {
  matchup?: {
    score: number;
    opponentScore: number;
    opponentExternalId: string;
    opponentName?: string;
    won: boolean;
    tie: boolean;
    margin: number;
    benchPoints: number;
    irPlayers: string[];
    starters: string[];
    benchPlayers: string[];
  };
  record: { wins: number; losses: number; ties: number; pointsFor: number };
  rank: number;
  finalRecord: { wins: number; losses: number; ties: number };
  transactions: Array<{ type: string; added: string[]; dropped: string[]; bid: number }>;
  draftPickCount: number;
  trades: Array<{ withTeam: string; gave: string[]; received: string[] }>;
  rivalry?: string;
  priorResponses: Array<{ week?: number; seasonId?: number; raw: string; quotes: string[] }>;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

describe.skipIf(!DATA_DIR || !LEAGUE)("interview context harness (real data replay)", () => {
  it("builds every scenario's context and checks it against the oracle", async () => {
    const dataDir = DATA_DIR!;
    const leagueOldId = LEAGUE!;

    const raw: Record<string, Row[]> = {};
    for (const table of TABLE_ORDER) raw[table] = loadTable(table);

    const leagueRow = raw.leagues.find((r) => r._id === leagueOldId);
    expect(leagueRow, `league ${leagueOldId} not found in ${dataDir}/leagues.jsonl`).toBeTruthy();

    // Keep only this league's rows (plus the tables that have no leagueId).
    const scoped: Record<string, Row[]> = {};
    for (const table of TABLE_ORDER) {
      scoped[table] = raw[table].filter((r) => {
        if (table === "leagues") return r._id === leagueOldId;
        if (table === "playersEnhanced") return r.season >= PLAYED_SEASON;
        if (table === "users" || table === "nflSeasons") return true;
        return r.leagueId === leagueOldId;
      });
    }
    // Users: only the ones that claimed a team in this league; strip email.
    const claimClerkIds = new Set(scoped.teamClaims.map((c) => c.userId));
    scoped.users = scoped.users
      .filter((u) => claimClerkIds.has(u.clerkId))
      .map((u) => {
        const copy = { ...u };
        delete copy.email;
        return copy;
      });

    const oldIds = new Set<string>();
    for (const table of TABLE_ORDER) for (const r of scoped[table]) oldIds.add(r._id);

    const t = convexTest(schema, modules);
    const idMap = new Map<string, string>();
    const insertStats: Record<string, { ok: number; failed: number; firstError?: string }> = {};

    const remap = (value: unknown, table: string, topLevelKey?: string): unknown => {
      if (typeof value === "string") {
        if (idMap.has(value)) return idMap.get(value);
        if (oldIds.has(value)) {
          // Forward reference to a row that is not (yet) inserted.
          return undefined;
        }
        return value;
      }
      if (Array.isArray(value)) return value.map((v) => remap(v, table)).filter((v) => v !== undefined);
      if (value && typeof value === "object") {
        const out: Row = {};
        for (const [k, v] of Object.entries(value as Row)) {
          const mapped = remap(v, table, topLevelKey ?? k);
          if (mapped !== undefined) out[k] = mapped;
        }
        return out;
      }
      return value;
    };

    await t.run(async (ctx) => {
      for (const table of TABLE_ORDER) {
        insertStats[table] = { ok: 0, failed: 0 };
        for (const row of scoped[table]) {
          const { _id, _creationTime, ...doc } = row;
          void _creationTime;
          const mapped = remap(doc, table) as Row;
          for (const key of DROPPABLE_REFS[table] ?? []) {
            if (key in doc && !(key in mapped)) delete mapped[key];
          }
          // A reference to something outside the export (a storage id, a deleted article)
          // is dropped and the insert retried, so one dangling optional field never costs
          // the whole row.
          let attempt = 0;
          for (;;) {
            try {
              const newId = await ctx.db.insert(table as any, mapped as any);
              idMap.set(_id, newId as string);
              insertStats[table].ok++;
              break;
            } catch (error) {
              const message = String((error as Error).message);
              const dangling = /Expected ID for table "[^"]+", got `([^`]+)`/.exec(message)?.[1];
              const key = dangling ? Object.keys(mapped).find((k) => mapped[k] === dangling) : undefined;
              if (key && attempt < 5) {
                delete mapped[key];
                attempt++;
                continue;
              }
              insertStats[table].failed++;
              insertStats[table].firstError ??= message.slice(0, 300);
              break;
            }
          }
        }
      }
    });

    console.log("insert stats", JSON.stringify(insertStats, null, 1));

    // Every team of the played season and the next one must be claimed so the builder can
    // resolve a manager. Real claims are kept; unclaimed teams get a synthetic manager.
    const leagueId = idMap.get(leagueOldId) as Id<"leagues">;
    expect(leagueId, "league row failed to insert").toBeTruthy();
    const teamsBySeason = new Map<number, Row[]>();
    for (const team of scoped.teams) {
      if (!teamsBySeason.has(team.seasonId)) teamsBySeason.set(team.seasonId, []);
      teamsBySeason.get(team.seasonId)!.push(team);
    }
    const userIdByTeamOldId = new Map<string, Id<"users">>();
    await t.run(async (ctx) => {
      const claims = await ctx.db
        .query("teamClaims")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect();
      const claimedTeams = new Map(claims.map((c) => [c.teamId as string, c.userId]));
      const users = await ctx.db.query("users").collect();
      const userByClerk = new Map(users.map((u) => [u.clerkId, u._id]));

      for (const season of [PLAYED_SEASON, NEXT_SEASON]) {
        for (const team of teamsBySeason.get(season) ?? []) {
          const newTeamId = idMap.get(team._id);
          if (!newTeamId) continue; // the row failed validation; reported in insertStats
          const clerkId = claimedTeams.get(newTeamId);
          if (clerkId && userByClerk.has(clerkId)) {
            userIdByTeamOldId.set(team._id, userByClerk.get(clerkId)!);
            continue;
          }
          const syntheticClerk = `harness_${team.externalId}`;
          let userId = userByClerk.get(syntheticClerk);
          if (!userId) {
            userId = await ctx.db.insert("users", {
              clerkId: syntheticClerk,
              name: team.owner,
              hasCompletedOnboarding: true,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
            });
            userByClerk.set(syntheticClerk, userId);
          }
          await ctx.db.insert("teamClaims", {
            leagueId,
            teamId: newTeamId as Id<"teams">,
            seasonId: season,
            userId: syntheticClerk,
            status: "active",
            credits: 0,
            createdAt: Date.now(),
          });
          userIdByTeamOldId.set(team._id, userId);
        }
      }
    });

    /* ------------------------------------------------------------------ */
    /* Scenarios                                                           */
    /* ------------------------------------------------------------------ */

    const playedTeams = (teamsBySeason.get(PLAYED_SEASON) ?? []).sort(
      (a, b) => Number(a.externalId) - Number(b.externalId)
    );
    const nextTeams = (teamsBySeason.get(NEXT_SEASON) ?? []).sort(
      (a, b) => Number(a.externalId) - Number(b.externalId)
    );
    const maxPeriod = Math.max(
      0,
      ...scoped.matchups.filter((m) => m.seasonId === PLAYED_SEASON).map((m) => m.matchupPeriod)
    );
    const weeks = Array.from({ length: Math.min(maxPeriod, WEEK_LIMIT) }, (_, i) => i + 1);
    const regularSeasonWeeks =
      leagueRow!.settings?.regularSeasonMatchupPeriods ?? Math.min(14, maxPeriod);

    const scenarios: Scenario[] = [];
    const push = (
      contentType: string,
      seasonId: number | undefined,
      week: number | undefined,
      team: Row,
      labelSuffix = ""
    ) => {
      scenarios.push({
        id: `${contentType}:${seasonId ?? "none"}:${week ?? "none"}:${team.externalId}`,
        label: `${contentType} · ${seasonId ?? "no season"} wk ${week ?? "-"} · ${team.name}${labelSuffix}`,
        contentType,
        seasonId,
        week,
        teamExternalId: String(team.externalId),
        teamName: team.name,
        owner: team.owner,
      });
    };

    for (const team of playedTeams) {
      for (const week of weeks) push("weekly_recap", PLAYED_SEASON, week, team);
      for (const week of weeks.filter((w) => w >= 2 && w <= regularSeasonWeeks && w % 3 === 2)) {
        push("waiver_wire_report", PLAYED_SEASON, week, team);
      }
      for (const week of [4, 9, Math.min(14, maxPeriod)].filter((w) => weeks.includes(w))) {
        push("power_rankings", PLAYED_SEASON, week, team);
      }
      if (weeks.includes(6)) push("rivalry_week_special", PLAYED_SEASON, 6, team);
      if (weeks.includes(9)) push("mid_season_awards", PLAYED_SEASON, 9, team);
      if (weeks.includes(8)) push("hall_of_shame", PLAYED_SEASON, 8, team);
      if (weeks.includes(2)) push("weekly_preview", PLAYED_SEASON, 3, team, " (preview of a played week)");
      push("draft_rankings", PLAYED_SEASON, undefined, team);
      push("season_recap", PLAYED_SEASON, maxPeriod, team);
      // The "Week 0" trap: a request with no week at all.
      push("weekly_recap", PLAYED_SEASON, undefined, team, " (no week on the request)");
    }
    // Next season, nothing played yet: previews and a recap for a week with no scores.
    for (const team of nextTeams) {
      push("weekly_preview", NEXT_SEASON, 1, team);
      push("weekly_recap", NEXT_SEASON, 1, team, " (unplayed week)");
      push("mock_draft", NEXT_SEASON, undefined, team);
      push("power_rankings", NEXT_SEASON, 1, team);
    }
    // Trades: both sides, as trade_analysis.
    for (const trade of scoped.trades.filter((tr) => tr.status === "accepted" || tr.status === "completed")) {
      for (const side of [trade.teamA, trade.teamB]) {
        const team = (teamsBySeason.get(trade.seasonId) ?? []).find(
          (tm) => String(tm.externalId) === String(side.teamId)
        );
        if (team) push("trade_analysis", trade.seasonId, trade.week, team, " (trade side)");
      }
    }

    /* ------------------------------------------------------------------ */
    /* Oracle helpers                                                      */
    /* ------------------------------------------------------------------ */

    const teamName = (seasonId: number, externalId: string) =>
      (teamsBySeason.get(seasonId) ?? []).find((tm) => String(tm.externalId) === externalId)?.name;

    const playerName = new Map<string, string>();
    for (const p of scoped.playersEnhanced) playerName.set(`${p.espnId}:${p.season}`, p.fullName);

    const oracleFor = (s: Scenario, targetUserOldRowId: string | undefined): Oracle => {
      const season = s.seasonId ?? PLAYED_SEASON;
      const week = s.week ?? 0;
      const ext = s.teamExternalId;
      const seasonMatchups = scoped.matchups.filter((m) => m.seasonId === season);

      let matchup: Oracle["matchup"];
      const row = seasonMatchups.find(
        (m) => m.matchupPeriod === week && (String(m.homeTeamId) === ext || String(m.awayTeamId) === ext)
      );
      if (row) {
        const isHome = String(row.homeTeamId) === ext;
        const score = isHome ? row.homeScore : row.awayScore;
        const opponentScore = isHome ? row.awayScore : row.homeScore;
        const roster = isHome ? row.homeRoster : row.awayRoster;
        const players: Row[] = roster?.players ?? [];
        const won = row.winner ? row.winner === (isHome ? "home" : "away") : score > opponentScore;
        const opponentExternalId = String(isHome ? row.awayTeamId : row.homeTeamId);
        matchup = {
          score,
          opponentScore,
          opponentExternalId,
          opponentName: teamName(season, opponentExternalId),
          won,
          tie: row.winner === "tie" || (score === opponentScore && score > 0),
          margin: round1(Math.abs(score - opponentScore)),
          benchPoints: round1(players.filter((p) => p.lineupSlotId === BENCH).reduce((sum, p) => sum + (p.points || 0), 0)),
          irPlayers: players.filter((p) => p.lineupSlotId === IR).map((p) => p.fullName),
          starters: players.filter((p) => p.lineupSlotId !== BENCH && p.lineupSlotId !== IR).map((p) => p.fullName),
          benchPlayers: players.filter((p) => p.lineupSlotId === BENCH).map((p) => p.fullName),
        };
      }

      // Record through this week (regular season only), from matchups with a decided winner.
      const throughWeek = Math.min(week, regularSeasonWeeks);
      const table = new Map<string, { wins: number; losses: number; ties: number; pointsFor: number }>();
      for (const tm of teamsBySeason.get(season) ?? []) {
        table.set(String(tm.externalId), { wins: 0, losses: 0, ties: 0, pointsFor: 0 });
      }
      for (const m of seasonMatchups) {
        if (m.matchupPeriod > throughWeek) continue;
        if (!m.winner && !(m.homeScore > 0 || m.awayScore > 0)) continue;
        const home = table.get(String(m.homeTeamId));
        const away = table.get(String(m.awayTeamId));
        if (!home || !away) continue;
        home.pointsFor += m.homeScore;
        away.pointsFor += m.awayScore;
        const winner = m.winner ?? (m.homeScore > m.awayScore ? "home" : m.awayScore > m.homeScore ? "away" : "tie");
        if (winner === "home") { home.wins++; away.losses++; }
        else if (winner === "away") { away.wins++; home.losses++; }
        else { home.ties++; away.ties++; }
      }
      const ordered = [...table.entries()].sort(
        ([, a], [, b]) => b.wins - a.wins || b.pointsFor - a.pointsFor
      );
      const rank = ordered.findIndex(([id]) => id === ext) + 1;
      const record = table.get(ext) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 };
      const finalTeam = (teamsBySeason.get(season) ?? []).find((tm) => String(tm.externalId) === ext);
      const finalRecord = {
        wins: finalTeam?.record?.wins ?? 0,
        losses: finalTeam?.record?.losses ?? 0,
        ties: finalTeam?.record?.ties ?? 0,
      };

      // Moves that actually happened: ESPN status EXECUTED (or the normalized outcome).
      // A lost, withdrawn or still-pending claim is not a pickup.
      const transactions = scoped.transactions
        .filter(
          (tx) =>
            tx.seasonId === season &&
            tx.scoringPeriod === week &&
            String(tx.teamId) === ext &&
            tx.type !== "DRAFT" &&
            tx.type !== "ROSTER" &&
            (tx.outcome ? tx.outcome === "executed" : tx.status === "EXECUTED" && !tx.isPending)
        )
        .map((tx) => ({
          type: tx.type,
          added: tx.items.filter((i: Row) => i.type === "ADD").map((i: Row) => playerName.get(`${i.playerId}:${season}`) ?? `#${i.playerId}`),
          dropped: tx.items.filter((i: Row) => i.type === "DROP").map((i: Row) => playerName.get(`${i.playerId}:${season}`) ?? `#${i.playerId}`),
          bid: tx.bidAmount,
        }))
        .filter((tx) => tx.added.length + tx.dropped.length > 0);

      const draftPickCount = scoped.transactions
        .filter((tx) => tx.seasonId === season && tx.type === "DRAFT")
        .flatMap((tx) => tx.items)
        .filter((i: Row) => String(i.toTeamId) === ext).length;

      // A trade story is about the trade whenever it happened; any other story may only
      // mention a trade from this week or last (the trades table carries the week).
      const tradeStory = /^trade_/.test(s.contentType);
      const trades = scoped.trades
        .filter(
          (tr) =>
            tr.seasonId === season &&
            (tr.status === "accepted" || tr.status === "completed") &&
            (String(tr.teamA.teamId) === ext || String(tr.teamB.teamId) === ext) &&
            (tradeStory || (tr.week !== undefined && week > 0 && tr.week >= week - 1 && tr.week <= week))
        )
        .map((tr) => {
          const isA = String(tr.teamA.teamId) === ext;
          return {
            withTeam: isA ? tr.teamB.teamName : tr.teamA.teamName,
            gave: (isA ? tr.playersFromTeamA : tr.playersFromTeamB).map((p: Row) => p.playerName),
            received: (isA ? tr.playersFromTeamB : tr.playersFromTeamA).map((p: Row) => p.playerName),
          };
        });

      let rivalry: string | undefined;
      if (matchup) {
        const rr = scoped.rivalries.find(
          (r) =>
            (String(r.teamA.teamId) === ext && String(r.teamB.teamId) === matchup!.opponentExternalId) ||
            (String(r.teamB.teamId) === ext && String(r.teamA.teamId) === matchup!.opponentExternalId)
        );
        if (rr) {
          const isA = String(rr.teamA.teamId) === ext;
          const w = isA ? rr.allTimeRecord.teamAWins : rr.allTimeRecord.teamBWins;
          const l = isA ? rr.allTimeRecord.teamBWins : rr.allTimeRecord.teamAWins;
          rivalry = rr.allTimeRecord.ties > 0 ? `${w}-${l}-${rr.allTimeRecord.ties}` : `${w}-${l}`;
        }
      }

      const priorResponses = scoped.commentResponses
        .filter((r) => r.userId === targetUserOldRowId)
        .map((r) => {
          const req = scoped.commentRequests.find((q) => q._id === r.commentRequestId);
          return {
            week: req?.articleContext?.week,
            seasonId: req?.articleContext?.seasonId,
            raw: r.rawResponse as string,
            quotes: (r.relevanceMetadata?.extractedQuotes ?? []) as string[],
          };
        });

      return { matchup, record, rank, finalRecord, transactions, draftPickCount, trades, rivalry, priorResponses };
    };

    /* ------------------------------------------------------------------ */
    /* Run                                                                 */
    /* ------------------------------------------------------------------ */

    // The builder logs every roster player; keep the run readable.
    const originalLog = console.log;
    console.log = () => {};

    const results: Array<{
      id: string;
      label: string;
      scenario: Scenario;
      context: unknown;
      factBlock?: string;
      oracle: Oracle;
      findings: Finding[];
    }> = [];

    const teamOldIdFor = (s: Scenario) =>
      (teamsBySeason.get(s.seasonId ?? PLAYED_SEASON) ?? []).find(
        (tm) => String(tm.externalId) === s.teamExternalId
      )?._id;
    // Real prod users were inserted with their old ids remapped; map back for the oracle.
    const oldUserIdByNew = new Map<string, string>();
    for (const [oldId, newId] of idMap) if (scoped.users.some((u) => u._id === oldId)) oldUserIdByNew.set(newId, oldId);

    try {
      for (const s of scenarios) {
        const teamOldId = teamOldIdFor(s);
        const targetUserId = teamOldId ? userIdByTeamOldId.get(teamOldId) : undefined;
        if (!targetUserId) {
          results.push({
            id: s.id,
            label: s.label,
            scenario: s,
            context: null,
            oracle: oracleFor(s, undefined),
            findings: [{ code: "no_manager", severity: "block", detail: "no user resolved for this team" }],
          });
          continue;
        }

        const requestId = await t.run(async (ctx) => {
          const now = Date.now();
          return await ctx.db.insert("commentRequests", {
            leagueId,
            targetUserId,
            contentType: s.contentType,
            interviewerPersona: "sam-ortega",
            writerPersona: "mel-diaper",
            articleContext: {
              week: s.week,
              seasonId: s.seasonId,
              topic: `${s.contentType.replace(/_/g, " ")}${s.week ? ` week ${s.week}` : ""}`,
              focusAreas: ["team performance"],
            },
            status: "pending",
            scheduledSendTime: now,
            articleGenerationTime: now + 60 * 60 * 1000,
            conversationState: "not_started",
            aiContext: { initialPrompt: "", conversationGoals: [], currentFocus: s.contentType },
            autoEndCriteria: {
              maxMessages: 8,
              currentMessageCount: 0,
              minResponseLength: 30,
              lastActivityTime: now,
              inactivityTimeoutMinutes: 30,
            },
            priority: "medium",
            notificationsSent: [],
            createdAt: now,
            updatedAt: now,
          });
        });

        let context: any = null;
        let error: string | undefined;
        try {
          context = await t.query(internal.commentRequests.buildConversationContext, {
            commentRequestId: requestId,
          });
        } catch (e) {
          error = String((e as Error).message).slice(0, 500);
        }

        const oracle = oracleFor(s, oldUserIdByNew.get(targetUserId as string));
        const findings: Finding[] = [];
        if (error || !context) {
          findings.push({ code: "builder_error", severity: "block", detail: error ?? "null context" });
          results.push({ id: s.id, label: s.label, scenario: s, context, oracle, findings });
          continue;
        }

        const tp = context.teamPerformance;
        const seasonRequested = s.seasonId ?? PLAYED_SEASON;

        // Identity
        if (context.teamName === "Unknown Team" || tp.teamName === "Unknown Team") {
          findings.push({ code: "unknown_identity", severity: "block", detail: "teamName is Unknown Team" });
        }
        if (context.managerName === "Unknown manager") {
          findings.push({ code: "unknown_identity", severity: "block", detail: "managerName is Unknown manager" });
        }
        if (context.teamName !== s.teamName) {
          findings.push({
            code: "team_name_other_season",
            severity: "warn",
            detail: `context team "${context.teamName}" vs this season's "${s.teamName}"`,
          });
        }

        // Week: judge the text Sam actually reads, not the raw number.
        const factBlock = buildInterviewFactBlock(context as ConversationContext);
        if (/Week (0|undefined|NaN)\b/.test(factBlock)) {
          findings.push({ code: "week_zero", severity: "block", detail: `fact block reads "${/Week (0|undefined|NaN)\b[^\n]*/.exec(factBlock)?.[0]}"` });
        }
        if (/\b(undefined|NaN|null)\b/.test(factBlock)) {
          findings.push({ code: "fact_block_hole", severity: "block", detail: `fact block contains a hole: "${/[^\n]*\b(undefined|NaN|null)\b[^\n]*/.exec(factBlock)?.[0]}"` });
        }

        // Result
        if (oracle.matchup) {
          const m = oracle.matchup;
          const hasScores = m.score > 0 || m.opponentScore > 0;
          if (hasScores) {
            const problems: string[] = [];
            if (Math.abs(tp.score - m.score) > 0.01) problems.push(`score ${tp.score} vs ${m.score}`);
            if (context.opponentScore === undefined || Math.abs(context.opponentScore - m.opponentScore) > 0.01) {
              problems.push(`opponentScore ${context.opponentScore} vs ${m.opponentScore}`);
            }
            if (tp.won !== m.won && !m.tie) problems.push(`won ${tp.won} vs ${m.won}`);
            if (m.tie && !context.tie) problems.push("tie reported as a loss");
            if (context.margin === undefined || Math.abs(context.margin - m.margin) > 0.06) {
              problems.push(`margin ${context.margin} vs ${m.margin}`);
            }
            if (m.opponentName && context.opponentName !== m.opponentName) {
              problems.push(`opponent "${context.opponentName}" vs "${m.opponentName}"`);
            }
            if (problems.length) findings.push({ code: "result_mismatch", severity: "block", detail: problems.join("; ") });
          } else if (tp.score > 0 || context.opponentScore) {
            findings.push({
              code: "season_fallback",
              severity: "block",
              detail: `week ${s.week} of ${seasonRequested} has no scores but context says ${tp.won ? "won" : "lost"} ${tp.score}-${context.opponentScore} vs ${context.opponentName} (seasonId ${context.seasonId})`,
            });
          }
          if (context.seasonId !== seasonRequested) {
            findings.push({ code: "season_fallback", severity: "block", detail: `context.seasonId ${context.seasonId} != requested ${seasonRequested}` });
          }

          // IR handling
          const named = new Set<string>([
            ...tp.underperformers.map((p: Row) => p.player),
            ...tp.overperformers.map((p: Row) => p.player),
            ...(context.lineupDecisions ?? []).map((d: Row) => d.startedPlayer),
          ]);
          const irNamed = m.irPlayers.filter((n) => named.has(n));
          if (irNamed.length) {
            findings.push({ code: "ir_as_starter", severity: "block", detail: `IR player(s) treated as starters: ${irNamed.join(", ")}` });
          }
          if (context.benchPoints !== undefined && Math.abs(context.benchPoints - m.benchPoints) > 0.06) {
            findings.push({ code: "ir_in_bench", severity: "warn", detail: `benchPoints ${context.benchPoints} vs slot-20 total ${m.benchPoints} (IR on roster: ${m.irPlayers.join(", ") || "none"})` });
          }
          if (context.topBenchPlayer && !m.benchPlayers.includes(context.topBenchPlayer.player)) {
            findings.push({ code: "ir_in_bench", severity: "warn", detail: `topBenchPlayer ${context.topBenchPlayer.player} is not a slot-20 player` });
          }
        } else if (s.week && (tp.score > 0 || context.opponentName)) {
          findings.push({
            code: "season_fallback",
            severity: "block",
            detail: `no ${seasonRequested} week ${s.week} matchup for this team but context has a result (${tp.score}-${context.opponentScore} vs ${context.opponentName}, seasonId ${context.seasonId})`,
          });
        }

        // Standing / record
        const standing = context.leagueContext.standings.find((st: Row) => st.teamId === tp.teamId);
        if (standing && s.week) {
          const asOf = `${oracle.record.wins}-${oracle.record.losses}${oracle.record.ties ? `-${oracle.record.ties}` : ""}`;
          if (standing.record !== asOf) {
            findings.push({
              code: "record_not_as_of_week",
              severity: "warn",
              detail: `record "${standing.record}" (teams.record) vs "${asOf}" as of week ${s.week}`,
            });
          }
          const gamesPlayed = oracle.record.wins + oracle.record.losses + oracle.record.ties;
          if (gamesPlayed > 0 && standing.rank !== oracle.rank) {
            findings.push({ code: "rank_mismatch", severity: "warn", detail: `rank #${standing.rank} vs #${oracle.rank} by wins/points as of week ${s.week}` });
          }
        }
        if (!standing) findings.push({ code: "no_standing", severity: "warn", detail: "team not found in standings" });

        // Transactions
        const ctxTx = context.transactionsThisWeek ?? [];
        if (s.week) {
          const want = oracle.transactions.map((tx) => `${tx.type}:${tx.added.join("+")}/${tx.dropped.join("+")}:$${tx.bid}`).sort();
          const got = ctxTx.map((tx: Row) => `${tx.type}:${tx.playersAdded.join("+")}/${tx.playersDropped.join("+")}:$${tx.bidAmount ?? 0}`).sort();
          if (JSON.stringify(want.slice(0, 10)) !== JSON.stringify(got)) {
            findings.push({ code: "transactions_mismatch", severity: "warn", detail: `want ${JSON.stringify(want)} got ${JSON.stringify(got)}` });
          }
        }

        // Draft picks
        if (s.contentType === "draft_rankings" || s.contentType === "mock_draft") {
          const picks = context.draftData?.userDraftPicks ?? [];
          if (oracle.draftPickCount > 0 && picks.length === 0) {
            findings.push({ code: "draft_picks_missing", severity: "block", detail: `${oracle.draftPickCount} picks in the transactions table, 0 in context` });
          }
          const wrong = picks.filter((p: Row) => p.teamName !== s.teamName);
          if (wrong.length) findings.push({ code: "draft_picks_wrong_team", severity: "block", detail: wrong.map((p: Row) => `${p.playerName} -> ${p.teamName}`).join(", ") });
          if (oracle.draftPickCount === 0 && picks.length > 0) {
            findings.push({ code: "draft_picks_phantom", severity: "block", detail: `${picks.length} picks in context, none in the transactions table` });
          }
        }

        // Trades (the builder returns the two most recent season trades)
        const ctxTrades = context.tradesThisWeek ?? [];
        const wantTrades = oracle.trades.slice(0, 2).map((tr) => `${tr.withTeam}|${tr.gave.join("+")}|${tr.received.join("+")}`).sort();
        const gotTrades = ctxTrades.map((tr: Row) => `${tr.withTeam}|${tr.gave.join("+")}|${tr.received.join("+")}`).sort();
        if (JSON.stringify(wantTrades) !== JSON.stringify(gotTrades)) {
          findings.push({ code: "trade_mismatch", severity: "warn", detail: `want ${JSON.stringify(wantTrades)} got ${JSON.stringify(gotTrades)}` });
        }
        if (ctxTrades.length && s.week && s.contentType !== "trade_analysis") {
          findings.push({ code: "trade_no_week", severity: "info", detail: "season trade surfaced without a week; Sam may present it as this week's" });
        }

        // Rivalry
        if (oracle.rivalry && context.rivalry?.allTimeRecord !== oracle.rivalry) {
          findings.push({ code: "rivalry_mismatch", severity: "warn", detail: `context ${context.rivalry?.allTimeRecord} vs rivalries table ${oracle.rivalry}` });
        }

        // Prior quotes
        for (const q of context.priorQuotes ?? []) {
          const source = oracle.priorResponses.find((r) => r.raw.toLowerCase().includes(String(q.text).replace(/…$/, "").toLowerCase().slice(0, 40)));
          if (!source) {
            findings.push({ code: "prior_quote_label", severity: "block", detail: `"${q.text}" is not a verbatim span of anything this manager typed` });
          }
          if (q.week !== undefined && seasonRequested !== PLAYED_SEASON && !source) {
            findings.push({ code: "prior_quote_other_season", severity: "warn", detail: `prior quote from a different season: "${q.text}"` });
          }
        }
        const priorSeasons = new Set(oracle.priorResponses.map((r) => r.seasonId));
        if ((context.priorQuotes ?? []).length && !priorSeasons.has(seasonRequested) && priorSeasons.size) {
          findings.push({ code: "prior_quote_other_season", severity: "warn", detail: `all prior quotes come from seasons ${[...priorSeasons].join(",")}, not ${seasonRequested}` });
        }

        results.push({ id: s.id, label: s.label, scenario: s, context, factBlock, oracle, findings });
      }
    } finally {
      console.log = originalLog;
    }

    const byCode: Record<string, number> = {};
    for (const r of results) for (const f of r.findings) byCode[`${f.severity}:${f.code}`] = (byCode[`${f.severity}:${f.code}`] ?? 0) + 1;

    const summary = {
      generatedAt: new Date().toISOString(),
      dataDir,
      league: { oldId: leagueOldId, name: leagueRow!.name },
      seasons: { played: PLAYED_SEASON, next: NEXT_SEASON, weeks: weeks.length },
      insertStats,
      scenarios: results.length,
      withBlocks: results.filter((r) => r.findings.some((f) => f.severity === "block")).length,
      withWarns: results.filter((r) => r.findings.some((f) => f.severity === "warn")).length,
      byCode,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
      console.log(`wrote ${results.length} scenarios to ${OUT}`);
    }

    expect(results.length).toBeGreaterThan(0);
  }, 600_000);
});
