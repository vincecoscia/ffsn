// Deterministic hot-seat selection for "Disputed" — no model call.
//
// `chooseHotSeat` decides who this week's episode is about, before a single prompt is built. It
// prefers the manager the desk disagrees most about (spec §1), and falls back to the biggest
// process-versus-results split in the box score when the relationship ledger has nothing to say.

import type { FactsBlock } from "../facts";
import type { WriterRelationshipContext } from "../content-generation-service";
import type { RelationshipTier } from "../persona-prompts";
import { getPersonaDisplay } from "../persona-prompts";
import type { ShowBrief } from "./types";

/** feud=0 ... favorite=4, the same order every persona's `relationshipPosture` is keyed by. */
const TIER_ORDER: RelationshipTier[] = ["feud", "cold", "neutral", "warm", "favorite"];

function tierIndex(tier: RelationshipTier): number {
  return TIER_ORDER.indexOf(tier);
}

function scoreLabel(score: number): string {
  return score > 0 ? `+${score}` : `${score}`;
}

function tierClause(tier: RelationshipTier): string {
  if (tier === "favorite" || tier === "warm") return `is ${tier} on them`;
  if (tier === "feud" || tier === "cold") return `is at ${tier}`;
  return "is neutral on them";
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st" — a rank as a broadcaster says it. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

interface RelationshipEntry {
  writer: string;
  score: number;
  tier: RelationshipTier;
}

interface ManagerAggregate {
  userId: string;
  managerName: string;
  teamId: string;
  teamName: string;
  entries: RelationshipEntry[];
}

/**
 * Resolves a raw (writer-scoped) team reference to the FACTS team id ("T7"), when it exists.
 * Exported so `producer.ts` can build each speaker's own RELATIONSHIPS block from the same
 * `relationshipsByWriter` map this function uses for hot-seat selection.
 */
export function resolveFactsTeamId(facts: FactsBlock, teamId: string, teamName: string): string | undefined {
  const byId = facts.teams.find((team) => team.teamId === teamId);
  if (byId) return byId.id;
  const byName = facts.teams.find((team) => team.name === teamName);
  return byName?.id;
}

/**
 * Step 1: the manager the desk disagrees most about. Groups every writer's relationship reading of
 * every manager by `userId`, finds the manager with the widest tier spread (≥ 2) across those
 * readings, and reports the two extreme readings by name and number.
 */
function chooseFromRelationships(
  facts: FactsBlock,
  relationshipsByWriter: Record<string, WriterRelationshipContext[]>
): ShowBrief["hotSeat"] | null {
  const byManager = new Map<string, ManagerAggregate>();

  for (const [writer, relationships] of Object.entries(relationshipsByWriter)) {
    for (const relationship of relationships ?? []) {
      let aggregate = byManager.get(relationship.userId);
      if (!aggregate) {
        aggregate = {
          userId: relationship.userId,
          managerName: relationship.managerName,
          teamId: relationship.teamId,
          teamName: relationship.teamName,
          entries: [],
        };
        byManager.set(relationship.userId, aggregate);
      }
      aggregate.entries.push({ writer, score: relationship.score, tier: relationship.tier });
    }
  }

  let best:
    | { aggregate: ManagerAggregate; spread: number; scoreSum: number; low: RelationshipEntry; high: RelationshipEntry }
    | undefined;

  for (const aggregate of byManager.values()) {
    if (aggregate.entries.length < 2) continue;

    let low = aggregate.entries[0];
    let high = aggregate.entries[0];
    for (const entry of aggregate.entries) {
      if (tierIndex(entry.tier) < tierIndex(low.tier)) low = entry;
      if (tierIndex(entry.tier) > tierIndex(high.tier)) high = entry;
    }

    const spread = tierIndex(high.tier) - tierIndex(low.tier);
    if (spread < 2) continue;

    const scoreSum = aggregate.entries.reduce((sum, entry) => sum + Math.abs(entry.score), 0);
    if (!best || spread > best.spread || (spread === best.spread && scoreSum > best.scoreSum)) {
      best = { aggregate, spread, scoreSum, low, high };
    }
  }

  if (!best) return null;

  const teamId =
    resolveFactsTeamId(facts, best.aggregate.teamId, best.aggregate.teamName) ?? best.aggregate.teamId;
  const why =
    `${getPersonaDisplay(best.high.writer).name} ${tierClause(best.high.tier)} (${scoreLabel(best.high.score)}), ` +
    `${getPersonaDisplay(best.low.writer).name} ${tierClause(best.low.tier)} (${scoreLabel(best.low.score)})`;

  return { teamId, managerName: best.aggregate.managerName, why };
}

/** 1st-place points-for down to last, by `facts.standings[].pointsFor` (never the win/loss rank). */
function pointsForRanks(facts: FactsBlock): Map<string, number> {
  const sorted = [...facts.standings].sort((a, b) => b.pointsFor - a.pointsFor);
  const ranks = new Map<string, number>();
  sorted.forEach((row, index) => ranks.set(row.teamId, index + 1));
  return ranks;
}

/**
 * Step 2 fallback: the biggest process-versus-results split this week — a team that won despite the
 * worst points-for rank among winners, or lost despite the best points-for rank among losers.
 * "Surprisal" is the same idea for both directions: how far the result sits from what the season's
 * scoring says should have happened, so the two are directly comparable and the larger one wins.
 */
function fallbackFromStandings(facts: FactsBlock): ShowBrief["hotSeat"] | null {
  if (facts.standings.length === 0 || facts.matchups.length === 0) return null;

  const ranks = pointsForRanks(facts);
  const fieldSize = facts.standings.length;
  let best: { teamId: string; why: string; surprisal: number } | undefined;

  for (const matchup of facts.matchups) {
    const winnerId = matchup.winnerTeamId;
    if (!winnerId) continue; // no result, or a tie
    const loserId = winnerId === matchup.home.teamId ? matchup.away.teamId : matchup.home.teamId;
    const margin = matchup.margin ?? Math.abs(matchup.home.score - matchup.away.score);

    const winnerRank = ranks.get(winnerId);
    if (winnerRank !== undefined) {
      const surprisal = winnerRank; // the worse the winner's season points-for rank, the bigger the split
      if (!best || surprisal > best.surprisal) {
        best = {
          teamId: winnerId,
          surprisal,
          why: `won by ${margin} with the ${ordinal(winnerRank)}-lowest points for in the league`,
        };
      }
    }

    const loserRank = ranks.get(loserId);
    if (loserRank !== undefined) {
      const surprisal = fieldSize + 1 - loserRank; // the better the loser's rank, the bigger the split
      if (!best || surprisal > best.surprisal) {
        best = {
          teamId: loserId,
          surprisal,
          why: `lost by ${margin} despite the ${ordinal(loserRank)}-highest points for in the league`,
        };
      }
    }
  }

  if (!best) return null;
  const team = facts.teams.find((candidate) => candidate.id === best!.teamId);
  return { teamId: best.teamId, managerName: team?.manager ?? team?.name ?? "the manager", why: best.why };
}

/**
 * This week's hot seat: the manager (and why) the episode is built around. Deterministic, no model
 * call. `null` only when there is nothing to build an episode from at all (no relationships, and no
 * standings/matchups to fall back to).
 */
export function chooseHotSeat(
  facts: FactsBlock,
  relationshipsByWriter: Record<string, WriterRelationshipContext[]>
): ShowBrief["hotSeat"] | null {
  return chooseFromRelationships(facts, relationshipsByWriter) ?? fallbackFromStandings(facts);
}

/** Used only when the cold-open turn's own output carries no `question`. */
export function fallbackQuestionFor(hotSeat: ShowBrief["hotSeat"]): string {
  return `Is ${hotSeat.managerName} a good manager, or a lucky one?`;
}
