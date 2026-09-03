/**
 * Playoff bracket math: byes, seeding, the winners bracket, consolation ladders, and the champion -
 * all derived from the `matchups` table's own rows, never from `leagueSeasons.champion` (which a
 * rolled-over sync can corrupt - see `deriveSeasonResults`'s header comment and `convex/seasonResults.ts`).
 *
 * Consumed by `api.matchups.getPlayoffBracket` (the schedule-page bracket), `convex/aiQueries.ts`
 * (the writers' FACTS block) and `convex/espnSync.ts` (season-results repair). Shapes come from
 * `convex/lib/playoffTypes.ts` - do not change them here.
 *
 * Intentionally pure - no imports from `./_generated/api` or any other `convex/*.ts` module that
 * itself references `internal`/`api` (the repo-wide gotcha documented in `./leagueCalendar.ts` and
 * `./espnSettings.ts`), so this is safe to import as a value from a query, a mutation, an action
 * and a plain vitest file with no Convex runtime at all.
 */

import type { BracketGame, BracketRound, BracketTeam, BracketSide, PlayoffContext, PlayoffTier } from "./playoffTypes";

/* -------------------------------------------------------------------------- *
 * Byes
 * -------------------------------------------------------------------------- */

/**
 * A round-one bye for a top seed is stored as a real `matchups` row with one side left empty
 * (verified across every 2021-2025 prod season: week 15's two bye rows carry `awayTeamId: ""`,
 * `awayScore: 0`, `winner` undefined, the resting team's real score in `homeScore`). Nothing in the
 * sync or the content pipeline recognised these before this module - they read as an unfinished
 * "Six Games and Two Blanks on the Board" game. Every caller of `buildPlayoffContext` and the
 * pre-generation gates (`convex/contentScheduling.ts`) routes through this one check.
 */
export function isByeMatchup(m: { homeTeamId: string; awayTeamId: string }): boolean {
  return m.homeTeamId === "" || m.awayTeamId === "";
}

/**
 * Highest matchup period with any decided game (`winner` set) - "the last week with a finished
 * game," used as `throughWeek` for a LIVE (not backfilled) playoff context. `league.espnData.
 * currentScoringPeriod` is ESPN's notion of the current week, which can lead or lag the last week
 * that actually finished (mid-week, or after a bye-only week nothing sets `winner` on); this reads
 * the ground truth off the matchups themselves instead. `0` when nothing has finished yet.
 */
export function highestFinishedMatchupPeriod(
  matchups: Array<{ matchupPeriod: number; winner?: string | null }>
): number {
  let max = 0;
  for (const m of matchups) {
    if (m.winner && m.matchupPeriod > max) max = m.matchupPeriod;
  }
  return max;
}

/* -------------------------------------------------------------------------- *
 * Round names
 * -------------------------------------------------------------------------- */

/**
 * `roundIndex` is 0-based, round one first. Named from the END of the bracket backward so the
 * championship is always "Championship" and the round before it "Semifinals" regardless of how
 * many total rounds there are; anything further back than "Quarterfinals" falls back to
 * "Round <n>" (1-based) - a 5+ round bracket is not a shape any real league in this app has, but
 * this keeps the function total rather than throwing on one.
 */
export function playoffRoundName(roundIndex: number, rounds: number): string {
  const fromChampionship = rounds - 1 - roundIndex;
  if (fromChampionship === 0) return "Championship";
  if (fromChampionship === 1) return "Semifinals";
  if (fromChampionship === 2) return "Quarterfinals";
  return `Round ${roundIndex + 1}`;
}

/* -------------------------------------------------------------------------- *
 * Corruption detection (spec: `leagueSeasons.champion` for 2025 in prod was a 0-0 record, owner
 * "Unknown" - evidently written from a rolled-over later-season payload). Shared by
 * `convex/seasonResults.ts`'s repair mutation, `convex/espnSync.ts`'s sync-time guard and
 * `convex/aiQueries.ts`'s season-welcome history so all three agree on what "obviously wrong" means.
 * -------------------------------------------------------------------------- */

export function isCorruptedSeasonResult(
  entry: { owner?: string; record?: { wins: number; losses: number; ties: number } } | null | undefined
): boolean {
  if (!entry) return false;
  const record = entry.record;
  const noGamesPlayed = !record || (record.wins === 0 && record.losses === 0 && record.ties === 0);
  const unknownOwner = !entry.owner || entry.owner.trim() === "" || entry.owner.trim() === "Unknown";
  return noGamesPlayed || unknownOwner;
}

/* -------------------------------------------------------------------------- *
 * buildPlayoffContext
 * -------------------------------------------------------------------------- */

export interface PlayoffTeamInput {
  externalId: string;
  name: string;
  record: { wins: number; losses: number; ties: number; pointsFor?: number; playoffSeed?: number };
}

export interface PlayoffMatchupInput {
  matchupPeriod: number;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winner?: "home" | "away" | "tie";
  playoffTier?: string;
}

export interface PlayoffFormatInput {
  playoffTeamCount?: number;
  regularSeasonMatchupPeriods?: number;
  playoffMatchupPeriodLength?: number;
  playoffSeedingRule?: string;
}

export interface PlayoffStandingRow {
  externalId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  rank: number;
}

export interface BuildPlayoffContextInput {
  teams: PlayoffTeamInput[];
  matchups: PlayoffMatchupInput[];
  format: PlayoffFormatInput;
  /** The last week whose results count: live, the current week; backfill, the as-of week. */
  throughWeek: number;
  /** Through-week standings (backfill). When given, this is the seeding order - see `orderTeams`. */
  standings?: PlayoffStandingRow[];
}

interface SeedRow {
  externalId: string;
  name: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

/**
 * The full field in seed order (every team, not just the playoff qualifiers) - `seeds`/`bubble`
 * below just slice off the front of this. Three-tier preference, all resolving to the same shape:
 *  1. `input.standings`, ordered by its own `rank` - a through-week computation the caller (season
 *     backfill) already trusts more than anything derivable here.
 *  2. Every team's `record.playoffSeed`, when EVERY team has one, they're 1..teamCount and none
 *     repeat - ESPN's own seed, once the regular season (or a division-winners rule) has set it.
 *  3. Wins desc, pointsFor desc, name asc - the same fallback order used everywhere else in this
 *     app a league has no seed data yet (draft-week, or a settings gap).
 */
function orderTeams(input: BuildPlayoffContextInput): SeedRow[] {
  if (input.standings && input.standings.length > 0) {
    const nameByExternalId = new Map(input.teams.map((t) => [t.externalId, t.name]));
    return [...input.standings]
      .sort((a, b) => a.rank - b.rank)
      .map((row) => ({
        externalId: row.externalId,
        name: nameByExternalId.get(row.externalId) ?? row.externalId,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        pointsFor: row.pointsFor,
      }));
  }

  const seedValues = input.teams.map((t) => t.record.playoffSeed);
  const everyTeamHasADistinctSeed =
    seedValues.every((s): s is number => typeof s === "number") &&
    new Set(seedValues).size === seedValues.length &&
    seedValues.every((s) => s! >= 1 && s! <= input.teams.length);

  const toRow = (t: PlayoffTeamInput): SeedRow => ({
    externalId: t.externalId,
    name: t.name,
    wins: t.record.wins,
    losses: t.record.losses,
    ties: t.record.ties,
    pointsFor: t.record.pointsFor ?? 0,
  });

  if (everyTeamHasADistinctSeed) {
    return [...input.teams].sort((a, b) => a.record.playoffSeed! - b.record.playoffSeed!).map(toRow);
  }

  return [...input.teams]
    .sort((a, b) => {
      if (b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
      const bPF = b.record.pointsFor ?? 0;
      const aPF = a.record.pointsFor ?? 0;
      if (bPF !== aPF) return bPF - aPF;
      return a.name.localeCompare(b.name);
    })
    .map(toRow);
}

/**
 * Standard "highest remaining seed vs lowest remaining seed" pairing among a set of surviving
 * seeds: [3,4,5,6] -> [[3,6],[4,5]]; [1..8] -> [[1,8],[2,7],[3,6],[4,5]] (a standard 8-team
 * bracket). ESPN reseeds by surviving seed every round, not just round one - verified against the
 * 2025 prod bracket (fixture in `tests/playoffs.test.ts`): round two paired seed 1 (a round-one
 * bye) against seed 5 (the round-one 4-vs-5 winner) and seed 2 against seed 3, i.e. exactly this
 * rule reapplied to whoever was still alive, not a fixed "top half plays top half" bracket slot.
 * Returns seed NUMBERS, not team ids - the caller resolves those against `seeds`.
 */
function pairAdvancing(survivingSeeds: number[]): Array<[number, number]> {
  const sorted = [...survivingSeeds].sort((a, b) => a - b);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length / 2; i++) {
    pairs.push([sorted[i], sorted[sorted.length - 1 - i]]);
  }
  return pairs;
}

/** Round one's pairing among the teams that did NOT get a bye - `pairAdvancing` over seeds `byes+1..n`. */
function firstRoundPairings(byes: number, playoffTeamCount: number): Array<[number, number]> {
  const remaining: number[] = [];
  for (let seed = byes + 1; seed <= playoffTeamCount; seed++) remaining.push(seed);
  return pairAdvancing(remaining);
}

function gameSortKey(g: BracketGame): number {
  return g.bye?.seed ?? g.home?.seed ?? Number.MAX_SAFE_INTEGER;
}

function byWeekThenSeed(a: BracketGame, b: BracketGame): number {
  if (a.week !== b.week) return a.week - b.week;
  return gameSortKey(a) - gameSortKey(b);
}

function gameStatus(m: PlayoffMatchupInput): "final" | "live" | "scheduled" {
  if (m.winner) return "final";
  return m.homeScore > 0 || m.awayScore > 0 ? "live" : "scheduled";
}

function winnerTeamIdOf(m: PlayoffMatchupInput): string | undefined {
  if (m.winner === "home") return m.homeTeamId;
  if (m.winner === "away") return m.awayTeamId;
  return undefined;
}

interface SeedLookup {
  seedByTeamId: Map<string, BracketTeam>;
  nameByExternalId: Map<string, string>;
}

function sideFor(teamId: string, score: number | undefined, lookup: SeedLookup): BracketSide {
  const seeded = lookup.seedByTeamId.get(teamId);
  return {
    teamId,
    name: seeded?.name ?? lookup.nameByExternalId.get(teamId) ?? teamId,
    seed: seeded?.seed,
    score,
  };
}

/** A played or scheduled game (never a bye row - see `toByeGame`). */
function toBracketGame(m: PlayoffMatchupInput, tier: PlayoffTier, lookup: SeedLookup): BracketGame {
  const status = gameStatus(m);
  const showScore = status !== "scheduled";
  return {
    week: m.matchupPeriod,
    tier,
    home: sideFor(m.homeTeamId, showScore ? m.homeScore : undefined, lookup),
    away: sideFor(m.awayTeamId, showScore ? m.awayScore : undefined, lookup),
    winnerTeamId: winnerTeamIdOf(m),
    status,
  };
}

function toByeGame(m: PlayoffMatchupInput, lookup: SeedLookup): BracketGame {
  const teamId = m.homeTeamId !== "" ? m.homeTeamId : m.awayTeamId;
  const seeded = lookup.seedByTeamId.get(teamId);
  return {
    week: m.matchupPeriod,
    tier: "WINNERS_BRACKET",
    bye: { teamId, name: seeded?.name ?? lookup.nameByExternalId.get(teamId) ?? teamId, seed: seeded?.seed ?? 0 },
    status: "bye",
  };
}

function tbdGame(week: number, tier: PlayoffTier): BracketGame {
  return { week, tier, status: "tbd" };
}

/**
 * The playoff picture and bracket for one league-season, through `input.throughWeek`. See this
 * module's header and `convex/lib/playoffTypes.ts` for the contract. Never mutates any input array
 * or object; every returned array is freshly built.
 */
export function buildPlayoffContext(input: BuildPlayoffContextInput): PlayoffContext {
  const playoffTeamCount = input.format.playoffTeamCount ?? 6;
  const regularSeasonMatchupPeriods = input.format.regularSeasonMatchupPeriods ?? 14;
  const playoffMatchupPeriodLength = input.format.playoffMatchupPeriodLength ?? 1;
  // Guard against floating-point log2 of an exact power of two landing a hair above the integer
  // (e.g. 2.9999999999996 for 8) and rounding up one round too many.
  const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(1, playoffTeamCount)) - 1e-9));
  const byes = Math.pow(2, rounds) - playoffTeamCount;
  const playoffStartWeek = regularSeasonMatchupPeriods + 1;
  const championshipWeek = playoffStartWeek + rounds * playoffMatchupPeriodLength - 1;

  const ordered = orderTeams(input);
  const seedRows = ordered.slice(0, playoffTeamCount);
  const seeds: BracketTeam[] = seedRows.map((row, index) => ({
    teamId: row.externalId,
    name: row.name,
    seed: index + 1,
    record: `${row.wins}-${row.losses}-${row.ties}`,
    pointsFor: row.pointsFor,
  }));
  const seedByTeamId = new Map(seeds.map((s) => [s.teamId, s]));
  const seedByNumber = new Map(seeds.map((s) => [s.seed, s]));
  const nameByExternalId = new Map(input.teams.map((t) => [t.externalId, t.name]));
  const lookup: SeedLookup = { seedByTeamId, nameByExternalId };

  // Round one's slate purely from the (already-locked) seeds: byes for the top `byes` seeds,
  // "highest remaining vs lowest remaining" for the rest - unplayed, so every pairing game is
  // "scheduled" with no score. Used both for a true projection (seeds could still move) and for
  // live mode before the bracket's own rows exist yet, once the regular season is over and seeds
  // are locked (see `isProjected` below) - the pairing itself doesn't depend on which case it is.
  function roundOneSlate(week: number): BracketGame[] {
    const byeSeeds = seeds.slice(0, byes);
    return [
      ...byeSeeds.map((s): BracketGame => ({
        week,
        tier: "WINNERS_BRACKET",
        bye: { teamId: s.teamId, name: s.name, seed: s.seed },
        status: "bye",
      })),
      ...firstRoundPairings(byes, playoffTeamCount).map(([highSeed, lowSeed]): BracketGame => {
        const home = seedByNumber.get(highSeed)!;
        const away = seedByNumber.get(lowSeed)!;
        return {
          week,
          tier: "WINNERS_BRACKET",
          home: { teamId: home.teamId, name: home.name, seed: home.seed },
          away: { teamId: away.teamId, name: away.name, seed: away.seed },
          status: "scheduled",
        };
      }),
    ].sort(byWeekThenSeed);
  }

  // Projected only while the regular season itself is still undecided - seeds can still move.
  // Once the regular season is over (`throughWeek >= regularSeasonMatchupPeriods`) the field and
  // seeds are locked even though the first playoff game hasn't been played (or synced) yet, so a
  // week-15 preview written with `throughWeek` 14 must see "live" with a real round-one bracket
  // (byes + pairings, `roundOneSlate` above), not a projection that could still be wrong.
  const isProjected = input.throughWeek < regularSeasonMatchupPeriods;

  if (isProjected) {
    // Before a single game has been played every record is 0-0 and "if the season ended today"
    // would just be the team list in an arbitrary order: no seeds, no picture.
    if (input.throughWeek < 1) {
      return {
        mode: "projected",
        playoffTeamCount,
        rounds,
        byes,
        playoffStartWeek,
        championshipWeek,
        seeds: [],
        bubble: [],
        bracket: [],
        consolation: [],
        alive: [],
        eliminated: [],
      };
    }
    const games = roundOneSlate(playoffStartWeek);

    const bubble: BracketTeam[] = ordered.slice(playoffTeamCount, playoffTeamCount + 2).map((row, i) => ({
      teamId: row.externalId,
      name: row.name,
      seed: playoffTeamCount + i + 1,
      record: `${row.wins}-${row.losses}-${row.ties}`,
      pointsFor: row.pointsFor,
    }));

    return {
      mode: "projected",
      playoffTeamCount,
      rounds,
      byes,
      playoffStartWeek,
      championshipWeek,
      currentRound: undefined,
      seeds,
      bubble,
      bracket: [{ week: playoffStartWeek, name: playoffRoundName(0, rounds), games }],
      consolation: [],
      alive: [],
      eliminated: [],
      champion: undefined,
      runnerUp: undefined,
    };
  }

  // Live / final: the winners bracket is built entirely from the WINNERS_BRACKET rows that exist -
  // a bye row becomes a bye slot, a real game its result, and any slot the data hasn't produced yet
  // (a later round whose feeder games aren't decided, or a sync gap) is padded out to TBD. Rows
  // after `throughWeek` are dropped first - `input.matchups` is whatever the caller has on hand
  // (season backfill passes the whole synced season), and `throughWeek` is what actually says how
  // much of it counts; without this a "week 15" snapshot would leak week 16/17 results.
  const decidedMatchups = input.matchups.filter((m) => m.matchupPeriod <= input.throughWeek);

  const bracket: BracketRound[] = [];
  // Seeds still alive going into the round about to be built, once the round before it is fully
  // decided (every game final or a bye) - `undefined` once a round isn't fully decided, since a
  // later round can't be paired without knowing who's actually in it. Round one has no "prior
  // round" (it's seeded directly), so this starts unused until round two.
  let survivingSeeds: number[] | undefined;

  for (let r = 0; r < rounds; r++) {
    const roundStart = playoffStartWeek + r * playoffMatchupPeriodLength;
    const roundEnd = roundStart + playoffMatchupPeriodLength - 1;
    const roundMatchups = decidedMatchups.filter(
      (m) => m.playoffTier === "WINNERS_BRACKET" && m.matchupPeriod >= roundStart && m.matchupPeriod <= roundEnd
    );

    // Every round of a single-elimination bracket over 2^rounds slots has exactly 2^(rounds-1-r)
    // games once byes are accounted for (round one's byes count toward its 2^(rounds-1) slots
    // alongside its actual games; see this module's header for the arithmetic).
    const expectedSlots = Math.pow(2, rounds - 1 - r);

    let games: BracketGame[];
    if (roundMatchups.length > 0) {
      games = roundMatchups
        .map((m) => (isByeMatchup(m) ? toByeGame(m, lookup) : toBracketGame(m, "WINNERS_BRACKET", lookup)))
        .sort(byWeekThenSeed);
      while (games.length < expectedSlots) games.push(tbdGame(roundStart, "WINNERS_BRACKET"));
    } else if (r > 0 && survivingSeeds) {
      // ESPN hasn't posted this round's matchup row yet, but the round before it is fully decided,
      // so the pairing is already knowable - reseed the survivors (see `pairAdvancing`) as a
      // "scheduled" game rather than a bare TBD slot.
      games = pairAdvancing(survivingSeeds).map(([highSeed, lowSeed]): BracketGame => {
        const home = seedByNumber.get(highSeed)!;
        const away = seedByNumber.get(lowSeed)!;
        return {
          week: roundStart,
          tier: "WINNERS_BRACKET",
          home: { teamId: home.teamId, name: home.name, seed: home.seed },
          away: { teamId: away.teamId, name: away.name, seed: away.seed },
          status: "scheduled",
        };
      });
    } else if (r === 0) {
      // The regular season is over (that's what put this in live mode - see `isProjected` above)
      // so seeds are locked, even though the bracket's own rows don't exist yet - the round-one
      // slate is exactly as knowable as it is in a true projection.
      games = roundOneSlate(roundStart);
    } else {
      games = [];
      while (games.length < expectedSlots) games.push(tbdGame(roundStart, "WINNERS_BRACKET"));
    }

    bracket.push({ week: roundStart, name: playoffRoundName(r, rounds), games });

    const everyGameDecided = games.every((g) => g.status === "final" || g.status === "bye");
    survivingSeeds = everyGameDecided
      ? games.map((g) =>
          g.status === "bye"
            ? g.bye!.seed
            : g.winnerTeamId === g.home!.teamId
              ? g.home!.seed!
              : g.away!.seed!
        )
      : undefined;
  }

  const eliminatedSet = new Set<string>();
  for (const round of bracket) {
    for (const game of round.games) {
      if (game.status === "final" && game.winnerTeamId && game.home && game.away) {
        const loserId = game.winnerTeamId === game.home.teamId ? game.away.teamId : game.home.teamId;
        eliminatedSet.add(loserId);
      }
    }
  }
  const alive = seeds.filter((s) => !eliminatedSet.has(s.teamId)).map((s) => s.teamId);
  const eliminated = seeds.filter((s) => eliminatedSet.has(s.teamId)).map((s) => s.teamId);

  // The championship game: the single WINNERS_BRACKET game of the last round, or (a multi-week
  // round recorded as more than one row) the one with the highest week - the deciding leg.
  const lastRoundRealGames = bracket[rounds - 1].games.filter((g) => g.home && g.away);
  const championshipGame = lastRoundRealGames.reduce<BracketGame | undefined>(
    (latest, game) => (!latest || game.week > latest.week ? game : latest),
    undefined
  );

  let champion: BracketTeam | undefined;
  let runnerUp: BracketTeam | undefined;
  let mode: PlayoffContext["mode"] = "live";
  if (championshipGame?.status === "final" && championshipGame.winnerTeamId && championshipGame.home && championshipGame.away) {
    const winnerId = championshipGame.winnerTeamId;
    const loserId = winnerId === championshipGame.home.teamId ? championshipGame.away.teamId : championshipGame.home.teamId;
    champion = seedByTeamId.get(winnerId);
    runnerUp = seedByTeamId.get(loserId);
    mode = "final";
  }

  const consolation: BracketGame[] = decidedMatchups
    .filter(
      (m) =>
        m.playoffTier !== undefined &&
        m.playoffTier !== "NONE" &&
        m.playoffTier !== "WINNERS_BRACKET" &&
        !isByeMatchup(m)
    )
    .map((m) => toBracketGame(m, m.playoffTier as PlayoffTier, lookup))
    .sort(byWeekThenSeed);

  const currentRoundIndex = Math.min(
    Math.max(0, Math.floor((input.throughWeek - playoffStartWeek) / playoffMatchupPeriodLength)),
    rounds - 1
  );
  const currentRound = { week: bracket[currentRoundIndex].week, name: bracket[currentRoundIndex].name };

  return {
    mode,
    playoffTeamCount,
    rounds,
    byes,
    playoffStartWeek,
    championshipWeek,
    currentRound,
    seeds,
    bubble: [],
    bracket,
    consolation,
    alive,
    eliminated,
    champion,
    runnerUp,
  };
}

/**
 * Champion / runner-up / regular-season champion, straight from the bracket - never from
 * `leagueSeasons.champion`, which a rolled-over sync can corrupt (spec: prod's 2025 season stored
 * champion "joey's Scary Team", a 0-0 team with owner "Unknown", evidently written from a later
 * season's payload; see `convex/seasonResults.ts`). Undefined fields until the championship game
 * has actually been decided - a mid-season call must never guess at a result.
 */
export function deriveSeasonResults(
  input: BuildPlayoffContextInput
): { champion?: BracketTeam; runnerUp?: BracketTeam; regularSeasonChampion?: BracketTeam } {
  const context = buildPlayoffContext(input);
  if (context.mode !== "final" || !context.champion) return {};
  return {
    champion: context.champion,
    runnerUp: context.runnerUp,
    regularSeasonChampion: context.seeds[0],
  };
}
