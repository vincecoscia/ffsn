/**
 * A hand-built League Almanac for tests and fixtures (Season Kickoff rebuild, 2026-09-06).
 *
 * `buildAlmanac` in `src/lib/ai/almanac.ts` is the Convex side's job; the prompt layer only ever
 * reads a finished `LeagueAlmanac`, so its tests construct one by hand. This generator produces a
 * deterministic, fully populated almanac for any (seasons x teams) shape - every optional field is
 * filled, so a size test measures the worst case - using the same invented Ironclad Fantasy
 * Conference managers the other fixtures use. Nothing here is a real league, manager or player.
 *
 * Shape: `teams` current managers, one of whom replaced a departed manager after the first three
 * seasons (so `managers[]` carries a `NO LONGER IN THE LEAGUE` entry), the first manager changing
 * team name every season, one title every season, a four-seed winning every fourth season (the
 * "unlikely champion"), drafts stored for the last two seasons only.
 */

import type {
  AlmanacDraftReceiptPick,
  AlmanacDraftReceipts,
  AlmanacGame,
  AlmanacManager,
  AlmanacRivalry,
  AlmanacSeason,
  AlmanacSeasonLine,
  AlmanacTeamRef,
  LeagueAlmanac,
} from "../almanac";

export const SAMPLE_MANAGERS = [
  "Dana Whitlock",
  "Marcus Bly",
  "Priya Nandi",
  "Trevor Ashby",
  "Lena Okafor",
  "Sam Kestrel",
  "Owen Radcliffe",
  "Bea Coleridge",
  "Hollis Vance",
  "Ruth Tanaka",
  "Felix Marrow",
  "Ines Calloway",
] as const;

export const SAMPLE_TEAMS = [
  "Gravel Pit Grinders",
  "Cedar Falls Cormorants",
  "Quarry Road Quakers",
  "Ninth Street Nightjars",
  "Halyard Bay Harriers",
  "Foundry District Foxes",
  "Milltown Mudlarks",
  "Ashgrove Anvils",
  "Pike County Pilots",
  "Sable Ridge Sentinels",
  "Tidewater Terns",
  "Copperline Kestrels",
] as const;

/** The first manager's team name by season, so "six team names" is a real line in the ledger. */
const GRINDERS_ALIASES = [
  "Gravel Pit Grinders",
  "Whitlock's Wreckers",
  "Gravel Pit Gravy",
  "Dana's Dynasty",
  "The Gravel Pit",
  "Grinders Reloaded",
  "Gravel Pit Grinders",
];

/** Invented first-round players, one per pick slot. Not real people. */
const DRAFT_PLAYERS = [
  ["Bo Larkin", "RB"],
  ["Teddy Vance", "WR"],
  ["Cyrus Mott", "RB"],
  ["Elias Brandt", "WR"],
  ["Jonah Pike", "RB"],
  ["Silas Crane", "WR"],
  ["Rafe Delgado", "TE"],
  ["Ansel Moore", "RB"],
  ["Deacon Ruiz", "WR"],
  ["Milo Hartigan", "QB"],
  ["Otis Fenwick", "RB"],
  ["Wade Kessler", "WR"],
] as const;

const GAMES_PER_SEASON = 14;
const round1 = (value: number) => Math.round(value * 10) / 10;

export interface SampleAlmanacOptions {
  seasons: number;
  teams: number;
  currentSeason?: number;
}

function record(wins: number, losses: number, ties = 0): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

/** Wins for the k-th best team of n: 11 down to 3 for ten teams, always averaging 7. */
function winsForRank(rank: number, teams: number): number {
  return 3 + Math.round((8 * (teams - 1 - rank)) / Math.max(1, teams - 1));
}

interface SeasonTeam {
  season: number;
  managerIndex: number;
  externalId: string;
  team: string;
  rank: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
}

export function sampleAlmanac(options: SampleAlmanacOptions): LeagueAlmanac {
  const { seasons: seasonCount, teams: teamCount } = options;
  const currentSeason = options.currentSeason ?? 2026;
  const firstSeason = currentSeason - seasonCount;
  const seasonsCovered = Array.from({ length: seasonCount }, (_, i) => firstSeason + i);
  const playoffTeamCount = Math.max(2, Math.floor(teamCount / 2));
  // The last slot was a departed manager for the first three seasons when there are that many.
  const departedIndex = teamCount; // SAMPLE_MANAGERS[teamCount] is the departed one
  const replacedSlot = teamCount - 1;
  const hasDeparted = seasonCount > 3 && teamCount < SAMPLE_MANAGERS.length;

  const managerFor = (season: number, slot: number): number => {
    if (hasDeparted && slot === replacedSlot && season - firstSeason < 3) return departedIndex;
    return slot;
  };
  const teamNameFor = (season: number, slot: number, managerIndex: number): string => {
    if (slot === 0) return GRINDERS_ALIASES[(season - firstSeason) % GRINDERS_ALIASES.length];
    if (managerIndex === departedIndex) return SAMPLE_TEAMS[SAMPLE_TEAMS.length - 1];
    return SAMPLE_TEAMS[slot];
  };

  // --- Every season's table ---------------------------------------------------------------
  const tables: SeasonTeam[][] = seasonsCovered.map((season, i) => {
    const rows: SeasonTeam[] = [];
    for (let slot = 0; slot < teamCount; slot++) {
      const rank = (slot + i) % teamCount;
      const wins = winsForRank(rank, teamCount);
      const managerIndex = managerFor(season, slot);
      rows.push({
        season,
        managerIndex,
        externalId: String(slot + 1),
        team: teamNameFor(season, slot, managerIndex),
        rank,
        wins,
        losses: GAMES_PER_SEASON - wins,
        pointsFor: round1(1500 + wins * 25 + slot * 3.3 + i * 1.1),
        pointsAgainst: round1(1500 + (GAMES_PER_SEASON - wins) * 20 + slot * 2.1),
      });
    }
    return rows;
  });

  const ref = (row: SeasonTeam, withSeed = false): AlmanacTeamRef => ({
    teamId: `T${row.externalId}`,
    team: row.team,
    managerKey: `m${row.managerIndex}`,
    manager: SAMPLE_MANAGERS[row.managerIndex],
    record: record(row.wins, row.losses),
    pointsFor: row.pointsFor,
    seed: withSeed ? row.rank + 1 : undefined,
  });

  const byRank = (table: SeasonTeam[], rank: number): SeasonTeam => table.find(row => row.rank === rank)!;

  // --- Seasons -----------------------------------------------------------------------------
  const finals: AlmanacGame[] = [];
  const seasons: AlmanacSeason[] = tables.map((table, i) => {
    const season = seasonsCovered[i];
    const championRank = Math.min(i % 4, playoffTeamCount - 1);
    const champion = byRank(table, championRank);
    const runnerUpRank = championRank === 0 ? 1 : 0;
    const runnerUp = byRank(table, runnerUpRank);
    const winnerScore = round1(139.4 + i * 2.3);
    const loserScore = round1(96.7 + i * 3.1 + championRank);
    const margin = round1(winnerScore - loserScore);
    const week = GAMES_PER_SEASON + 3;
    finals.push({
      season,
      week,
      playoffTier: "WINNERS_BRACKET",
      winner: { team: champion.team, manager: SAMPLE_MANAGERS[champion.managerIndex], score: winnerScore },
      loser: { team: runnerUp.team, manager: SAMPLE_MANAGERS[runnerUp.managerIndex], score: loserScore },
      margin,
    });
    return {
      season,
      teamCount,
      champion: ref(champion, true),
      runnerUp: ref(runnerUp, true),
      regularSeasonChampion: ref(byRank(table, 0), true),
      lastPlace: ref(byRank(table, teamCount - 1)),
      topScorer: ref(byRank(table, 1)),
      final: { winner: ref(champion, true), loser: ref(runnerUp, true), winnerScore, loserScore, margin, week },
      unlikelyChampion: championRank >= 3 ? { reason: `won the title as the No. ${championRank + 1} seed` } : undefined,
    };
  });

  // --- Managers ----------------------------------------------------------------------------
  const managerIndexes = new Set<number>();
  tables.flat().forEach(row => managerIndexes.add(row.managerIndex));
  const lastSeason = seasonsCovered[seasonsCovered.length - 1];

  const managers: AlmanacManager[] = [...managerIndexes].map(index => {
    const rows = tables.flat().filter(row => row.managerIndex === index);
    const lines: AlmanacSeasonLine[] = rows.map(row => {
      const seasonEntry = seasons.find(entry => entry.season === row.season)!;
      return {
        season: row.season,
        team: row.team,
        record: record(row.wins, row.losses),
        pointsFor: row.pointsFor,
        finish: row.rank + 1,
        madePlayoffs: row.rank < playoffTeamCount,
        champion: seasonEntry.champion?.teamId === `T${row.externalId}`,
        runnerUp: seasonEntry.runnerUp?.teamId === `T${row.externalId}`,
      };
    });
    const wins = rows.reduce((sum, row) => sum + row.wins, 0);
    const losses = rows.reduce((sum, row) => sum + row.losses, 0);
    const pointsFor = round1(rows.reduce((sum, row) => sum + row.pointsFor, 0));
    const pointsAgainst = round1(rows.reduce((sum, row) => sum + row.pointsAgainst, 0));
    const titles = lines.filter(line => line.champion).map(line => line.season);
    const runnerUps = lines.filter(line => line.runnerUp).map(line => line.season);
    const regularSeasonTitles = lines.filter(line => line.finish === 1).map(line => line.season);
    const lastPlaceFinishes = lines.filter(line => line.finish === teamCount).map(line => line.season);
    let playoffStreak = 0;
    for (let i = lines.length - 1; i >= 0 && lines[i].madePlayoffs; i--) playoffStreak++;
    if (lines[lines.length - 1].season !== lastSeason) playoffStreak = 0;
    const best = [...lines].sort((a, b) => a.finish - b.finish || b.pointsFor - a.pointsFor)[0];
    const worst = [...lines].sort((a, b) => b.finish - a.finish || a.pointsFor - b.pointsFor)[0];
    const current = rows.some(row => row.season === lastSeason) && index !== departedIndex;
    const teamNames = [...new Set(rows.map(row => row.team))];
    const lastTitle = titles.length > 0 ? titles[titles.length - 1] : undefined;
    return {
      key: `m${index}`,
      manager: SAMPLE_MANAGERS[index],
      currentTeamId: current ? `T${rows[rows.length - 1].externalId}` : undefined,
      currentTeam: current ? SAMPLE_TEAMS[Number(rows[rows.length - 1].externalId) - 1] : undefined,
      seasons: rows.length,
      firstSeason: rows[0].season,
      lastSeason: rows[rows.length - 1].season,
      wins,
      losses,
      ties: 0,
      record: record(wins, losses),
      winPct: Math.round((wins / (wins + losses)) * 1000) / 1000,
      pointsFor,
      pointsAgainst,
      pointsPerGame: round1(pointsFor / (wins + losses)),
      titles,
      runnerUps,
      regularSeasonTitles,
      playoffAppearances: lines.filter(line => line.madePlayoffs).length,
      playoffStreak,
      lastPlaceFinishes,
      bestSeason: best,
      worstSeason: worst,
      yearsSinceTitle: lastTitle === undefined ? undefined : lastSeason - lastTitle,
      teamNames,
      lines,
    };
  });
  managers.sort((a, b) => b.titles.length - a.titles.length || b.wins - a.wins);

  // --- Curse board --------------------------------------------------------------------------
  const currentRef = (manager: AlmanacManager) => ({ manager: manager.manager, currentTeamId: manager.currentTeamId });
  const untitled = managers.filter(manager => manager.titles.length === 0);
  const titled = managers.filter(manager => manager.titles.length > 0 && manager.yearsSinceTitle !== undefined);
  const mostPointsNoTitle = [...untitled].sort((a, b) => b.pointsFor - a.pointsFor)[0];
  const longestDrought = [...titled].sort((a, b) => (b.yearsSinceTitle ?? 0) - (a.yearsSinceTitle ?? 0))[0];
  const bridesmaid = [...untitled].sort((a, b) => b.runnerUps.length - a.runnerUps.length)[0];
  const mostLastPlaces = [...managers].sort((a, b) => b.lastPlaceFinishes.length - a.lastPlaceFinishes.length)[0];

  // --- Record book ---------------------------------------------------------------------------
  const allLines = managers.flatMap(manager => manager.lines.map(line => ({ ...line, manager: manager.manager })));
  const biggestBlowout = [...finals].sort((a, b) => b.margin - a.margin)[0];
  const closestGame = [...finals].sort((a, b) => a.margin - b.margin)[0];
  const bestRegularSeason = [...allLines].sort((a, b) => a.finish - b.finish || b.pointsFor - a.pointsFor)[0];
  const worstRegularSeason = [...allLines].sort((a, b) => b.finish - a.finish || a.pointsFor - b.pointsFor)[0];
  const mostPointsInASeason = [...allLines].sort((a, b) => b.pointsFor - a.pointsFor)[0];
  const backToBack: Array<{ manager: string; seasons: number[] }> = [];
  for (const manager of managers) {
    const run: number[] = [];
    for (const title of manager.titles) {
      if (run.length > 0 && title === run[run.length - 1] + 1) run.push(title);
      else {
        if (run.length > 1) backToBack.push({ manager: manager.manager, seasons: [...run] });
        run.length = 0;
        run.push(title);
      }
    }
    if (run.length > 1) backToBack.push({ manager: manager.manager, seasons: [...run] });
  }
  const topScorerRow = tables.flat().sort((a, b) => b.pointsFor - a.pointsFor)[0];
  const lowScorerRow = tables.flat().sort((a, b) => a.pointsFor - b.pointsFor)[0];

  // --- Rivalries: five pairs among current managers ------------------------------------------
  const current = managers.filter(manager => manager.currentTeamId !== undefined);
  const rivalries: AlmanacRivalry[] = [];
  for (let i = 0; i < Math.min(5, Math.floor(current.length / 2) * 2, current.length - 1); i++) {
    const a = current[i];
    const b = current[(i + 1) % current.length];
    const games = seasonCount * 2;
    const aWins = Math.floor(games / 2) + (i % 2 === 0 ? 2 : -1);
    rivalries.push({
      a: { managerKey: a.key, manager: a.manager, currentTeamId: a.currentTeamId },
      b: { managerKey: b.key, manager: b.manager, currentTeamId: b.currentTeamId },
      games,
      aWins,
      bWins: games - aWins,
      ties: 0,
      lastMeeting: { season: lastSeason, week: 12 - i, winnerManager: i % 2 === 0 ? a.manager : b.manager, margin: round1(12.6 + i * 4.4) },
      currentStreak: { manager: i % 2 === 0 ? a.manager : b.manager, wins: 2 + (i % 3) },
    });
  }

  // --- Draft receipts for the last two seasons -----------------------------------------------
  const drafts: AlmanacDraftReceipts[] = tables.slice(-2).map(table => {
    const season = table[0].season;
    const seasonEntry = seasons.find(entry => entry.season === season)!;
    const firstRound: AlmanacDraftReceiptPick[] = table.map((row, slot) => {
      const [player, pos] = DRAFT_PLAYERS[slot % DRAFT_PLAYERS.length];
      return {
        pick: slot + 1,
        round: 1,
        teamId: `T${row.externalId}`,
        team: row.team,
        manager: SAMPLE_MANAGERS[row.managerIndex],
        player,
        pos,
        seasonPoints: round1(310.5 - slot * 17.3 + (row.rank % 3) * 9.9),
        firstRoundRank: 0,
        teamFinish: { record: record(row.wins, row.losses), madePlayoffs: row.rank < playoffTeamCount, champion: seasonEntry.champion?.teamId === `T${row.externalId}` },
      };
    });
    const ranked = [...firstRound].sort((a, b) => (b.seasonPoints ?? 0) - (a.seasonPoints ?? 0));
    ranked.forEach((pick, index) => {
      pick.firstRoundRank = index + 1;
    });
    return {
      season,
      firstRound,
      titlePick: firstRound.find(pick => pick.teamFinish?.champion),
      best: ranked[0],
      worst: ranked[ranked.length - 1],
    };
  });

  return {
    schema: "ffsn.almanac.v1",
    currentSeason,
    foundedSeason: firstSeason,
    seasonsCovered,
    seasons,
    managers,
    curseBoard: {
      mostPointsNoTitle: mostPointsNoTitle
        ? { ...currentRef(mostPointsNoTitle), pointsFor: mostPointsNoTitle.pointsFor, seasons: mostPointsNoTitle.seasons, playoffAppearances: mostPointsNoTitle.playoffAppearances }
        : undefined,
      longestDrought: longestDrought
        ? { ...currentRef(longestDrought), yearsSinceTitle: longestDrought.yearsSinceTitle ?? 0, lastTitle: longestDrought.titles[longestDrought.titles.length - 1] }
        : undefined,
      neverWon: untitled.map(manager => ({ ...currentRef(manager), seasons: manager.seasons, playoffAppearances: manager.playoffAppearances, runnerUps: manager.runnerUps.length })),
      alwaysTheBridesmaid: bridesmaid && bridesmaid.runnerUps.length > 0 ? { ...currentRef(bridesmaid), runnerUps: bridesmaid.runnerUps.length } : undefined,
      neverMadePlayoffs: managers.filter(manager => manager.playoffAppearances === 0).map(manager => ({ ...currentRef(manager), seasons: manager.seasons })),
      mostLastPlaces: mostLastPlaces && mostLastPlaces.lastPlaceFinishes.length > 0
        ? { ...currentRef(mostLastPlaces), count: mostLastPlaces.lastPlaceFinishes.length, seasons: mostLastPlaces.lastPlaceFinishes }
        : undefined,
    },
    records: {
      biggestBlowout,
      closestGame,
      highestScore: { season: topScorerRow.season, week: 9, team: topScorerRow.team, manager: SAMPLE_MANAGERS[topScorerRow.managerIndex], score: round1(topScorerRow.pointsFor / 9.1) },
      lowestScore: { season: lowScorerRow.season, week: 4, team: lowScorerRow.team, manager: SAMPLE_MANAGERS[lowScorerRow.managerIndex], score: round1(lowScorerRow.pointsFor / 31.7) },
      bestRegularSeason,
      worstRegularSeason,
      mostPointsInASeason,
      mostTitles: { manager: managers[0].manager, count: managers[0].titles.length, seasons: managers[0].titles },
      backToBack,
    },
    rivalries,
    drafts,
    notes: [
      `Every points total is this league's own scoring, rounded to a tenth.`,
      `No draft data before ${drafts[0]?.season ?? lastSeason}.`,
    ],
  };
}
