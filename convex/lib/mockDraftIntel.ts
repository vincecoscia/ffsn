/**
 * The pure half of the mock-draft payload (owner ask, 2026-09-05: a mock draft has to know ADP,
 * the draft order, the draft type, the league type and the team count, and should carry real
 * player information - and Mel needs receipts for his hot takes).
 *
 * `aiQueries.getMockDraftDataForAI` loads the rows and calls these; nothing here touches the
 * database, so every rule is unit-tested in tests/mockDraftIntel.test.ts.
 */

export interface PoolSource {
  espnId: string;
  fullName: string;
  defaultPosition: string;
  proTeamAbbrev?: string;
  adp: number;
  injured?: boolean;
  injuryStatus?: string;
  seasonOutlook?: string;
  projected?: { total: number; average: number } | null;
}

export interface PoolPlayer {
  playerId: string;
  playerName: string;
  position: string;
  proTeam: string;
  nflTeam?: string;
  /** ESPN average draft position. */
  adp: number;
  /** 1 = the first player at the position by ADP. */
  adpPositionRank: number;
  /** Overall ADP rank in this pool (1 = earliest). */
  adpRank: number;
  /** Only when the status is not ACTIVE: QUESTIONABLE, OUT, INJURY_RESERVE, SUSPENSION, DAY_TO_DAY. */
  injuryStatus?: string;
  seasonOutlook: string;
  projectedStats: { projectedTotal: number; projectedAverage: number } | null;
  ownership: { averageDraftPosition: number };
  recentNews?: Array<{ headline: string; published: string }>;
}

/** How many players carry ESPN's full season outlook; the rest get one line. */
export const OUTLOOK_DEPTH = 60;
export const POOL_SIZE = 200;

/**
 * The first sentence, capped at `max`. A sentence ends at ".", "!" or "?" followed by a space and
 * a capital (or the end of the text), so "Jr. Smith" and "a 3.9 average" do not end one.
 */
function firstSentence(text: string, max = 180): string {
  const trimmed = text.trim();
  const sentence = /^([\s\S]{12,}?[.!?])(?=\s+[A-Z"“(]|$)/.exec(trimmed)?.[1];
  const candidate = sentence ?? trimmed;
  if (candidate.length <= max) return candidate;
  const cut = candidate.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(", "));
  return (end > 60 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`).trim();
}

/**
 * The draft pool: sorted by ADP, with positional and overall ADP ranks, the injury status when
 * it is anything but ACTIVE, the full outlook for the first `OUTLOOK_DEPTH` and a one-line
 * outlook after that.
 */
export function buildDraftPool(sources: PoolSource[], poolSize = POOL_SIZE): PoolPlayer[] {
  const sorted = [...sources].filter((p) => p.adp > 0).sort((a, b) => a.adp - b.adp).slice(0, poolSize);
  const positionCounters = new Map<string, number>();
  return sorted.map((p, index) => {
    const pos = (p.defaultPosition || "FLEX").toUpperCase();
    const posRank = (positionCounters.get(pos) ?? 0) + 1;
    positionCounters.set(pos, posRank);
    const status = p.injuryStatus && p.injuryStatus !== "ACTIVE" ? p.injuryStatus : undefined;
    const outlook = p.seasonOutlook?.trim() ?? "";
    return {
      playerId: p.espnId,
      playerName: p.fullName,
      position: pos,
      proTeam: p.proTeamAbbrev || "",
      nflTeam: p.proTeamAbbrev || undefined,
      adp: Math.round(p.adp * 10) / 10,
      adpPositionRank: posRank,
      adpRank: index + 1,
      injuryStatus: status,
      seasonOutlook: index < OUTLOOK_DEPTH ? outlook : outlook ? firstSentence(outlook) : "",
      projectedStats: p.projected
        ? { projectedTotal: p.projected.total, projectedAverage: p.projected.average }
        : null,
      ownership: { averageDraftPosition: p.adp },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Last year's draft, per manager                                              */
/* -------------------------------------------------------------------------- */

export interface PriorPick {
  teamName: string;
  pickNumber: number;
  roundNumber: number;
  roundPickNumber: number;
  playerName: string;
  playerPosition: string;
  playerADP: number | null;
}

export interface DraftTendency {
  /** This season's team, resolved by ESPN team id; the name is this season's. */
  teamId: string;
  teamName: string;
  manager: string;
  /** Overall slot in this season's draft order, when set. */
  draftSlot?: number;
  lastSeasonRecord?: string;
  lastSeasonRank?: number;
  /** "1.05 Jahmyr Gibbs (RB)" x3 */
  firstThree: string[];
  /** "RB-RB-WR" */
  positionalStart: string;
  firstQbRound?: number;
  firstTeRound?: number;
  /** Drafted the furthest ahead of ADP (delta = ADP - pick, positive). */
  biggestReach?: { player: string; pos: string; pick: number; adp: number; delta: number };
  /** Drafted the furthest behind ADP. */
  bestValue?: { player: string; pos: string; pick: number; adp: number; delta: number };
  /** Picks by position, e.g. { RB: 5, WR: 6 }. */
  positionCounts: Record<string, number>;
}

/** A near-constant ADP column means ESPN gave us no ADP for that draft; ignore it. */
export function adpIsUsable(picks: PriorPick[]): boolean {
  const values = picks.map((p) => p.playerADP).filter((v): v is number => typeof v === "number" && v > 0);
  if (values.length < Math.max(3, picks.length / 2)) return false;
  return new Set(values.map((v) => Math.round(v))).size > 2;
}

export function buildDraftTendencies(args: {
  picks: PriorPick[];
  /** Last season's team name -> ESPN team id (the franchise key across seasons). */
  priorTeamIdByName: Map<string, string>;
  /** This season's teams by ESPN team id. */
  currentTeams: Array<{ externalId: string; name: string; manager: string; draftSlot?: number }>;
  lastSeason?: Map<string, { record: string; rank: number }>;
}): DraftTendency[] {
  const { picks, priorTeamIdByName, currentTeams } = args;
  const usable = adpIsUsable(picks);
  const byTeamId = new Map<string, PriorPick[]>();
  for (const pick of picks) {
    const teamId = priorTeamIdByName.get(pick.teamName);
    if (!teamId) continue;
    const bucket = byTeamId.get(teamId) ?? [];
    bucket.push(pick);
    byTeamId.set(teamId, bucket);
  }

  const tendencies: DraftTendency[] = [];
  for (const team of currentTeams) {
    const teamPicks = (byTeamId.get(team.externalId) ?? []).sort((a, b) => a.pickNumber - b.pickNumber);
    if (teamPicks.length === 0) continue;
    const label = (p: PriorPick) => `${p.roundNumber}.${String(p.roundPickNumber).padStart(2, "0")} ${p.playerName} (${p.playerPosition})`;
    const firstThree = teamPicks.slice(0, 3).map(label);
    const positionalStart = teamPicks.slice(0, 3).map((p) => p.playerPosition).join("-");
    const firstQbRound = teamPicks.find((p) => p.playerPosition === "QB")?.roundNumber;
    const firstTeRound = teamPicks.find((p) => p.playerPosition === "TE")?.roundNumber;
    const positionCounts: Record<string, number> = {};
    for (const p of teamPicks) positionCounts[p.playerPosition] = (positionCounts[p.playerPosition] ?? 0) + 1;

    let biggestReach: DraftTendency["biggestReach"];
    let bestValue: DraftTendency["bestValue"];
    if (usable) {
      for (const p of teamPicks) {
        if (typeof p.playerADP !== "number" || p.playerADP <= 0) continue;
        const delta = Math.round((p.playerADP - p.pickNumber) * 10) / 10;
        const entry = { player: p.playerName, pos: p.playerPosition, pick: p.pickNumber, adp: Math.round(p.playerADP * 10) / 10, delta };
        if (delta > 0 && (!biggestReach || delta > biggestReach.delta)) biggestReach = entry;
        if (delta < 0 && (!bestValue || delta < bestValue.delta)) bestValue = entry;
      }
    }

    const last = args.lastSeason?.get(team.externalId);
    tendencies.push({
      teamId: team.externalId,
      teamName: team.name,
      manager: team.manager,
      draftSlot: team.draftSlot,
      lastSeasonRecord: last?.record,
      lastSeasonRank: last?.rank,
      firstThree,
      positionalStart,
      firstQbRound,
      firstTeRound,
      biggestReach,
      bestValue,
      positionCounts,
    });
  }
  return tendencies.sort((a, b) => (a.draftSlot ?? 99) - (b.draftSlot ?? 99));
}

/* -------------------------------------------------------------------------- */
/* News and the injury watch                                                   */
/* -------------------------------------------------------------------------- */

export interface NewsSource {
  headline: string;
  published: string;
  athleteIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const NEWS_WINDOW_DAYS = 7;
export const INJURY_NEWS_WINDOW_DAYS = 30;
export const INJURY_WATCH_ADP = 120;
/** Pool players past this ADP rank get no headline; the writer will not draft them for their news. */
export const NEWS_ADP_RANK_LIMIT = 120;
const NEWS_PER_PLAYER = 1;
/** A story tagged to this many players is a listicle ("sleepers, busts and breakouts"), not news about one of them. */
const LISTICLE_ATHLETES = 6;
const INJURY_WORDS = /\b(injur|hurt|hamstring|knee|ankle|calf|groin|quad|concussion|shoulder|back|foot|toe|wrist|hand|surgery|practice|limited|questionable|doubtful|out for|out with|returns?|ir\b|reserve|suspend|sidelined|setback|activated|cleared)/i;

/** Headlines from the last `windowDays`, newest first, keyed by ESPN athlete id. */
export function indexNewsByPlayer(news: NewsSource[], now: number, windowDays: number): Map<string, Array<{ headline: string; published: string }>> {
  const cutoff = now - windowDays * DAY_MS;
  const byPlayer = new Map<string, Array<{ headline: string; published: string }>>();
  const sorted = [...news]
    .filter((n) => {
      const t = Date.parse(n.published);
      return Number.isFinite(t) && t >= cutoff && t <= now + DAY_MS && n.athleteIds.length <= LISTICLE_ATHLETES;
    })
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  for (const item of sorted) {
    for (const id of item.athleteIds) {
      const list = byPlayer.get(id) ?? [];
      if (list.length >= NEWS_PER_PLAYER || list.some((n) => n.headline === item.headline)) continue;
      list.push({ headline: item.headline, published: item.published.slice(0, 10) });
      byPlayer.set(id, list);
    }
  }
  return byPlayer;
}

/** Injury news names the player (or his surname) and uses injury vocabulary; a listicle does neither. */
export function looksLikeInjuryNews(headline: string, playerName: string): boolean {
  const surname = playerName.trim().split(/\s+/).pop() ?? "";
  const mentions = surname.length >= 3 && headline.toLowerCase().includes(surname.toLowerCase());
  return mentions && INJURY_WORDS.test(headline);
}

export interface InjuryWatchEntry {
  playerId: string;
  playerName: string;
  position: string;
  proTeam: string;
  adp: number;
  injuryStatus: string;
  latestHeadline?: { headline: string; published: string };
}

/**
 * Attach the week's headlines to pool players, and list the high-profile players (ADP within
 * `INJURY_WATCH_ADP`) whose status is not ACTIVE, with their latest injury-window headline.
 */
export function attachNewsAndInjuryWatch(
  pool: PoolPlayer[],
  news: NewsSource[],
  now: number
): { pool: PoolPlayer[]; injuryWatch: InjuryWatchEntry[] } {
  const weekNews = indexNewsByPlayer(news, now, NEWS_WINDOW_DAYS);
  const monthNews = indexNewsByPlayer(news, now, INJURY_NEWS_WINDOW_DAYS);
  const withNews = pool.map((p) => {
    if (p.adpRank > NEWS_ADP_RANK_LIMIT) return p;
    const items = weekNews.get(p.playerId);
    return items && items.length ? { ...p, recentNews: items } : p;
  });
  const injuryWatch: InjuryWatchEntry[] = withNews
    .filter((p) => p.injuryStatus && p.adp <= INJURY_WATCH_ADP)
    .map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      position: p.position,
      proTeam: p.proTeam,
      adp: p.adp,
      injuryStatus: p.injuryStatus!,
      latestHeadline: monthNews.get(p.playerId)?.find((n) => looksLikeInjuryNews(n.headline, p.playerName)),
    }));
  return { pool: withNews, injuryWatch };
}

/** "Redraft" | "Keeper" | "Dynasty" from ESPN's draft settings, readable before the draft. */
export function leagueTypeFromDraftSettings(draftSettings: { keeperCount?: number; leagueSubType?: string } | undefined): string {
  const sub = (draftSettings?.leagueSubType ?? "").toUpperCase();
  if (sub.includes("DYNASTY")) return "Dynasty";
  if ((draftSettings?.keeperCount ?? 0) > 0 || sub.includes("KEEPER")) return "Keeper";
  return "Redraft";
}
