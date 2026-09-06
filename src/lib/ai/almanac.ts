/**
 * The League Almanac (owner ask, 2026-09-06): the deterministic, all-seasons history block a
 * kickoff piece is written from. Computed once per article from plain rows (every season's teams,
 * results and matchups, plus the stored drafts) by the pure `buildAlmanac` below, then rendered
 * twice: into <FACTS> (`src/lib/ai/facts.ts#buildAlmanacFacts`, id-bearing, so every number a
 * writer shouts is verifiable) and into the readable LEAGUE LEDGER prose blocks of
 * `prompt-builder.ts#buildSeasonWelcomeData`.
 *
 * Why this exists: the old kickoff prompt handed Mel the last three champions and a dozen
 * "memorable moments" from three seasons, so a seven-season league read as three years of
 * margins repeated eight times, and "no repeat champion" was flatly wrong (back-to-back titles
 * in 2022-23 were outside the window). A level (a record, a count) is not a story; the almanac
 * carries the changes and the streaks that are.
 *
 * Identity: a manager is keyed by ESPN's member id (`teams.ownerInfo.id`) when every season has
 * it, else by the normalised owner name - team names change every year in this league (one
 * manager has used six), managers do not.
 *
 * Pure: no Convex imports. `convex/aiQueries.ts` gathers the rows; this file only computes.
 */

/* -------------------------------------------------------------------------- *
 * Input (plain rows, gathered by the Convex side)
 * -------------------------------------------------------------------------- */

export interface AlmanacStoredResult {
  /** ESPN team id for that season (`teams.externalId`), as a string. */
  teamId: string;
  teamName?: string;
  record?: { wins: number; losses: number; ties: number };
  pointsFor?: number;
}

export interface AlmanacSeasonInput {
  season: number;
  /** `leagueSeasons.champion` etc. Trusted for the team id when the record shows games played;
   *  the manager is always re-resolved from that season's team row (stored owners read "Unknown"). */
  champion?: AlmanacStoredResult;
  runnerUp?: AlmanacStoredResult;
  regularSeasonChampion?: AlmanacStoredResult;
  playoffTeamCount?: number;
  regularSeasonWeeks?: number;
  /** The stored draft, when the season has one (prod: 2024 and 2025). */
  draft?: AlmanacDraftPickInput[];
}

export interface AlmanacDraftPickInput {
  overallPickNumber: number;
  roundId: number;
  roundPickNumber: number;
  /** ESPN team id, numeric in the stored payload. */
  teamId: number | string;
  playerId: number | string;
  keeper?: boolean;
}

export interface AlmanacTeamInput {
  season: number;
  externalId: string;
  name: string;
  /** Stable manager key (ESPN member id when known, else normalised owner name). */
  managerKey: string;
  /** Display name, e.g. "Cameron Coscia". */
  manager: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst?: number;
  playoffSeed?: number;
}

export interface AlmanacMatchupInput {
  season: number;
  week: number;
  homeTeamId: string;
  /** Absent, "0" or empty on a bye row - such rows are never games. */
  awayTeamId?: string;
  homeScore: number;
  awayScore: number;
  winner?: "home" | "away" | "tie" | string;
  /** "NONE" (regular season), "WINNERS_BRACKET", "LOSERS_CONSOLATION_LADDER", "WINNERS_CONSOLATION_LADDER", "CHAMPIONSHIP". */
  playoffTier?: string;
}

/** A drafted player's season line, for the draft receipts (absent = not synced for that season). */
export interface AlmanacPlayerInput {
  season: number;
  playerId: string;
  name: string;
  pos?: string;
  /** Applied fantasy points for that season in this league's scoring, when synced. */
  seasonPoints?: number;
}

export interface AlmanacInput {
  /** The season the kickoff piece is about; every season before it is history. */
  currentSeason: number;
  seasons: AlmanacSeasonInput[];
  teams: AlmanacTeamInput[];
  matchups: AlmanacMatchupInput[];
  players?: AlmanacPlayerInput[];
}

/* -------------------------------------------------------------------------- *
 * Output
 * -------------------------------------------------------------------------- */

export interface AlmanacTeamRef {
  /** `"T" + externalId` of that season's team - the FACTS-style id. */
  teamId: string;
  team: string;
  managerKey: string;
  manager: string;
  /** "12-2" (ties appended only when non-zero). */
  record?: string;
  pointsFor?: number;
  seed?: number;
}

export interface AlmanacSeason {
  season: number;
  teamCount: number;
  champion?: AlmanacTeamRef;
  runnerUp?: AlmanacTeamRef;
  regularSeasonChampion?: AlmanacTeamRef;
  /** Best regular-season record that did not win the title, when different from the runner-up. */
  lastPlace?: AlmanacTeamRef;
  topScorer?: AlmanacTeamRef;
  /** The championship game, when the bracket has it: margin to one decimal, both scores. */
  final?: { winner: AlmanacTeamRef; loser: AlmanacTeamRef; winnerScore: number; loserScore: number; margin: number; week: number };
  /** Champion had a losing regular-season record, or a seed of 4 or worse. */
  unlikelyChampion?: { reason: string };
}

export interface AlmanacSeasonLine {
  season: number;
  team: string;
  record: string;
  pointsFor: number;
  /** Regular-season finish by record, 1 = best. */
  finish: number;
  madePlayoffs: boolean;
  champion: boolean;
  runnerUp: boolean;
}

export interface AlmanacManager {
  key: string;
  manager: string;
  /** This season's team, when the manager is in the league now (FACTS id and name). */
  currentTeamId?: string;
  currentTeam?: string;
  seasons: number;
  firstSeason: number;
  lastSeason: number;
  wins: number;
  losses: number;
  ties: number;
  /** "53-30" (ties appended only when non-zero). */
  record: string;
  winPct: number;
  pointsFor: number;
  pointsAgainst?: number;
  pointsPerGame: number;
  /** Seasons won, ascending. */
  titles: number[];
  runnerUps: number[];
  regularSeasonTitles: number[];
  playoffAppearances: number;
  /** Consecutive playoff seasons ending with the most recent completed season. */
  playoffStreak: number;
  lastPlaceFinishes: number[];
  bestSeason?: AlmanacSeasonLine;
  worstSeason?: AlmanacSeasonLine;
  /** Completed seasons since the last title; undefined when there is none. */
  yearsSinceTitle?: number;
  /** Distinct team names used, in first-used order. */
  teamNames: string[];
  /** Every completed season, ascending. */
  lines: AlmanacSeasonLine[];
}

export interface AlmanacGame {
  season: number;
  week: number;
  playoffTier?: string;
  winner: { team: string; manager: string; score: number };
  loser: { team: string; manager: string; score: number };
  margin: number;
}

export interface AlmanacRivalry {
  a: { managerKey: string; manager: string; currentTeamId?: string };
  b: { managerKey: string; manager: string; currentTeamId?: string };
  games: number;
  aWins: number;
  bWins: number;
  ties: number;
  /** Total points across all meetings, both sides, for the "most points scored in a rivalry" line. */
  lastMeeting?: { season: number; week: number; winnerManager: string; margin: number };
  /** The bigger streak either side currently holds in the series. */
  currentStreak?: { manager: string; wins: number };
}

export interface AlmanacDraftReceiptPick {
  pick: number;
  round: number;
  teamId: string;
  team: string;
  manager: string;
  player: string;
  pos?: string;
  seasonPoints?: number;
  /** Rank of this pick's season points among that season's first-round picks (1 = best). */
  firstRoundRank?: number;
  teamFinish?: { record: string; madePlayoffs: boolean; champion: boolean };
}

export interface AlmanacDraftReceipts {
  season: number;
  firstRound: AlmanacDraftReceiptPick[];
  /** The champion's first-round pick, when the champion is known. */
  titlePick?: AlmanacDraftReceiptPick;
  best?: AlmanacDraftReceiptPick;
  worst?: AlmanacDraftReceiptPick;
}

export interface AlmanacCurseBoard {
  /** Most career points with zero titles. */
  mostPointsNoTitle?: { manager: string; currentTeamId?: string; pointsFor: number; seasons: number; playoffAppearances: number };
  /** Longest gap since a title among past champions, and the never-won crowd. */
  longestDrought?: { manager: string; currentTeamId?: string; yearsSinceTitle: number; lastTitle: number };
  neverWon: Array<{ manager: string; currentTeamId?: string; seasons: number; playoffAppearances: number; runnerUps: number }>;
  /** Most runner-up finishes without a title. */
  alwaysTheBridesmaid?: { manager: string; currentTeamId?: string; runnerUps: number };
  neverMadePlayoffs: Array<{ manager: string; currentTeamId?: string; seasons: number }>;
  /** Most last-place finishes. */
  mostLastPlaces?: { manager: string; currentTeamId?: string; count: number; seasons: number[] };
}

export interface AlmanacRecordBook {
  biggestBlowout?: AlmanacGame;
  closestGame?: AlmanacGame;
  /** Regular-season, single-week only (playoff periods can span two weeks in older seasons). */
  highestScore?: { season: number; week: number; team: string; manager: string; score: number };
  lowestScore?: { season: number; week: number; team: string; manager: string; score: number };
  bestRegularSeason?: AlmanacSeasonLine & { manager: string };
  worstRegularSeason?: AlmanacSeasonLine & { manager: string };
  mostPointsInASeason?: AlmanacSeasonLine & { manager: string };
  /** Most titles, and how many managers share that count. */
  mostTitles?: { manager: string; count: number; seasons: number[] };
  backToBack: Array<{ manager: string; seasons: number[] }>;
}

export interface LeagueAlmanac {
  schema: "ffsn.almanac.v1";
  currentSeason: number;
  foundedSeason?: number;
  /** Completed seasons with results, ascending. */
  seasonsCovered: number[];
  seasons: AlmanacSeason[];
  /** Sorted: titles desc, then wins desc. Includes past managers no longer in the league (flagged by a missing currentTeamId). */
  managers: AlmanacManager[];
  curseBoard: AlmanacCurseBoard;
  records: AlmanacRecordBook;
  /** The most-played series and the most lopsided ones among current managers, at most 5. */
  rivalries: AlmanacRivalry[];
  drafts: AlmanacDraftReceipts[];
  /** Caveats a writer must respect, in plain English ("2020 was an eight-team season", "no draft data before 2024"). */
  notes: string[];
}

/** An almanac with nothing in it - what a league with no completed season gets. */
export function emptyAlmanac(currentSeason: number): LeagueAlmanac {
  return {
    schema: "ffsn.almanac.v1",
    currentSeason,
    seasonsCovered: [],
    seasons: [],
    managers: [],
    curseBoard: { neverWon: [], neverMadePlayoffs: [] },
    records: { backToBack: [] },
    rivalries: [],
    drafts: [],
    notes: ["no completed seasons on record"],
  };
}

/* -------------------------------------------------------------------------- *
 * Small pure helpers (no closures over `input`)
 * -------------------------------------------------------------------------- */

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

/** Spell out small integers ("six"); anything outside 0-20 falls back to the numeral. */
function spellNumber(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

/** "a" or "an" for the word that follows ("an eight-team season"). */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** "12-2" - ties appended only when non-zero, per every *Ref/*Manager doc comment above. */
function recordStr(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function winPctOf(wins: number, losses: number, ties: number): number {
  const games = wins + losses + ties;
  return games > 0 ? (wins + ties * 0.5) / games : 0;
}

/** "2021 and 2023" / "2021, 2022 and 2023" / "2021". Plain joiner, no Oxford comma. */
function formatSeasonList(seasons: number[]): string {
  if (seasons.length === 1) return String(seasons[0]);
  if (seasons.length === 2) return `${seasons[0]} and ${seasons[1]}`;
  return `${seasons.slice(0, -1).join(", ")} and ${seasons[seasons.length - 1]}`;
}

/** A bye row: an absent/blank/"0" away side, or (inside any playoff period) one side scoring
 *  exactly 0 against a positive score - see this file's header on the 2020-2025 prod bracket. */
function isByeRow(m: AlmanacMatchupInput): boolean {
  const away = m.awayTeamId;
  if (away === undefined || away === "" || away === "0") return true;
  const inPlayoffPeriod = m.playoffTier !== undefined && m.playoffTier !== "NONE";
  if (inPlayoffPeriod) {
    if (m.homeScore === 0 && m.awayScore > 0) return true;
    if (m.awayScore === 0 && m.homeScore > 0) return true;
  }
  return false;
}

/** The score this team posted in a game, by external id (undefined when not in this game). */
function scoreForTeam(m: AlmanacMatchupInput, externalId: string): number | undefined {
  if (m.homeTeamId === externalId) return m.homeScore;
  if (m.awayTeamId === externalId) return m.awayScore;
  return undefined;
}

const DEFAULT_PLAYOFF_TEAM_COUNT = 6;

/**
 * Compute the almanac. Implemented in this file (pure, unit-tested in tests/almanac.test.ts);
 * the signature is the contract the prompt layer and the Convex gatherer are built against.
 */
export function buildAlmanac(input: AlmanacInput): LeagueAlmanac {
  /* ---------------------------------------------------------------------- *
   * Indexes over the raw input, reused throughout
   * ---------------------------------------------------------------------- */

  const teamsBySeason = new Map<number, AlmanacTeamInput[]>();
  for (const t of input.teams) {
    const list = teamsBySeason.get(t.season);
    if (list) list.push(t);
    else teamsBySeason.set(t.season, [t]);
  }

  const teamByKey = new Map<string, AlmanacTeamInput>();
  for (const t of input.teams) teamByKey.set(`${t.season}:${t.externalId}`, t);
  function findTeam(season: number, externalId: string | undefined): AlmanacTeamInput | undefined {
    return externalId === undefined ? undefined : teamByKey.get(`${season}:${externalId}`);
  }

  function teamRef(season: number, externalId: string | undefined): AlmanacTeamRef | undefined {
    const t = findTeam(season, externalId);
    if (!t) return undefined;
    return {
      teamId: `T${t.externalId}`,
      team: t.name,
      managerKey: t.managerKey,
      manager: t.manager,
      record: recordStr(t.wins, t.losses, t.ties),
      pointsFor: round1(t.pointsFor),
      seed: t.playoffSeed,
    };
  }

  const seasonInputBySeason = new Map(input.seasons.map((s) => [s.season, s]));
  function playoffTeamCountFor(season: number): number {
    return seasonInputBySeason.get(season)?.playoffTeamCount ?? DEFAULT_PLAYOFF_TEAM_COUNT;
  }

  // Every team that appeared in a WINNERS_BRACKET or CHAMPIONSHIP game that season (bye sides
  // included - a bye is a playoff appearance). Built once over every matchup, not just completed
  // seasons', so a current-season draft's teamFinish can use it too.
  const playoffTeamIdsBySeason = new Map<number, Set<string>>();
  for (const m of input.matchups) {
    if (m.playoffTier !== "WINNERS_BRACKET" && m.playoffTier !== "CHAMPIONSHIP") continue;
    const set = playoffTeamIdsBySeason.get(m.season) ?? new Set<string>();
    if (m.homeTeamId) set.add(m.homeTeamId);
    if (m.awayTeamId) set.add(m.awayTeamId);
    playoffTeamIdsBySeason.set(m.season, set);
  }
  function madePlayoffsFlag(season: number, team: AlmanacTeamInput): boolean {
    if (team.playoffSeed !== undefined && team.playoffSeed <= playoffTeamCountFor(season)) return true;
    return playoffTeamIdsBySeason.get(season)?.has(team.externalId) ?? false;
  }

  /* ---------------------------------------------------------------------- *
   * Completed seasons
   * ---------------------------------------------------------------------- */

  function gamesPlayed(t: AlmanacTeamInput): number {
    return t.wins + t.losses + t.ties;
  }

  const seasonsCovered = input.seasons
    .filter((s) => s.season < input.currentSeason)
    .filter((s) => (teamsBySeason.get(s.season) ?? []).some((t) => gamesPlayed(t) > 0))
    .map((s) => s.season)
    .sort((a, b) => a - b);

  if (seasonsCovered.length === 0) {
    return emptyAlmanac(input.currentSeason);
  }

  const seasonIndex = new Map(seasonsCovered.map((s, i) => [s, i]));
  const foundedSeason = seasonsCovered[0];
  const lastCompletedSeason = seasonsCovered[seasonsCovered.length - 1];

  /* ---------------------------------------------------------------------- *
   * Per-season derivation + manager-season lines, one pass over the
   * completed seasons ascending.
   * ---------------------------------------------------------------------- */

  interface SeasonResultIds {
    championId?: string;
    runnerUpId?: string;
    regularSeasonChampionId?: string;
  }
  const seasonResultsBySeason = new Map<number, SeasonResultIds>();
  const seasonsOut: AlmanacSeason[] = [];

  interface ManagerBuild {
    key: string;
    manager: string;
    lines: AlmanacSeasonLine[];
    rawTeams: AlmanacTeamInput[];
    teamNames: string[];
    regularSeasonChampionSeasons: number[];
  }
  const managerBuilds = new Map<string, ManagerBuild>();
  function getBuild(team: AlmanacTeamInput): ManagerBuild {
    let b = managerBuilds.get(team.managerKey);
    if (!b) {
      b = {
        key: team.managerKey,
        manager: team.manager,
        lines: [],
        rawTeams: [],
        teamNames: [],
        regularSeasonChampionSeasons: [],
      };
      managerBuilds.set(team.managerKey, b);
    }
    b.manager = team.manager; // seasons are processed ascending - latest display name wins.
    if (!b.teamNames.includes(team.name)) b.teamNames.push(team.name);
    return b;
  }

  const allTeamSeasons: Array<{ line: AlmanacSeasonLine; manager: string; wins: number; losses: number; ties: number }> = [];

  function isValidStored(entry: AlmanacStoredResult | undefined): entry is AlmanacStoredResult & { record: { wins: number; losses: number; ties: number } } {
    if (!entry || !entry.record) return false;
    return entry.record.wins + entry.record.losses + entry.record.ties > 0;
  }

  for (const season of seasonsCovered) {
    const seasonTeams = teamsBySeason.get(season) ?? [];
    const seasonInput = seasonInputBySeason.get(season);

    // Regular-season champion: best record (wins desc, pointsFor desc).
    const byRecordDesc = [...seasonTeams].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
    const rankByExternalId = new Map(byRecordDesc.map((t, i) => [t.externalId, i + 1]));
    const bestRecordTeam = byRecordDesc[0];
    const byRecordAsc = [...seasonTeams].sort((a, b) => a.wins - b.wins || a.pointsFor - b.pointsFor);
    const worstRecordTeam = byRecordAsc[0];
    const topScorerTeam = [...seasonTeams].sort((a, b) => b.pointsFor - a.pointsFor)[0];

    const storedChampion = seasonInput?.champion;
    const storedRunnerUp = seasonInput?.runnerUp;
    const storedRegularSeasonChampion = seasonInput?.regularSeasonChampion;

    // The final: among CHAMPIONSHIP/WINNERS_BRACKET games (bye rows excluded), the max week's
    // game - the one involving the (already-trusted) stored champion when there's more than one
    // candidate, else the game between the two best seeds.
    const bracketGames = input.matchups.filter(
      (m) => m.season === season && (m.playoffTier === "CHAMPIONSHIP" || m.playoffTier === "WINNERS_BRACKET") && !isByeRow(m)
    );
    let finalGame: AlmanacMatchupInput | undefined;
    if (bracketGames.length > 0) {
      const maxWeek = Math.max(...bracketGames.map((m) => m.week));
      const candidates = bracketGames.filter((m) => m.week === maxWeek);
      if (candidates.length === 1) {
        finalGame = candidates[0];
      } else if (isValidStored(storedChampion)) {
        finalGame =
          candidates.find((m) => m.homeTeamId === storedChampion!.teamId || m.awayTeamId === storedChampion!.teamId) ??
          candidates[0];
      } else {
        let best: AlmanacMatchupInput | undefined;
        let bestKey = Infinity;
        for (const m of candidates) {
          const homeSeed = findTeam(season, m.homeTeamId)?.playoffSeed ?? 99;
          const awaySeed = findTeam(season, m.awayTeamId)?.playoffSeed ?? 99;
          const key = homeSeed + awaySeed;
          if (key < bestKey) {
            bestKey = key;
            best = m;
          }
        }
        finalGame = best ?? candidates[0];
      }
    }

    let finalWinnerId: string | undefined;
    let finalLoserId: string | undefined;
    if (finalGame) {
      const winnerIsHome = finalGame.winner === "home" || (finalGame.winner === undefined && finalGame.homeScore > finalGame.awayScore);
      finalWinnerId = winnerIsHome ? finalGame.homeTeamId : finalGame.awayTeamId;
      finalLoserId = winnerIsHome ? finalGame.awayTeamId : finalGame.homeTeamId;
    }

    const championId = isValidStored(storedChampion) ? storedChampion!.teamId : finalWinnerId;
    const runnerUpId = isValidStored(storedRunnerUp) ? storedRunnerUp!.teamId : finalLoserId;
    const regularSeasonChampionId = isValidStored(storedRegularSeasonChampion)
      ? storedRegularSeasonChampion!.teamId
      : bestRecordTeam?.externalId;

    seasonResultsBySeason.set(season, { championId, runnerUpId, regularSeasonChampionId });

    let final: AlmanacSeason["final"];
    if (finalGame && championId && runnerUpId) {
      const winnerRef = teamRef(season, championId);
      const loserRef = teamRef(season, runnerUpId);
      const winnerScore = scoreForTeam(finalGame, championId);
      const loserScore = scoreForTeam(finalGame, runnerUpId);
      if (winnerRef && loserRef && winnerScore !== undefined && loserScore !== undefined) {
        final = {
          winner: winnerRef,
          loser: loserRef,
          winnerScore: round1(winnerScore),
          loserScore: round1(loserScore),
          margin: round1(winnerScore - loserScore),
          week: finalGame.week,
        };
      }
    }

    let unlikelyChampion: { reason: string } | undefined;
    const championTeam = findTeam(season, championId);
    if (championTeam) {
      if (championTeam.losses > championTeam.wins) {
        unlikelyChampion = { reason: `won the title at ${recordStr(championTeam.wins, championTeam.losses, championTeam.ties)}` };
      } else if (championTeam.playoffSeed !== undefined && championTeam.playoffSeed >= 4) {
        unlikelyChampion = { reason: `won from the No. ${championTeam.playoffSeed} seed` };
      }
    }

    seasonsOut.push({
      season,
      teamCount: seasonTeams.length,
      champion: teamRef(season, championId),
      runnerUp: teamRef(season, runnerUpId),
      regularSeasonChampion: teamRef(season, regularSeasonChampionId),
      lastPlace: worstRecordTeam ? teamRef(season, worstRecordTeam.externalId) : undefined,
      topScorer: topScorerTeam ? teamRef(season, topScorerTeam.externalId) : undefined,
      final,
      unlikelyChampion,
    });

    // Manager-season lines, for the manager rollup and the record book below.
    for (const team of seasonTeams) {
      const finish = rankByExternalId.get(team.externalId)!;
      const line: AlmanacSeasonLine = {
        season,
        team: team.name,
        record: recordStr(team.wins, team.losses, team.ties),
        pointsFor: round1(team.pointsFor),
        finish,
        madePlayoffs: madePlayoffsFlag(season, team),
        champion: team.externalId === championId,
        runnerUp: team.externalId === runnerUpId,
      };
      const build = getBuild(team);
      build.lines.push(line);
      build.rawTeams.push(team);
      if (team.externalId === regularSeasonChampionId) build.regularSeasonChampionSeasons.push(season);
      allTeamSeasons.push({ line, manager: team.manager, wins: team.wins, losses: team.losses, ties: team.ties });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Managers
   * ---------------------------------------------------------------------- */

  const currentTeams = input.teams.filter((t) => t.season === input.currentSeason);
  for (const t of currentTeams) {
    if (!managerBuilds.has(t.managerKey)) getBuild(t);
  }

  function pickBest(lines: AlmanacSeasonLine[]): AlmanacSeasonLine | undefined {
    if (lines.length === 0) return undefined;
    return [...lines].sort((a, b) => a.finish - b.finish || b.pointsFor - a.pointsFor || b.season - a.season)[0];
  }
  function pickWorst(lines: AlmanacSeasonLine[]): AlmanacSeasonLine | undefined {
    if (lines.length === 0) return undefined;
    return [...lines].sort((a, b) => b.finish - a.finish || a.pointsFor - b.pointsFor || b.season - a.season)[0];
  }
  function teamCountForSeason(season: number): number {
    return teamsBySeason.get(season)?.length ?? 0;
  }

  const managers: AlmanacManager[] = [];
  for (const build of managerBuilds.values()) {
    const wins = build.rawTeams.reduce((s, t) => s + t.wins, 0);
    const losses = build.rawTeams.reduce((s, t) => s + t.losses, 0);
    const ties = build.rawTeams.reduce((s, t) => s + t.ties, 0);
    const games = wins + losses + ties;
    const pointsForSum = build.rawTeams.reduce((s, t) => s + t.pointsFor, 0);
    const paValues = build.rawTeams.map((t) => t.pointsAgainst).filter((v): v is number => v !== undefined);
    const currentTeam = currentTeams.find((t) => t.managerKey === build.key);

    const titles = build.lines.filter((l) => l.champion).map((l) => l.season);
    const runnerUps = build.lines.filter((l) => l.runnerUp).map((l) => l.season);

    let playoffStreak = 0;
    const lastLine = build.lines[build.lines.length - 1];
    if (lastLine && lastLine.season === lastCompletedSeason) {
      for (let i = build.lines.length - 1; i >= 0; i--) {
        if (build.lines[i].madePlayoffs) playoffStreak++;
        else break;
      }
    }

    managers.push({
      key: build.key,
      manager: build.manager,
      currentTeamId: currentTeam ? `T${currentTeam.externalId}` : undefined,
      currentTeam: currentTeam?.name,
      seasons: build.lines.length,
      firstSeason: build.lines[0]?.season ?? input.currentSeason,
      lastSeason: build.lines[build.lines.length - 1]?.season ?? input.currentSeason,
      wins,
      losses,
      ties,
      record: recordStr(wins, losses, ties),
      winPct: round3(winPctOf(wins, losses, ties)),
      pointsFor: round1(pointsForSum),
      pointsAgainst: paValues.length > 0 ? round1(paValues.reduce((a, b) => a + b, 0)) : undefined,
      pointsPerGame: games > 0 ? round1(pointsForSum / games) : 0,
      titles,
      runnerUps,
      regularSeasonTitles: build.regularSeasonChampionSeasons,
      playoffAppearances: build.lines.filter((l) => l.madePlayoffs).length,
      playoffStreak,
      lastPlaceFinishes: build.lines.filter((l) => l.finish === teamCountForSeason(l.season)).map((l) => l.season),
      bestSeason: pickBest(build.lines),
      worstSeason: pickWorst(build.lines),
      yearsSinceTitle: titles.length > 0 ? input.currentSeason - Math.max(...titles) - 1 : undefined,
      teamNames: build.teamNames,
      lines: build.lines,
    });
  }
  managers.sort((a, b) => b.titles.length - a.titles.length || b.wins - a.wins || b.pointsFor - a.pointsFor);
  const managerByKey = new Map(managers.map((m) => [m.key, m]));

  /* ---------------------------------------------------------------------- *
   * Record book
   * ---------------------------------------------------------------------- */

  function toGame(m: AlmanacMatchupInput): AlmanacGame | undefined {
    const home = findTeam(m.season, m.homeTeamId);
    const away = findTeam(m.season, m.awayTeamId);
    if (!home || !away) return undefined;
    const homeWon = m.winner === "home" || (m.winner === undefined && m.homeScore > m.awayScore);
    const winner = homeWon ? home : away;
    const loser = homeWon ? away : home;
    const winnerScore = homeWon ? m.homeScore : m.awayScore;
    const loserScore = homeWon ? m.awayScore : m.homeScore;
    return {
      season: m.season,
      week: m.week,
      playoffTier: m.playoffTier,
      winner: { team: winner.name, manager: winner.manager, score: round1(winnerScore) },
      loser: { team: loser.name, manager: loser.manager, score: round1(loserScore) },
      margin: round1(winnerScore - loserScore),
    };
  }

  const completedGames = input.matchups.filter((m) => seasonIndex.has(m.season) && !isByeRow(m));
  const allGames = completedGames.map(toGame).filter((g): g is AlmanacGame => g !== undefined && g.margin >= 0);
  // A tie has no winner/loser worth ranking as a "blowout" or "nail-biter" of margin 0 alongside
  // a real decided game; ties are exceedingly rare in fantasy and simply excluded from both.
  const decidedGames = allGames.filter((g) => g.margin > 0 || g.winner.score !== g.loser.score);

  const biggestBlowout = decidedGames.length > 0 ? [...decidedGames].sort((a, b) => b.margin - a.margin)[0] : undefined;
  const closestGame = decidedGames.length > 0 ? [...decidedGames].sort((a, b) => a.margin - b.margin)[0] : undefined;

  interface ScoreEntry { season: number; week: number; team: string; manager: string; score: number }
  const regularSeasonEntries: ScoreEntry[] = [];
  for (const m of completedGames) {
    if (m.playoffTier !== undefined && m.playoffTier !== "NONE") continue;
    const home = findTeam(m.season, m.homeTeamId);
    const away = findTeam(m.season, m.awayTeamId);
    if (home) regularSeasonEntries.push({ season: m.season, week: m.week, team: home.name, manager: home.manager, score: round1(m.homeScore) });
    if (away) regularSeasonEntries.push({ season: m.season, week: m.week, team: away.name, manager: away.manager, score: round1(m.awayScore) });
  }
  const highestScore = regularSeasonEntries.length > 0 ? [...regularSeasonEntries].sort((a, b) => b.score - a.score)[0] : undefined;
  const lowestScoreCandidates = regularSeasonEntries.filter((e) => e.score > 0);
  const lowestScore = lowestScoreCandidates.length > 0 ? [...lowestScoreCandidates].sort((a, b) => a.score - b.score)[0] : undefined;

  const bestRegularSeason =
    allTeamSeasons.length > 0
      ? [...allTeamSeasons].sort(
          (a, b) => winPctOf(b.wins, b.losses, b.ties) - winPctOf(a.wins, a.losses, a.ties) || b.line.pointsFor - a.line.pointsFor
        )[0]
      : undefined;
  const worstRegularSeason =
    allTeamSeasons.length > 0
      ? [...allTeamSeasons].sort(
          (a, b) => winPctOf(a.wins, a.losses, a.ties) - winPctOf(b.wins, b.losses, b.ties) || a.line.pointsFor - b.line.pointsFor
        )[0]
      : undefined;
  const mostPointsInASeason =
    allTeamSeasons.length > 0 ? [...allTeamSeasons].sort((a, b) => b.line.pointsFor - a.line.pointsFor)[0] : undefined;

  const mostTitles = managers.length > 0 && managers[0].titles.length > 0
    ? { manager: managers[0].manager, count: managers[0].titles.length, seasons: managers[0].titles }
    : undefined;

  const backToBack: Array<{ manager: string; seasons: number[] }> = [];
  for (const m of managers) {
    const titleSeasons = [...m.titles].sort((a, b) => a - b);
    let run: number[] = [];
    const flushRun = () => {
      if (run.length >= 2) backToBack.push({ manager: m.manager, seasons: [...run] });
    };
    for (const season of titleSeasons) {
      if (run.length === 0) {
        run = [season];
        continue;
      }
      const prevIdx = seasonIndex.get(run[run.length - 1])!;
      const curIdx = seasonIndex.get(season)!;
      if (curIdx === prevIdx + 1) run.push(season);
      else {
        flushRun();
        run = [season];
      }
    }
    flushRun();
  }

  /* ---------------------------------------------------------------------- *
   * Curse board
   * ---------------------------------------------------------------------- */

  const titlelessManagers = managers.filter((m) => m.titles.length === 0);

  const mostPointsNoTitle =
    titlelessManagers.length > 0
      ? (() => {
          const top = [...titlelessManagers].sort((a, b) => b.pointsFor - a.pointsFor)[0];
          return {
            manager: top.manager,
            currentTeamId: top.currentTeamId,
            pointsFor: top.pointsFor,
            seasons: top.seasons,
            playoffAppearances: top.playoffAppearances,
          };
        })()
      : undefined;

  // A departed manager's drought is meaningless for the piece ("Ryan Granda hasn't won since
  // 2020" - he left the league in 2022): prefer the longest drought among CURRENT managers
  // (those with a `currentTeamId`) and only fall back to any past champion, flagged in `notes`
  // below, when no manager still in the league has ever actually won a title.
  const pastChampions = managers.filter((m) => m.titles.length > 0 && m.yearsSinceTitle !== undefined);
  const currentPastChampions = pastChampions.filter((m) => m.currentTeamId);
  const droughtPool = currentPastChampions.length > 0 ? currentPastChampions : pastChampions;
  const noCurrentManagerHasWonTitle = pastChampions.length > 0 && currentPastChampions.length === 0;
  const longestDrought =
    droughtPool.length > 0
      ? (() => {
          const top = [...droughtPool].sort((a, b) => (b.yearsSinceTitle! - a.yearsSinceTitle!))[0];
          return {
            manager: top.manager,
            currentTeamId: top.currentTeamId,
            yearsSinceTitle: top.yearsSinceTitle!,
            lastTitle: Math.max(...top.titles),
          };
        })()
      : undefined;

  const neverWon = [...titlelessManagers]
    .sort((a, b) => (a.currentTeamId ? 0 : 1) - (b.currentTeamId ? 0 : 1) || b.seasons - a.seasons)
    .map((m) => ({
      manager: m.manager,
      currentTeamId: m.currentTeamId,
      seasons: m.seasons,
      playoffAppearances: m.playoffAppearances,
      runnerUps: m.runnerUps.length,
    }));

  // Same preference as the drought above: a current manager's bridesmaid streak is the one
  // worth needling; a departed manager's is only surfaced when no current manager qualifies.
  const bridesmaids = titlelessManagers.filter((m) => m.runnerUps.length > 0);
  const currentBridesmaids = bridesmaids.filter((m) => m.currentTeamId);
  const bridesmaidsPool = currentBridesmaids.length > 0 ? currentBridesmaids : bridesmaids;
  const alwaysTheBridesmaid =
    bridesmaidsPool.length > 0
      ? (() => {
          const top = [...bridesmaidsPool].sort((a, b) => b.runnerUps.length - a.runnerUps.length)[0];
          return { manager: top.manager, currentTeamId: top.currentTeamId, runnerUps: top.runnerUps.length };
        })()
      : undefined;

  const neverMadePlayoffs = managers
    .filter((m) => m.playoffAppearances === 0 && m.seasons > 0)
    .map((m) => ({ manager: m.manager, currentTeamId: m.currentTeamId, seasons: m.seasons }));

  const withLastPlaces = managers.filter((m) => m.lastPlaceFinishes.length > 0);
  const currentWithLastPlaces = withLastPlaces.filter((m) => m.currentTeamId);
  const lastPlacesPool = currentWithLastPlaces.length > 0 ? currentWithLastPlaces : withLastPlaces;
  const mostLastPlaces =
    lastPlacesPool.length > 0
      ? (() => {
          const top = [...lastPlacesPool].sort((a, b) => b.lastPlaceFinishes.length - a.lastPlaceFinishes.length)[0];
          return { manager: top.manager, currentTeamId: top.currentTeamId, count: top.lastPlaceFinishes.length, seasons: top.lastPlaceFinishes };
        })()
      : undefined;

  /* ---------------------------------------------------------------------- *
   * Rivalries (current managers only)
   * ---------------------------------------------------------------------- */

  interface RivalryGame { season: number; week: number; winnerKey?: string; aScore: number; bScore: number }
  interface RivalryAgg { aKey: string; bKey: string; games: RivalryGame[] }
  const rivalryMap = new Map<string, RivalryAgg>();
  const currentManagerKeys = new Set(managers.filter((m) => m.currentTeamId).map((m) => m.key));

  for (const m of completedGames) {
    const home = findTeam(m.season, m.homeTeamId);
    const away = findTeam(m.season, m.awayTeamId);
    if (!home || !away) continue;
    const hk = home.managerKey;
    const ak = away.managerKey;
    if (hk === ak) continue;
    if (!currentManagerKeys.has(hk) || !currentManagerKeys.has(ak)) continue;
    const key = [hk, ak].sort().join("|");
    let agg = rivalryMap.get(key);
    if (!agg) {
      agg = { aKey: hk, bKey: ak, games: [] };
      rivalryMap.set(key, agg);
    }
    const aIsHome = hk === agg.aKey;
    const aScore = aIsHome ? m.homeScore : m.awayScore;
    const bScore = aIsHome ? m.awayScore : m.homeScore;
    const winnerKey = aScore === bScore ? undefined : aScore > bScore ? agg.aKey : agg.bKey;
    agg.games.push({ season: m.season, week: m.week, winnerKey, aScore, bScore });
  }

  const rivalries: AlmanacRivalry[] = [];
  for (const agg of rivalryMap.values()) {
    const games = [...agg.games].sort((x, y) => x.season - y.season || x.week - y.week);
    const managerA = managerByKey.get(agg.aKey);
    const managerB = managerByKey.get(agg.bKey);
    if (!managerA || !managerB) continue;
    const aWins = games.filter((g) => g.winnerKey === agg.aKey).length;
    const bWins = games.filter((g) => g.winnerKey === agg.bKey).length;
    const ties = games.filter((g) => g.winnerKey === undefined).length;

    const last = games[games.length - 1];
    const lastMeeting = last
      ? {
          season: last.season,
          week: last.week,
          winnerManager: last.winnerKey ? (last.winnerKey === agg.aKey ? managerA.manager : managerB.manager) : "tie",
          margin: round1(Math.abs(last.aScore - last.bScore)),
        }
      : undefined;

    let streakKey: string | undefined;
    let streakCount = 0;
    for (let i = games.length - 1; i >= 0; i--) {
      const g = games[i];
      if (!g.winnerKey) break;
      if (streakKey === undefined) {
        streakKey = g.winnerKey;
        streakCount = 1;
      } else if (g.winnerKey === streakKey) {
        streakCount++;
      } else break;
    }
    const currentStreak = streakKey
      ? { manager: streakKey === agg.aKey ? managerA.manager : managerB.manager, wins: streakCount }
      : undefined;

    rivalries.push({
      a: { managerKey: agg.aKey, manager: managerA.manager, currentTeamId: managerA.currentTeamId },
      b: { managerKey: agg.bKey, manager: managerB.manager, currentTeamId: managerB.currentTeamId },
      games: games.length,
      aWins,
      bWins,
      ties,
      lastMeeting,
      currentStreak,
    });
  }
  rivalries.sort((x, y) => y.games - x.games || Math.abs(y.aWins - y.bWins) - Math.abs(x.aWins - x.bWins));
  const topRivalries = rivalries.slice(0, 5);

  /* ---------------------------------------------------------------------- *
   * Drafts
   * ---------------------------------------------------------------------- */

  const drafts: AlmanacDraftReceipts[] = [];
  for (const seasonInput of input.seasons) {
    if (!seasonInput.draft || seasonInput.draft.length === 0) continue;
    const season = seasonInput.season;
    const firstRoundPicks = [...seasonInput.draft].filter((p) => p.roundId === 1).sort((a, b) => a.overallPickNumber - b.overallPickNumber);
    if (firstRoundPicks.length === 0) continue;

    const seasonTeams = teamsBySeason.get(season) ?? [];
    const teamByExternalId = new Map(seasonTeams.map((t) => [t.externalId, t]));
    const seasonResult = seasonResultsBySeason.get(season);
    const playoffTeamIds = playoffTeamIdsBySeason.get(season) ?? new Set<string>();
    const playoffCount = playoffTeamCountFor(season);

    const picksOut: AlmanacDraftReceiptPick[] = firstRoundPicks.map((p) => {
      const teamExternalId = String(p.teamId);
      const playerId = String(p.playerId);
      const team = teamByExternalId.get(teamExternalId);
      const player = (input.players ?? []).find((pl) => pl.season === season && pl.playerId === playerId);
      const teamFinish = team
        ? {
            record: recordStr(team.wins, team.losses, team.ties),
            madePlayoffs: (team.playoffSeed !== undefined && team.playoffSeed <= playoffCount) || playoffTeamIds.has(teamExternalId),
            champion: teamExternalId === seasonResult?.championId,
          }
        : undefined;
      return {
        pick: p.overallPickNumber,
        round: p.roundId,
        teamId: `T${teamExternalId}`,
        team: team?.name ?? teamExternalId,
        manager: team?.manager ?? "Unknown",
        player: player?.name ?? `Player ${playerId}`,
        pos: player?.pos,
        seasonPoints: player?.seasonPoints,
        teamFinish,
      };
    });

    const withPoints = picksOut.filter((p) => p.seasonPoints !== undefined);
    const ranked = [...withPoints].sort((a, b) => b.seasonPoints! - a.seasonPoints!);
    const rankByPick = new Map(ranked.map((p, i) => [p.pick, i + 1]));
    for (const p of picksOut) {
      if (p.seasonPoints !== undefined) p.firstRoundRank = rankByPick.get(p.pick);
    }

    const titlePick = seasonResult?.championId ? picksOut.find((p) => p.teamId === `T${seasonResult.championId}`) : undefined;

    let best: AlmanacDraftReceiptPick | undefined;
    let worst: AlmanacDraftReceiptPick | undefined;
    if (picksOut.length > 0 && withPoints.length / picksOut.length >= 0.6) {
      best = [...withPoints].sort((a, b) => b.seasonPoints! - a.seasonPoints!)[0];
      worst = [...withPoints].sort((a, b) => a.seasonPoints! - b.seasonPoints!)[0];
    }

    drafts.push({ season, firstRound: picksOut, titlePick, best, worst });
  }

  /* ---------------------------------------------------------------------- *
   * Notes
   * ---------------------------------------------------------------------- */

  const notes: string[] = [];

  if (noCurrentManagerHasWonTitle) notes.push("no current manager has won a title");

  const currentTeamCount = teamsBySeason.get(input.currentSeason)?.length;
  if (currentTeamCount !== undefined) {
    for (const season of seasonsCovered) {
      const count = teamCountForSeason(season);
      if (count !== currentTeamCount && count > 0) {
        const word = spellNumber(count);
        notes.push(`${season} was ${article(word)} ${word}-team season.`);
      }
    }
  }

  const draftSeasons = input.seasons.filter((s) => s.draft && s.draft.length > 0).map((s) => s.season).sort((a, b) => a - b);
  notes.push(
    draftSeasons.length === 0
      ? "no draft data on record"
      : `draft data on record for ${formatSeasonList(draftSeasons)} only`
  );

  for (const season of seasonsCovered) {
    const seasonRegularScores = regularSeasonEntries.filter((e) => e.season === season).map((e) => e.score);
    if (seasonRegularScores.length === 0) continue;
    const avg = seasonRegularScores.reduce((a, b) => a + b, 0) / seasonRegularScores.length;
    const bracketGamesThisSeason = input.matchups.filter(
      (m) => m.season === season && m.playoffTier !== undefined && m.playoffTier !== "NONE" && !isByeRow(m)
    );
    // 2.0x, not 1.6x (owner correction, prod ratios measured against real seasons): a legitimate
    // single-week explosion can land at 1.65x (2025's 217.6-point week) or 1.54x (2022) without
    // being a two-week bracket total: only an actual multi-week total (2020's 329-point game,
    // 2.66x) should ever be flagged.
    const hasMultiWeekScores = bracketGamesThisSeason.some((m) => m.homeScore > avg * 2.0 || m.awayScore > avg * 2.0);
    if (hasMultiWeekScores) notes.push(`playoff-round scores in ${season} are multi-week totals`);
  }

  /* ---------------------------------------------------------------------- *
   * Assemble
   * ---------------------------------------------------------------------- */

  return {
    schema: "ffsn.almanac.v1",
    currentSeason: input.currentSeason,
    foundedSeason,
    seasonsCovered,
    seasons: seasonsOut,
    managers,
    curseBoard: {
      mostPointsNoTitle,
      longestDrought,
      neverWon,
      alwaysTheBridesmaid,
      neverMadePlayoffs,
      mostLastPlaces,
    },
    records: {
      biggestBlowout,
      closestGame,
      highestScore,
      lowestScore,
      bestRegularSeason: bestRegularSeason ? { ...bestRegularSeason.line, manager: bestRegularSeason.manager } : undefined,
      worstRegularSeason: worstRegularSeason ? { ...worstRegularSeason.line, manager: worstRegularSeason.manager } : undefined,
      mostPointsInASeason: mostPointsInASeason ? { ...mostPointsInASeason.line, manager: mostPointsInASeason.manager } : undefined,
      mostTitles,
      backToBack,
    },
    rivalries: topRivalries,
    drafts,
    notes,
  };
}

/**
 * One manager's all-time line, for a preseason interview where there is no matchup and no
 * record yet: "33-50 all-time over six seasons, no title, six playoff trips, best 8-6 in 2021
 * as Lemon Party, worst 3-10 in 2020". `undefined` when the manager is not in the almanac.
 */
export function almanacLineFor(almanac: LeagueAlmanac, managerKey: string): string | undefined {
  const manager = almanac.managers.find((m) => m.key === managerKey);
  if (!manager) return undefined;

  const parts: string[] = [];
  parts.push(`${manager.record} all-time over ${spellNumber(manager.seasons)} season${manager.seasons === 1 ? "" : "s"}`);

  if (manager.titles.length === 0) parts.push("no title");
  else if (manager.titles.length === 1) parts.push(`one title (${manager.titles[0]})`);
  else parts.push(`${spellNumber(manager.titles.length)} titles (${manager.titles.join(", ")})`);

  if (manager.playoffAppearances === 0) parts.push("no playoff trips");
  else if (manager.playoffAppearances === 1) parts.push("one playoff trip");
  else parts.push(`${spellNumber(manager.playoffAppearances)} playoff trips`);

  if (manager.bestSeason) parts.push(`best ${manager.bestSeason.record} in ${manager.bestSeason.season} as ${manager.bestSeason.team}`);
  if (manager.worstSeason) parts.push(`worst ${manager.worstSeason.record} in ${manager.worstSeason.season}`);

  return parts.join(", ");
}
