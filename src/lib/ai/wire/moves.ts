// The Wire — plain-English move descriptions (spec §18, sam_question). When Dex's desk logs a
// notable lineup move, a late swap or a trade proposal, Sam follows it with one question through the
// writer-reply call (reply.ts, chase mode with `chaseSubject: "move"`). The model never sees the
// transaction row; it sees this sentence, so it has to read like something a person would say to a
// reporter — who, what, where, and (for a late swap) when.
//
// Pure: no imports. Imported by the Convex default runtime.

export type MoveKind = "lineup_move" | "late_swap" | "trade_proposal";

export interface MoveDescriptionInput {
  kind: MoveKind;
  /** The manager's fantasy team. */
  team: string;
  /** The manager's display name. */
  manager: string;
  /** The players moved (a lineup move: usually one; a proposal: the pieces on both sides). */
  players: string[];
  /** The starting slot the player went into, e.g. "FLEX". */
  slot?: string;
  /** The player who went to the bench in the same move. */
  benched?: string;
  /** Whole minutes before the moved player's NFL kickoff, when known. */
  minutes?: number;
  /** trade_proposal: the team the proposal went to. */
  otherTeam?: string;
}

function tidy(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** "A", "A and B", "A, B and C". Blank names are dropped. */
export function joinNames(names: ReadonlyArray<string>): string {
  const clean = names.map(name => tidy(name)).filter(name => name.length > 0);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** "Jordan Lee of Kittle Me This", degrading to whichever half is known. */
function subjectOf(input: MoveDescriptionInput): string {
  const manager = tidy(input.manager);
  const team = tidy(input.team);
  if (manager && team) return `${manager} of ${team}`;
  return manager || team || "The manager";
}

function minutesPhrase(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole === 0) return "right at kickoff";
  return `${whole} ${whole === 1 ? "minute" : "minutes"} before kickoff`;
}

/**
 * One sentence, plain English, that Sam can ask about:
 *   "Jordan Lee of Kittle Me This moved Joe Burrow into the FLEX and benched Chase Brown 40 minutes before kickoff."
 *   "Jordan Lee of Kittle Me This proposed a trade to Sable Ridge Sentinels involving Joe Burrow and Chase Brown."
 * A proposal's pieces sit on both sides, so the sentence says "involving", never "gave".
 */
export function describeMove(input: MoveDescriptionInput): string {
  const who = subjectOf(input);
  const names = joinNames(input.players);

  if (input.kind === "trade_proposal") {
    const other = tidy(input.otherTeam);
    if (other && names) return `${who} proposed a trade to ${other} involving ${names}.`;
    if (other) return `${who} proposed a trade to ${other}.`;
    if (names) return `${who} proposed a trade involving ${names}.`;
    return `${who} proposed a trade.`;
  }

  const slot = tidy(input.slot);
  const benched = tidy(input.benched);
  const target = names && input.players.filter(name => tidy(name)).length === 1 && slot ? `into the ${slot}` : "into the starting lineup";
  let sentence = names ? `${who} moved ${names} ${target}` : `${who} changed the starting lineup`;
  if (benched) sentence += ` and benched ${benched}`;
  if (typeof input.minutes === "number" && Number.isFinite(input.minutes)) sentence += ` ${minutesPhrase(input.minutes)}`;
  else if (input.kind === "late_swap") sentence += " inside an hour of kickoff";
  return `${sentence}.`;
}
