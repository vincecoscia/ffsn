/**
 * ESPN's draft type, read faithfully (owner ask, 2026-09-06: "make sure it knows it's a snake
 * draft - not all leagues have that"). `leagueSeasons.draftSettings.type` is "SNAKE", "AUCTION" or
 * "OFFLINE" (a draft run outside ESPN's room); an older row may only carry `draftInfo.draftType`.
 * Anything unreported is treated as a snake, but `assumed` is set so the prompt and the FACTS
 * gap line say so instead of silently guessing - the old code called everything but AUCTION a snake.
 */
export type DraftTypeLabel = "Snake" | "Auction" | "Offline";

export interface DraftTypeRead {
  draftType: DraftTypeLabel;
  /** True when ESPN reported nothing usable and "Snake" is a default, not a fact. */
  assumed: boolean;
}

export function draftTypeFromEspn(...candidates: unknown[]): DraftTypeRead {
  for (const raw of candidates) {
    const type = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (type === "SNAKE") return { draftType: "Snake", assumed: false };
    if (type === "AUCTION") return { draftType: "Auction", assumed: false };
    if (type === "OFFLINE") return { draftType: "Offline", assumed: false };
  }
  return { draftType: "Snake", assumed: true };
}

/** Snake and offline drafts (run as a snake by convention) reverse the order every round; an auction has no order at all. */
export function reversesEveryRound(draftType: string | undefined): boolean {
  return draftType === "Snake" || draftType === "Offline" || draftType === undefined;
}
