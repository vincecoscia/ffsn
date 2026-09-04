// Pure string builders for "Disputed" turn prompts. No model call, no I/O — this module only
// assembles text. `producer.ts` is the only caller.

import type { FactsBlock } from "../facts";
import { getPersona, getPersonaDisplay } from "../persona-prompts";
import type { PersonaPrompt } from "../persona-prompts";
import { MILD_PROFANITY, STRONG_PROFANITY } from "../language";
import {
  buildHouseStyleBlock,
  buildRelationshipsBlock,
  buildWhoYouAreBlock,
  GROUNDING_CONTRACT,
  languageSamplesFor,
  languageTraitFor,
} from "../prompt-builder";
import {
  DEBATER_SLUGS,
  HOST_SLUG,
  WITNESS_SLUGS,
  type ArticleClaim,
  type DebaterSlug,
  type ShowBrief,
  type ShowRole,
  type ShowSegment,
  type TurnKind,
  type WitnessSlug,
} from "./types";

/**
 * Word ceilings by role (spec BUILD 1 §3), plus the `cold_open` special case (pilot follow-up,
 * 2026-09-03): the cold open has to carry the week's biggest fact AND the question, so the host
 * ceiling is raised above the ordinary 45 for that one turn kind only. `redirect`/`ledger`/`close`
 * stay at 45 — use {@link ceilingFor} rather than reading `host` directly whenever a `kind` is in
 * hand. Lowered again (edit-bay follow-up, 2026-09-03: debater 120→70, witness 80→50, coldOpen
 * 80→70) — pass one now writes shorter so pass two (the edit bay) has room to cut without gutting
 * every turn to nothing.
 */
export const WORD_CEILINGS = { host: 45, witness: 50, debater: 70, coldOpen: 70 } as const;

/** The word ceiling for a turn, by role and (for the host) by kind. */
export function ceilingFor(role: ShowRole, kind: TurnKind): number {
  if (kind === "cold_open") return WORD_CEILINGS.coldOpen;
  return WORD_CEILINGS[role];
}

/**
 * The show's format, roles and hard rules — everything that is true on every turn, for every
 * speaker. Stable text (no facts, no timestamps), so it belongs above the per-turn director
 * instruction rather than inside it.
 */
export const SHOW_RULES = `SHOW FORMAT — DISPUTED
Disputed is FFSN's weekly transcript-only debate show. Two debaters argue one binary question about
one team on the hot seat, whose GM answers for its decisions; the rest of the desk are witnesses,
called to the stand by name; Curtis Vaughn hosts and referees. This is a transcript: every line is
something a real person says out loud — never stage direction, never a scene description, never a
speaker label inside the line itself.

THE ROLES
- Curtis Vaughn hosts and referees. He opens the show, redirects when the debate stalls, reads the
  season ledger, and gets the last line.
- Mel Diaper and Reggie Banks debate. Mel argues from the draft and the process; Reggie argues from
  the results. They take opposite sides of the week's question and stay there.
- Sam Ortega, Nina Sharpe, Dex Alvarez and Walt Brennan are witnesses. A debater or Curtis calls them
  to the stand by name, they answer, and then they step back down.

AGREEMENT IS THE VERDICT
The debaters never concede to each other directly. At most one agreement happens in a whole episode —
one debater conceding one point to the other — and when it happens, it is the moment the audience
remembers. Anything after the first agreement is off the table for the rest of the show.

WITNESS RULES
- Sam Ortega reads on-record quotes from facts.quotes only, verbatim, and says plainly when nobody
  responded. She never characterizes a manager's motive beyond what the quote itself says.
- Nina Sharpe grades a claim against a number: supported, partly supported, or not supported. She
  never joins a side.
- Dex Alvarez says whether the thing in front of him is REPORTED (in the transaction log), STATED (a
  manager said it on the record), or OPINION (his, flagged as such).
- Walt Brennan gives the historical parallel from FACTS and nowhere else, then a first-person
  verdict. He is the swing vote — the one witness on this show allowed to say who is right.

CURTIS'S RULES
Every turn is short. He never lectures. When he takes the floor mid-debate it is to redirect — to a
witness or to a fact in FACTS — and he hands off immediately after. He reads the season ledger once,
near the verdict. He always gets the last line of the show. When he frames the week's binary question
in the cold open, one honest answer must come from the draft board and the process — that's Mel's
side — and the other from the scoreboard and this season's results — that's Reggie's side — and the
two must actually contradict, never just differ in emphasis.

DEBATER RULES
A debater takes a side with a number attached in the opening — a vague position loses before it
starts. Debaters never concede to each other directly; a point that beats one of them is conceded to
Nina, not to the other debater. They attack the pick or the lineup, never the person. Reggie may say
"You can take that to the bank" at most once, and only in his very last jab of the episode — never in
a headline, never anywhere else. A debater's two-word sign-off is a rhythm, not a chant: it may land
at most twice across the whole episode, not once every turn. A prediction is stated once, in the
opening statement, and restated once, in the last jab; between those two moments, argue with new
facts pulled from FACTS, never the same forecast said again in new words. Quotation marks mean
a manager's verbatim words from FACTS.quotes and nothing else — never your own words, not even a
line you have said before. Emphasis is capitals, not quote marks. That rule binds every speaker on
the desk, Nina included: a claim you are grading is restated in your own words, never inside
quotation marks.`;

function debaterRoleRules(slug: DebaterSlug): string {
  const shared =
    `You are one of the two debaters on Disputed. Take a side with a number attached in your ` +
    `opening — a vague position loses before it starts. Never concede to your opponent directly; if ` +
    `a number beats you, that concession belongs to Nina, not to them. Attack the pick or the ` +
    `lineup, never the person.`;
  if (slug === "reggie-banks") {
    return (
      `${shared} "You can take that to the bank" is yours alone, and only in your very last jab of ` +
      `the episode — never anywhere else, never in a headline.`
    );
  }
  return shared;
}

function witnessRoleRules(slug: WitnessSlug): string {
  switch (slug) {
    case "sam-ortega":
      return (
        `You are called to the stand as a witness on Disputed. Read only the on-record quotes in ` +
        `facts.quotes, verbatim, and say plainly when nobody responded. You take no side.`
      );
    case "nina-sharpe":
      return (
        `You are called to the stand as a witness on Disputed. Grade the claim in front of you ` +
        `against a number in FACTS: supported, partly supported, or not supported. You never join a side.`
      );
    case "dex-alvarez":
      return (
        `You are called to the stand as a witness on Disputed. Say plainly whether the thing in ` +
        `front of you is REPORTED (in the transaction log), STATED (a manager said it on the ` +
        `record), or OPINION (yours, flagged). You take no side.`
      );
    case "walt-brennan":
      return (
        `You are called to the stand as a witness on Disputed. Give the historical parallel from ` +
        `FACTS and nowhere else, then a first-person verdict — you are the swing vote on this show, ` +
        `the one witness allowed an opinion on who is right.`
      );
    default: {
      const exhaustive: never = slug;
      throw new Error(`Unhandled witness slug: ${String(exhaustive)}`);
    }
  }
}

function hostRoleRules(): string {
  return (
    `You are hosting Disputed. Every turn is short — you never lecture. When you take the floor to ` +
    `redirect, name a witness or drop a fact from FACTS and hand off immediately. You read the ` +
    `season ledger once, near the verdict, in a single line. You always get the last line of the show.`
  );
}

/** The "YOUR ROLE ON THIS SHOW" text for one persona slug. */
export function roleRulesFor(slug: string): string {
  if (slug === HOST_SLUG) return hostRoleRules();
  if ((DEBATER_SLUGS as readonly string[]).includes(slug)) return debaterRoleRules(slug as DebaterSlug);
  if ((WITNESS_SLUGS as readonly string[]).includes(slug)) return witnessRoleRules(slug as WitnessSlug);
  return hostRoleRules();
}

/**
 * A speaker's system prompt for this episode: the same grounding contract and identity blocks
 * `PromptBuilder` uses for an article, plus the show rules and this speaker's role. Stable across
 * every turn a given speaker takes in the episode (no facts change it — FACTS itself lives in the
 * per-turn user prompt, and the house-style/language block is derived from `brief`, which is fixed
 * for the whole episode), so the caller may cache it once per speaker.
 */
export function buildTurnSystemPrompt(
  persona: PersonaPrompt,
  facts: FactsBlock,
  roleRules: string,
  brief: ShowBrief
): string {
  const parts: string[] = [
    GROUNDING_CONTRACT,
    buildHouseStyleBlock({
      languageRating: brief.languageRating,
      cleanTeamNames: brief.cleanTeamNames,
      surface: "show",
    }),
    buildWhoYouAreBlock(persona, brief.languageRating, `w${brief.week}`),
  ];

  const relationshipsBlock = buildRelationshipsBlock(facts, persona);
  if (relationshipsBlock) parts.push(relationshipsBlock);

  parts.push(SHOW_RULES);
  parts.push(`YOUR ROLE ON THIS SHOW\n${roleRules}`);

  // The show carries no article voice samples (a turn is too short to need them), but above clean
  // the language samples ARE the register — the model mirrors a sample far more reliably than it
  // follows a rule (owner ask, 2026-09-03), so they ride along with the trait.
  const rating = brief.languageRating ?? "clean";
  if (rating !== "clean" && languageTraitFor(persona, rating, `w${brief.week}`)) {
    const samples = languageSamplesFor(persona, rating, `w${brief.week}`);
    if (samples.length > 0) {
      parts.push(
        `LANGUAGE SAMPLES — style only. The braces are placeholders, not content. Never copy a placeholder, a number, or a name out of these lines into a turn.\n${samples.map((sample) => `- ${sample}`).join("\n")}`
      );
    }
  }

  return parts.join("\n\n");
}

/** The word-ceiling line varies by kind (`cold_open` gets 80 for the host; everything else 45). */
function turnOutputContract(kind: TurnKind): string {
  return `OUTPUT CONTRACT
Speak through the tool. "text" is only what you say out loud — no speaker label, no stage direction,
no scene-setting. Length is a ceiling, not a quota: host turns stay under ${ceilingFor("host", kind)} words,
witness turns under ${WORD_CEILINGS.witness}, debater turns under ${WORD_CEILINGS.debater}.
"factsCited" names the FACTS entries (ids or plain descriptions) this turn actually rests on. "jab"
is true only if this turn takes a shot at the other debater — most turns are not jabs.`;
}

export interface TurnUserPromptArgs {
  /** `serializeFacts(facts)`, already wrapped in `<FACTS>...</FACTS>`. */
  factsText: string;
  /** The episode so far, rendered plain-text, oldest first. Empty string before the first turn. */
  transcriptSoFar: string;
  /** This exact turn's instruction from `directorInstructionFor`. */
  directorInstruction: string;
  brief: ShowBrief;
  /** Selects the word-ceiling line in the output contract (see {@link ceilingFor}). */
  kind: TurnKind;
}

/**
 * The user prompt, split so the caller can cache the FACTS block across every turn of the episode
 * (pilot follow-up, 2026-09-03: prompt tokens were 12.5k/turn with FACTS resent uncached every time).
 * `cachedPrefix` is byte-identical for every turn — send it with an ephemeral cache breakpoint.
 * `suffix` carries what changes every turn (transcript so far, tonight's instruction, the output
 * contract) and is never cached. `cachedPrefix + suffix` reconstructs the single prompt string this
 * function used to return.
 */
export interface TurnUserPrompt {
  /** `factsText`, verbatim — identical across every turn of one episode. */
  cachedPrefix: string;
  /** TRANSCRIPT SO FAR + DIRECTOR + the output contract. Changes on every call. */
  suffix: string;
}

export function buildTurnUserPrompt(args: TurnUserPromptArgs): TurnUserPrompt {
  const { factsText, transcriptSoFar, directorInstruction, kind } = args;
  const suffix = `

TRANSCRIPT SO FAR
${transcriptSoFar.trim().length > 0 ? transcriptSoFar : "(the show has not started yet)"}

DIRECTOR
${directorInstruction}

${turnOutputContract(kind)}`;
  return { cachedPrefix: factsText, suffix };
}

/**
 * The per-turn language line for a debater's turn (opening, argument, jab). The register itself
 * lives in the speaker's LANGUAGE trait in the system prompt; this only names the moment. Three
 * live runs (2026-09-03) at salty and unfiltered with the register described only in the house-style
 * block produced zero profanity, and a fixed "use one word this turn" quota produced four "damn"s at
 * fixed slots — so the quota now exists only as a FALLBACK: on the last jab, when a debater who
 * carries the rating has not sworn once all episode (`ctx.languageUsed === 0`), the jab is told
 * outright to carry it. Every other turn is a trigger reminder, not a count. Empty at clean, and
 * empty for a speaker with no allowance.
 */
function languageNoteFor(kind: "opening" | "argument" | "jab", ctx: DirectorContext): string {
  const rating = ctx.brief.languageRating ?? "clean";
  if (rating === "clean") return "";
  const allowance = ctx.languageAllowance ?? 0;
  if (allowance <= 0) return "";
  const used = ctx.languageUsed ?? 0;
  const floor = ctx.languageFloor ?? 0;
  const tierWords = rating === "salty" ? MILD_PROFANITY : STRONG_PROFANITY;
  const rangeText = floor > 0 ? `your range tonight is ${floor} to ${allowance}` : `your allowance tonight is ${allowance}`;

  if (kind === "jab" && used < Math.max(floor, 1)) {
    const shortfall = Math.max(floor, 1) - used;
    return `LANGUAGE: this league runs ${rating}, and you are at ${used} for the night against a floor of ${Math.max(floor, 1)} — that is out of character for you. This jab carries it: at least ${shortfall === 1 ? "one word" : `${shortfall} words`} from your tier (${tierWords.join(", ")}), in your own register, aimed at the pick or the result, never against the person.\n\n`;
  }
  if (kind === "opening") {
    return `LANGUAGE: this league runs ${rating} and ${rangeText}. Your language trait applies, and an opening statement is exactly the moment it describes — the receipt or the scoreboard earns the word. Aim it at the decision or the result, never against the person.\n\n`;
  }
  if (kind === "jab") {
    return `LANGUAGE: this league runs ${rating}. Your language trait applies here as much as anywhere; a last shot is allowed to be filthy about the pick or the result, never about the person.\n\n`;
  }
  return `LANGUAGE: this league runs ${rating}; your language trait applies whenever the moment earns it. You are at ${used} for the night and ${rangeText}${floor > 0 && used < floor ? " — you are under it" : ""}.\n\n`;
}

/** Everything `directorInstructionFor` might need for one turn. Every field is optional — only the fields the given `kind` actually uses are read. */
export interface DirectorContext {
  brief: ShowBrief;
  /** The episode's resolved question, once the cold open has set it. */
  question?: string;
  /** How many agreements have already happened this episode (0 or 1). */
  agreementsUsed?: number;
  /** Who called this witness to the stand, for a witness turn. */
  requestedBy?: string;
  /** Which debater is giving this jab, for a jab turn (decides whether the catchphrase applies). */
  jabSpeaker?: DebaterSlug;
  /** The two opening claims, once both exist, for the grade turn. */
  openingClaims?: Partial<Record<DebaterSlug, ArticleClaim>>;
  /**
   * This speaker's own most recent turn (their opening statement, or their last argument), read only
   * for an `argument` turn — repeats a stale prediction/sign-off into the DIRECTOR block so the model
   * can see it is repeating itself (pilot follow-up, 2026-09-03).
   */
  previousTurnText?: string;
  /** This debater's own side of the hot-seat question (opening, argument, jab). Set once the cold open resolves it. */
  mySide?: string;
  /** The OTHER debater's side — argument turns only, so a rebuttal answers the actual opposing position. */
  opponentSide?: string;
  /**
   * Mel's opening turn, read only for Reggie's `opening` instruction (spec follow-up, 2026-09-03: the
   * pilot had both debaters make the identical prediction, so the ledger couldn't score a winner).
   */
  melsOpening?: { text: string; claim?: ArticleClaim };
  /** Tracked profanity words this speaker has already used this episode (debater turns only). */
  languageUsed?: number;
  /** This speaker's per-episode allowance at the brief's rating (debater turns only); 0 or absent means no language note. */
  languageAllowance?: number;
  /** This speaker's per-episode floor at the brief's rating (debater turns only); the jab fallback fires while `languageUsed` is under it. */
  languageFloor?: number;
}

/** Mel's claim rendered plainly, so Reggie's instruction can name exactly what he must contradict. */
function describeClaim(claim: ArticleClaim): string {
  const fields = [`kind=${claim.kind}`];
  if (claim.subjectTeamId) fields.push(`subjectTeamId=${claim.subjectTeamId}`);
  if (claim.opponentTeamId) fields.push(`opponentTeamId=${claim.opponentTeamId}`);
  if (claim.week !== undefined) fields.push(`week=${claim.week}`);
  return `"${claim.text}" (${fields.join(", ")})`;
}

/**
 * The per-turn instruction that goes in the DIRECTOR section of the user prompt. Always starts with
 * a `KIND: <kind>` marker line so a caller (or a test's fake `TurnCaller`) can tell which turn is
 * being requested without parsing prose.
 */
export function directorInstructionFor(kind: TurnKind, ctx: DirectorContext): string {
  const marker = `KIND: ${kind}`;

  switch (kind) {
    case "cold_open": {
      const { hotSeat } = ctx.brief;
      return `${marker}
Open the show. State the single biggest fact of the week from FACTS in one line, then put ${hotSeat.teamName} on the hot seat — its GM is ${hotSeat.managerName}; the question is about whether the GM is doing right by that roster (${hotSeat.why}). Ask one binary question about ${hotSeat.managerName}'s stewardship of ${hotSeat.teamName} where one honest answer comes from the draft board and the process — that's Mel's side — and the other comes from the scoreboard and this season's results — that's Reggie's side — and the two answers must actually contradict, never just differ in emphasis. Return that exact question in the "question" field, and each debater's contradicting position, one sentence each, in the "sides" field (keys "mel-diaper" and "reggie-banks"). Hand the floor to Mel first.`;
    }

    case "opening": {
      const question = ctx.question ?? ctx.brief.fallbackQuestion;
      const sideLine = ctx.mySide ? `YOUR SIDE: ${ctx.mySide}\n\n` : "";
      const melsOpeningBlock = ctx.melsOpening
        ? `

MEL'S OPENING
${ctx.melsOpening.text}
${ctx.melsOpening.claim ? `Mel's claim: ${describeClaim(ctx.melsOpening.claim)}` : "Mel made no resolvable claim."}
Your claim must contradict his — the same subject and week with the opposite outcome, or a different resolvable claim that would prove YOUR side. Never restate his.`
        : "";
      return `${marker}
${sideLine}${languageNoteFor("opening", ctx)}Give your opening statement on: "${question}". Take a side and attach a number to it. State your position in the "claim" field as a resolvable prediction with FACTS team ids. Agreement is forbidden this turn — you are staking out ground, not finding consensus. Never put your own words in quotation marks — a quotation mark means a manager's verbatim words from FACTS.quotes; when you want emphasis, use capitals instead.${melsOpeningBlock}`;
    }

    case "argument": {
      const agreementNote =
        (ctx.agreementsUsed ?? 0) >= 1
          ? ` The one agreement this episode is allowed has already happened — agreement is forbidden this turn.`
          : ` If the other side lands a point you truly cannot answer, you may concede it with "agreesWithOpponent" — at most once in the whole episode, and only when it is really earned.`;
      const lastTurnBlock = ctx.previousTurnText
        ? `

YOUR LAST TURN (do not repeat its prediction, its closing line, or its sign-off; you are already on the record — advance the argument with a fact you have not used yet)
${ctx.previousTurnText}`
        : "";
      const sidesBlock =
        ctx.mySide || ctx.opponentSide
          ? `YOUR SIDE: ${ctx.mySide ?? "(not set)"}\nOPPONENT'S SIDE: ${ctx.opponentSide ?? "(not set)"}\n\n`
          : "";
      return `${marker}
${sidesBlock}${languageNoteFor("argument", ctx)}Answer the last turn directly. Attack the pick or the lineup, never the person. You may call one witness to the stand by slug in "witnessRequested" if a fact from them would settle this faster than another round of assertion. Never put your own words in quotation marks — a quotation mark means a manager's verbatim words from FACTS.quotes; when you want emphasis, use capitals instead.${agreementNote}${lastTurnBlock}`;
    }

    case "witness": {
      return `${marker}
${ctx.requestedBy ? `${ctx.requestedBy} called you to the stand.` : "You are called to the stand."} Answer once, in your own register, then stop — you are not here to referee the debate, and you take no side unless you are Walt giving his historical parallel.`;
    }

    case "redirect": {
      return `${marker}
Three turns have gone by without a new fact. Redirect the debate in under ${WORD_CEILINGS.host} words: name the witness who should speak next in "witnessRequested", or drop a fact from FACTS yourself and hand the floor back.`;
    }

    case "grade": {
      return `${marker}
Restate each claim in your own words, never inside quotation marks. Grade both debaters' opening claims against the numbers in FACTS: supported, partly supported, or not supported. Say which one the record actually backs and name the winner in the "verdict" field, with the one number that decided it. You never join a side.`;
    }

    case "ledger": {
      const ledger = ctx.brief.ledger;
      return `${marker}
Read the season ledger from the brief in one line: Mel is ${ledger["mel-diaper"].hits}-${ledger["mel-diaper"].misses}, Reggie is ${ledger["reggie-banks"].hits}-${ledger["reggie-banks"].misses}. Then tee up last jabs.`;
    }

    case "jab": {
      const catchphrase =
        ctx.jabSpeaker === "reggie-banks"
          ? ` You may close with "You can take that to the bank" — at most once, and only here.`
          : "";
      const sideLine = ctx.mySide ? `YOUR SIDE: ${ctx.mySide}\n\n` : "";
      return `${marker}
${sideLine}${languageNoteFor("jab", ctx)}One last shot at the other debater, backed by a fact.${catchphrase}`;
    }

    case "close": {
      return `${marker}
One line. Sign off.`;
    }

    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled turn kind: ${String(exhaustive)}`);
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Edit bay (pass two) — prompts for `edit-bay.ts#naturalizeTranscript`. Pass one (above) is the
 * source of truth for every fact; these prompts ask the model to CUT and LIVEN one segment's turns
 * without ever adding to what pass one already verified.
 * -------------------------------------------------------------------------- */

/** "Name (Role): tagline" plus the persona's first signature move — two lines, one speaker. */
function voiceCardFor(slug: string): string {
  const persona = getPersona(slug);
  const move = persona.signatureMoves[0] ?? "";
  return `${persona.name} (${persona.role}): ${persona.tagline}\n${move}`;
}

const EDIT_BAY_RULES = `EDIT BAY — DISPUTED, PASS TWO
Disputed is FFSN's weekly transcript-only debate show (see the format above, if you were shown it —
either way, this is a finished transcript, written turn by turn in isolation, and every line is
something a real person says out loud). The team on the hot seat is the subject of the debate; its
GM answers for the team's decisions, never for scoring or losing on its behalf. Your job is pass
two: the live-radio edit. Cut it for time and make it sound like a real broadcast, without changing a
single fact.

RULES
- When you cut, cut adjectives, repeats and wind-ups — never the team's name. A line that named the
  team keeps naming the team; do not shorten "the Gravel Pit Grinders lost" to "he lost". The
  manager's name is the first thing to trim, not the last.
- Make it sound live: contractions, fragments, a debater cutting in mid-sentence where he would never
  let the point stand. Mark the turn that cuts in "interrupts": true, and end the turn it interrupts
  with an em dash (—) instead of its original ending. Aim for two to four cut-ins in a main event and
  at least one in the opening statements or the last jabs; a cut-in lands MID-SENTENCE, and the
  speaker who was cut off may pick the thread back up in a later turn.
- Never output two consecutive turns by the same speaker. Splitting a turn is only for opening a gap
  that another speaker fills; if nobody cuts in, keep it as one turn.
- One-line reactions are allowed ("Oh, come on." "Here we go."). Curtis stays short — shorter than
  anyone else on the desk.
- CUT the segment down to the target word count. Keep the ORDER the speakers appear in. Never merge
  two different speakers into one output turn.
- Never put words in quotation marks that were not already in quotation marks in the original line.
- Never add profanity that was not in the original line; at clean, none at all.
- Keep every number, name, record and score EXACTLY as the original turn wrote it — add none, not
  even a friendly rounding.
- Locked turns are listed below by index and must survive verbatim, unedited, word for word.
- Every output turn carries "sourceTurn": the index of the ORIGINAL turn (from the numbered list
  below) it came from. A turn may be split into two output turns that share the same "sourceTurn",
  to open a gap for an interruption. The original transcript's very first and very last turns must
  each still be represented by at least one output turn.`;

/** Stable across every segment and every episode — safe to send as one cached system block. */
export function buildEditSystemPrompt(): string {
  const voiceCards = [HOST_SLUG, ...DEBATER_SLUGS, ...WITNESS_SLUGS].map(voiceCardFor).join("\n\n");
  return `${EDIT_BAY_RULES}\n\nTHE DESK\n${voiceCards}`;
}

export interface EditUserPromptArgs {
  segment: ShowSegment;
  /** Cut this segment to about this many words total. */
  targetWords: number;
  /** Indexes into `segment.turns` that must come back verbatim, unedited. */
  lockedIndexes: number[];
}

/** Changes every call — never cached. */
export function buildEditUserPrompt(args: EditUserPromptArgs): string {
  const { segment, targetWords, lockedIndexes } = args;
  const turnsBlock = segment.turns
    .map((turn, index) => {
      const display = getPersonaDisplay(turn.speaker);
      return `[${index}] speaker=${turn.speaker} — ${display.name} (${display.role}): ${turn.text}`;
    })
    .join("\n\n");
  const lockedLine = lockedIndexes.length > 0 ? lockedIndexes.join(", ") : "(none)";

  return `SEGMENT: ${segment.title}

ORIGINAL TURNS
${turnsBlock}

LOCKED TURNS (verbatim, untouchable): ${lockedLine}

OUTPUT: every turn's "speaker" is the slug shown after "speaker=" in that turn's header (for example mel-diaper), never the display name; "sourceTurn" is the [index] of the original turn it came from.

TARGET: cut this segment to about ${targetWords} words total, through the "edit_segment" tool.`;
}
