import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;
const CLERK_COMMISH = "clerk_claims_commish";

/**
 * One league with a single team, enough for `getPriorClaimsForWriter` to run without
 * touching auth (it's an `internalQuery`, called the way `aiBatch`/`disputedNode` call it).
 * Same shape as `tests/disputed-convex.test.ts` / `tests/relationships.test.ts`'s own `setup`.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Claims Ledger Test League",
      platform: "espn",
      externalId: "9004",
      commissionerUserId: CLERK_COMMISH,
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
      },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 5,
        size: 2,
        lastSyncedAt: now,
        isPrivate: false,
      },
      subscription: {
        tier: "pro",
        status: "paid",
        creditsRemaining: 100,
        creditsMonthly: 100,
        paymentStatus: "completed",
        seasonYear: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: CLERK_COMMISH,
      role: "commissioner",
      joinedAt: now,
    });

    return { leagueId };
  });

  return { t, ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** An ordinary single-writer article carrying one already-settled claim. */
async function insertOrdinaryArticle(
  t: Setup["t"],
  leagueId: Setup["leagueId"],
  args: { persona: string; outcome: "hit" | "miss" | "open" }
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("aiContent", {
      leagueId,
      type: "recap",
      persona: args.persona,
      title: `${args.persona}'s recap`,
      content: "Recap body.",
      metadata: { featured_teams: [], credits_used: 0 },
      status: "published",
      createdAt: Date.now(),
      claims: [
        {
          text: `${args.persona} called it.`,
          kind: "team_win",
          subjectTeamId: "T3",
          week: 4,
          persona: args.persona,
          outcome: args.outcome,
        },
      ],
    })
  );
}

/**
 * A settled "Disputed" episode: an `aiContent` row with `type: "desk_show"` and
 * top-level `persona: "curtis-vaughn"` (the host), whose individual claims are stamped
 * with the desk members who actually made them - Mel's hit, Reggie's miss.
 */
async function insertShowEpisode(t: Setup["t"], leagueId: Setup["leagueId"]) {
  return await t.run(async (ctx) =>
    ctx.db.insert("aiContent", {
      leagueId,
      type: "desk_show",
      persona: "curtis-vaughn",
      title: "Disputed · Week 5",
      content: "# Disputed",
      metadata: { featured_teams: [], credits_used: 0 },
      status: "published",
      createdAt: Date.now(),
      claims: [
        {
          text: "Mel says Ann wins out.",
          kind: "team_win",
          subjectTeamId: "T3",
          week: 5,
          persona: "mel-diaper",
          outcome: "hit",
        },
        {
          text: "Reggie says Ann chokes.",
          kind: "team_win",
          subjectTeamId: "T3",
          week: 5,
          persona: "reggie-banks",
          outcome: "miss",
        },
      ],
    })
  );
}

describe("claims: getPriorClaimsForWriter sees Disputed show claims", () => {
  it("gives Mel her own article's claim plus her show claim, and her own record", async () => {
    const { t, leagueId } = await setup();
    await insertOrdinaryArticle(t, leagueId, { persona: "mel-diaper", outcome: "open" });
    await insertShowEpisode(t, leagueId);

    const result = await t.query(internal.claims.getPriorClaimsForWriter, {
      leagueId,
      persona: "mel-diaper",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.claim).sort()).toEqual(
      ["Mel says Ann wins out.", "mel-diaper called it."].sort()
    );
    expect(result.record).toEqual({ hits: 1, misses: 0, open: 1 });
  });

  it("gives Reggie only his show claim, none of Mel's or the host's", async () => {
    const { t, leagueId } = await setup();
    await insertOrdinaryArticle(t, leagueId, { persona: "mel-diaper", outcome: "open" });
    await insertShowEpisode(t, leagueId);

    const result = await t.query(internal.claims.getPriorClaimsForWriter, {
      leagueId,
      persona: "reggie-banks",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      claim: "Reggie says Ann chokes.",
      outcome: "miss",
    });
    expect(result.record).toEqual({ hits: 0, misses: 1, open: 0 });
  });

  it("gives the host none of the show's per-speaker claims", async () => {
    const { t, leagueId } = await setup();
    await insertOrdinaryArticle(t, leagueId, { persona: "mel-diaper", outcome: "open" });
    await insertShowEpisode(t, leagueId);

    const result = await t.query(internal.claims.getPriorClaimsForWriter, {
      leagueId,
      persona: "curtis-vaughn",
    });

    expect(result.items).toEqual([]);
    expect(result.record).toEqual({ hits: 0, misses: 0, open: 0 });
  });
});

describe("claims: getWriterRecords includes Disputed show claims", () => {
  it("rolls Mel's and Reggie's show claims into their own league-wide records", async () => {
    const { t, leagueId } = await setup();
    await insertShowEpisode(t, leagueId);

    const records = await t
      .withIdentity({ subject: CLERK_COMMISH })
      .query(api.claims.getWriterRecords, { leagueId });

    const byPersona = new Map(records.map((row) => [row.persona, row]));
    expect(byPersona.get("mel-diaper")).toMatchObject({ hits: 1, misses: 0, open: 0 });
    expect(byPersona.get("reggie-banks")).toMatchObject({ hits: 0, misses: 1, open: 0 });
    expect(byPersona.get("curtis-vaughn")).toMatchObject({ hits: 0, misses: 0, open: 0 });
  });
});
