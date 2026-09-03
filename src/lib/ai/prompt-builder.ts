import { getPersona, type PersonaPrompt } from './persona-prompts';
import { contentTemplates, ContentTemplate } from './content-templates';
import { adpLooksLikePlaceholder, buildFactsBlock, serializeFacts, type FactsBlock } from './facts';
import type {
  CommentResponseData,
  NonRespondent,
  PriorClaim,
  PriorRecord,
  WriterRelationshipContext,
} from './content-generation-service';

/**
 * Thrown when a content type's core data is absent. The pipeline must surface this as a failed
 * generation with a human-readable reason and refund the credit — never paper over it with
 * invented matchups, trades or rivalries.
 */
export class InsufficientDataError extends Error {
  readonly contentType: string;
  readonly missing: string[];

  constructor(contentType: string, missing: string[]) {
    super(
      `Not enough data to write a ${contentType}. Missing: ${missing.join(', ')}. ` +
        `Sync the league and try again.`
    );
    this.name = 'InsufficientDataError';
    this.contentType = contentType;
    this.missing = missing;
  }
}

/**
 * The grounding contract. Emitted at the very top of the system prompt, above the persona, because
 * position matters: the contract must frame the voice, not the other way round.
 */
const GROUNDING_CONTRACT = `GROUNDING CONTRACT — this overrides every style instruction below.

Everything factual in your article must come from the <FACTS> block in the user message. A fact is
any name, team, score, point total, record, rank, pick number, date, transaction, or quote.

1. Never state a number that is not in <FACTS>. Do not compute new statistics, ratios, percentages,
   or projections beyond simple sums and differences of numbers that are present — and when you do
   that arithmetic, show both inputs.
2. Never attribute a player to a fantasy team except via that player's fantasyTeamId field. Never
   infer team membership from who they were mentioned near.
3. Never quote, paraphrase, or characterize a manager's opinion unless that manager appears in
   facts.quotes. If a manager did not respond, write about their team without them. Silence is a
   fact you may mention; it is not a licence to invent a reaction.
4. Never reference your own past predictions, previous articles, prior rankings, or league lore
   unless it appears in facts.priorClaims. If that array is empty, you have no history — write as
   if this is your first piece.
5. facts.missing lists data unavailable this week. Do not fill those gaps. Name the gap in
   character instead — "the box score doesn't tell us why he sat" is in voice; inventing why is not.

Uncertainty is in-voice, not out-of-voice. You may be as loud, cocky, or dismissive as your
persona demands about interpretation — who was lucky, who is cooked, who should be ashamed. Speak
in absolutes about opinions. Speak only from <FACTS> about events. If you want a stronger claim
than the facts support, escalate the rhetoric, never the data.

Word targets are ceilings, not quotas. A shorter accurate section always beats a padded one. If
a section has thin material, say so briefly and move on.

Broadcast register. Readers never see <FACTS>, so never mention it. Do not name data fields,
files, feeds, ledgers, sheets, math, or JSON ("benchImpact", "available_players", "the bench file",
"the depth sheet", "the benching math", "the comment ledger", "what came through"), and never print
an internal id (T3, M1, Q1, TR1, U1, D19) in a headline or a sentence. Say what a person would say
on air: "left 24 points on the bench", "the free-agent list didn't come through this week", "his
manager went on the record", "the only trade on the books".
Write dates and times in plain English ("Thursday night", "Oct. 9, 6:30 p.m. ET") and never print a
raw timestamp. Use only the quotes that belong in this story; you are not required to use them
all, and never tack an unrelated quote onto the end.`;

interface Matchup {
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  projectedScoreA?: number;
  projectedScoreB?: number;
  winner?: string;
  week?: number;
  isUpset?: boolean;
  closeness?: "blowout" | "comfortable" | "close" | "nail-biter";
  teamAOwner?: string;
  teamBOwner?: string;
  topPerformers?: Array<{
    playerId?: string;
    playerName?: string;
    points: number;
    teamId?: string;
    position?: string;
    player?: string;
    team?: string;
    overPerformance?: number;
    isStarter?: boolean;
    benchImpact?: boolean;
    wouldHaveReplacedPlayer?: string;
    pointImprovementIfStarted?: number;
  }>;
  benchPointsA?: number;
  benchPointsB?: number;
  memorableMoment?: string;
  playoffTier?: string;
}

interface PlayoffBreakdown {
  isChampionshipWeek?: boolean;
  playoffGameCount?: number;
  isPlayoffWeek?: boolean;
  playoffMatchups?: Matchup[];
  consolationMatchups?: Matchup[];
  regularSeasonMatchups?: Matchup[];
  championshipGame?: Matchup;
}

/** One division as the settings layer stores it: an ESPN division id plus its display name. */
export interface LeagueFormatDivision {
  id: string;
  name: string;
  size?: number;
}

/**
 * Raw league-format settings (audit: leagues differ in scoring, roster shape, playoff structure,
 * divisions and waivers, and the writers had no way to know any of it). Assembled once per article
 * by `convex/aiQueries.ts#buildLeagueFormat`, preferring the article's season row over the
 * league-level settings. Every field is optional and must be read defensively — a settings
 * migration populates these concurrently, so older leagues simply have fewer of them.
 */
export interface LeagueFormat {
  /** "ppr" | "half_ppr" | "standard" | "custom", or a legacy free-text value like "PPR". */
  scoringType?: string;
  receptionPoints?: number;
  regularSeasonMatchupPeriods?: number;
  playoffTeamCount?: number;
  /** Real weeks per playoff round; 2 means two-week rounds. */
  playoffMatchupPeriodLength?: number;
  playoffRounds?: number;
  /** "TOTAL_POINTS_SCORED" | "H2H_RECORD" | "DIVISION_WINNERS", ESPN's raw enum. */
  playoffSeedingRule?: string;
  divisions?: LeagueFormatDivision[];
  /** ESPN matchup-period id -> the real week numbers it spans, e.g. `{ "15": [15, 16] }`. */
  matchupPeriods?: Record<string, number[]>;
  /** Roster slot label -> count, e.g. `{ QB: 1, RB: 2, FLEX: 1 }`. */
  lineupSlots?: Record<string, number>;
  isSuperflex?: boolean;
  hasIdp?: boolean;
  /** "faab" | "waivers" | "free_agency". */
  waiverType?: string;
  faabBudget?: number;
  /** ms epoch. */
  tradeDeadline?: number;
  /** Derived: the last real week of the fantasy season (regular season + every playoff round). */
  fantasyChampionshipWeek?: number;
  /** Derived, plain English: "Weeks 15-18" or "Week 16". */
  playoffWeeksRange?: string;
}

/* -------------------------------------------------------------------------- *
 * Waiver / FAAB ledger (owner goal, 2026-09-02: waiver wire report must take FAAB spend into
 * account). Built server-side by `convex/aiQueries.ts#buildWaiverLedger` from the `transactions`
 * and `teams` tables; `facts.ts#buildWaivers` turns this into the id-bearing, citable
 * `FactsBlock.waivers`. This raw shape carries no id of its own and no team-id resolution — that
 * happens once, in `facts.ts`'s `TeamIndex` — so it stays a plain data shape a Convex module can
 * build without importing anything from the prompt layer as a value.
 * -------------------------------------------------------------------------- */

/** One winning waiver claim in the league's most recently processed run. */
export interface WaiverLedgerClaim {
  week: number;
  player: { id: string; name: string; pos: string; nflTeam?: string };
  teamId: string;
  teamName: string;
  manager?: string;
  bid: number;
  /** Losing bids for this same player in this same run, highest first. Empty for an uncontested claim. */
  competingBids: Array<{ teamId: string; teamName: string; bid: number }>;
  dropped?: { name: string; pos?: string };
}

/** One team's FAAB position: budget, spend and what is left, for the whole season so far. */
export interface WaiverLedgerBudget {
  teamId: string;
  teamName: string;
  manager?: string;
  budget?: number;
  spent?: number;
  remaining?: number;
  acquisitions?: number;
}

export interface WaiverLedgerSeason {
  biggestBid?: { teamId: string; teamName: string; player: string; bid: number; week: number };
  mostActive?: { teamId: string; teamName: string; acquisitions: number };
  /** Teams with the least FAAB left, ascending. */
  lowestRemaining: Array<{ teamId: string; teamName: string; remaining: number }>;
  totalSpent?: number;
  averageWinningBid?: number;
}

/** The waiver/FAAB ledger for one league-season. */
export interface WaiverLedger {
  /** The most recent scoring period with at least one executed waiver claim, if any. */
  latestRun?: { scoringPeriod: number; processedAt?: number; claims: WaiverLedgerClaim[] };
  budgets: WaiverLedgerBudget[];
  season: WaiverLedgerSeason;
  /** "faab" | "waivers" | "free_agency", mirrors `LeagueFormat.waiverType`. */
  waiverType?: string;
  /** The season FAAB budget every team started with, mirrors `LeagueFormat.faabBudget`. */
  budget?: number;
}

export interface PromptBuilderOptions {
  leagueId: string;
  contentType: string;
  persona: string;
  leagueData: LeagueDataContext;
  customContext?: string;
  includeExamples?: boolean;
  commentResponses?: CommentResponseData[];
  nonRespondents?: NonRespondent[];
  relationships?: WriterRelationshipContext[];
  priorClaims?: PriorClaim[];
  priorRecord?: PriorRecord;
}

export interface LeagueDataContext {
  leagueName: string;
  currentWeek: number;
  teams: Array<{
    id: string;
    name: string;
    manager: string;
    record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
    pointsFor: number;
    pointsAgainst: number;
    externalId?: string; // ESPN team ID for consistency tracking
    playoffSeed?: number;
    /** The division's display name, when the league has divisions. */
    division?: string;
    /** String form of `teams.divisionId`, matching `LeagueFormatDivision.id`. */
    divisionId?: string;
    divisionRecord?: { wins: number; losses: number; ties: number; };
    strengthOfSchedule?: number; // Calculated metric
    recentForm?: { wins: number; losses: number; avgPoints: number; }; // Last 3 weeks
    draftPosition?: number; // Draft position for mock drafts
    roster?: Array<{
      playerId: string;
      playerName: string;
      position: string;
      team: string;
      lineupSlotId?: number;
      acquisitionType?: string;
      fullName?: string;
      eligiblePositions?: string[];
      injuryStatus?: string;
      stats?: {
        appliedTotal?: number;
        projectedTotal?: number;
        seasonStats?: {
          appliedTotal?: number;
          projectedTotal?: number;
          averagePoints?: number;
        };
        weeklyStats?: Array<{
          week: number;
          appliedTotal?: number;
          projectedTotal?: number;
        }>;
        recentPerformance?: { // Last 3 weeks
          avgPoints: number;
          trend: "improving" | "declining" | "stable";
        };
      };
      ownership?: {
        percentOwned?: number;
        percentChange?: number;
        percentStarted?: number;
      };
    }>;
    benchPoints?: number; // Points left on bench this week
    optimalPoints?: number; // Best possible lineup score
  }>;
  previousSeasons?: Record<number, Array<{
    teamId: string;
    teamName: string;
    manager: string;
    record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
    roster: Array<{
      playerId: string;
      playerName: string;
      position: string;
      team: string;
      acquisitionType: string;
      fullName?: string;
    }>;
  }>>;
  recentMatchups?: Array<{
    teamA: string;
    teamB: string;
    scoreA: number;
    scoreB: number;
    projectedScoreA?: number;
    projectedScoreB?: number;
    winner?: string;
    week?: number;
    isUpset?: boolean; // When underdog wins
    closeness?: "blowout" | "comfortable" | "close" | "nail-biter";
    topPerformers?: Array<{ 
      playerId?: string;
      playerName?: string;
      points: number; 
      teamId?: string;
      position?: string;
      player?: string; // legacy support
      team?: string; // legacy support
    }>;
    benchPointsA?: number;
    benchPointsB?: number;
    memorableMoment?: string; // e.g., "Comeback victory", "Monday night miracle"
  }>;
  /**
   * Games that have NOT been played yet, for the look-ahead week (spec 4.3). Populated by
   * `aiQueries.getLeagueDataForAI` from the ESPN season schedule, which carries every future
   * matchup with zero scores and no winner. This is the only forward-looking matchup data in the
   * payload; `recentMatchups` is always history.
   */
  upcomingMatchups?: Array<{
    week: number;
    /** Team names, as in the weekly-recap shape. */
    teamA: string;
    teamB: string;
    /** ESPN external ids, so FACTS can resolve a side even when a name is missing. */
    teamAId: string;
    teamBId: string;
    teamAOwner?: string;
    teamBOwner?: string;
    /** "w-l-t", the same form `facts.teams[].record` uses. */
    teamARecord?: string;
    teamBRecord?: string;
    teamAPointsFor?: number;
    teamBPointsFor?: number;
    projectedScoreA?: number;
    projectedScoreB?: number;
    isPlayoff?: boolean;
    /** Meetings already played, from the same matchups table. */
    headToHead?: { teamAWins: number; teamBWins: number };
  }>;
  trades?: Array<{
    teamA: string;
    teamB: string;
    playersFromA: Array<{ playerId: string; playerName: string; position: string; }>;
    playersFromB: Array<{ playerId: string; playerName: string; position: string; }>;
    date: string;
    tradeGrade?: { teamA: string; teamB: string; };
    analysis?: string;
  }>;
  transactions?: Array<{
    teamId: string;
    teamName: string;
    type: "add" | "drop" | "add_drop" | "waiver_claim";
    playerAdded?: { playerId: string; playerName: string; position: string; };
    playerDropped?: { playerId: string; playerName: string; position: string; };
    date: string;
    faabBid?: number;
  }>;
  standings?: Array<{
    rank: number;
    team: string;
    teamId: string;
    wins: number;
    losses: number;
    ties: number;
    pointsFor: number;
    pointsAgainst: number;
    playoffSeed?: number;
    divisionRank?: number;
    /** The division's display name, when the league has divisions. */
    division?: string;
    divisionRecord?: { wins: number; losses: number; ties: number; };
    streakType?: "W" | "L";
    streakLength?: number;
  }>;
  /** One group per division, only present when the league has divisions. */
  divisionStandings?: Array<{
    division: string;
    teams: Array<{
      rank: number;
      teamId: string;
      team: string;
      record: string;
      pointsFor: number;
    }>;
  }>;
  rivalries?: Array<{
    teamA: { id: string; name: string; manager: string; };
    teamB: { id: string; name: string; manager: string; };
    allTimeRecord: { teamAWins: number; teamBWins: number; ties: number; };
    recentGames?: Array<{ week: number; scoreA: number; scoreB: number; }>;
    intensity: "casual" | "competitive" | "heated" | "bitter";
    backstory?: string;
  }>;
  managerActivity?: Array<{
    teamId: string;
    teamName: string;
    manager: string;
    totalTransactions: number;
    trades: number;
    waiverClaims: number;
    optimalLineupPercentage?: number;
    weeklyHighScores: number;
    weeklyLowScores: number;
  }>;
  scoringType?: string;
  rosterSize?: number;
  playoffTeams?: number;
  regularSeasonWeeks?: number;
  /** League-format facts (spec: format audit). Read through `this.facts.format` inside the prompt
   * builder — this raw field exists so `buildFormat` in `facts.ts` has something to read. */
  leagueFormat?: LeagueFormat;
  /** The waiver/FAAB ledger (owner goal: waivers must take FAAB spend into account). Read through
   * `this.facts.waivers` inside the prompt builder — this raw field exists so `buildWaivers` in
   * `facts.ts` has something to read. */
  waivers?: WaiverLedger;
  leagueHistory?: {
    foundedYear: number;
    totalSeasons: number;
    seasons?: Array<{
      year: number;
      champion?: { teamId: string; teamName: string; owner: string; };
      runnerUp?: { teamId: string; teamName: string; owner: string; };
      regularSeasonChampion?: { teamId: string; teamName: string; owner: string; };
      settings?: { scoringType: string; teamCount: number; playoffWeeks: number; };
    }>;
    allTimeRecords?: {
      mostChampionships?: { manager: string; count: number; };
      highestSingleGameScore?: { team: string; score: number; week: number; season: number; };
      lowestSingleGameScore?: { team: string; score: number; week: number; season: number; };
      biggestBlowout?: { winner: string; loser: string; margin: number; week: number; season: number; };
      longestWinStreak?: { team: string; length: number; season: number; };
    };
  };
  availablePlayers?: Array<{
    playerId: string;
    playerName: string;
    position: string;
    team?: string;
    proTeam?: string;
    ownership?: {
      percentOwned?: number;
      percentChange?: number;
      percentStarted?: number;
      averageDraftPosition?: number;
      auctionValueAverage?: number;
    };
    injured?: boolean;
    injuryStatus?: string;
    seasonOutlook?: string;
    recentStats?: { avgPoints: number; trend: string; };
    upcomingSchedule?: Array<{ week: number; opponent: string; difficulty: "easy" | "medium" | "hard"; }>;
    projectedStats?: {
      projectedTotal: number;
      projectedAverage: number;
    };
  }>;
  injuryReport?: Array<{
    playerId: string;
    playerName: string;
    team: string;
    position: string;
    status: string;
    description?: string;
    fantasyImpact?: string;
  }>;
  // Mock draft specific data
  draftOrder?: Array<{
    position: number;
    teamId: string;
    teamName: string;
    manager: string;
  }>;
  draftType?: string; // "Snake", "Auction", "Manual"
  leagueType?: string; // "Dynasty", "Keeper", "Redraft"
  memorableMoments?: Array<{
    seasonId: number;
    type: string;
    description: string;
  }>;
  draftSettings?: {
    type?: string;
    orderType?: string;
    pickOrder?: Array<{ position: number; teamId: string; teamName: string; manager: string }>;
    isAuction?: boolean;
    isSnake?: boolean;
  };
  playerCount?: number;
  weatherImpact?: Array<{
    game: string;
    conditions: string;
    temperature?: number;
    windSpeed?: number;
    precipitation?: number;
    fantasyImpact?: { passing: string; rushing: string; kicking: string; };
  }>;
  upcomingSchedule?: Array<{
    teamId: string;
    teamName: string;
    nextOpponent: string;
    nextOpponentRank?: number;
    restOfSeasonDifficulty?: "easy" | "medium" | "hard";
  }>;
  // Draft rankings specific data
  draftPicks?: Array<{
    teamName: string;
    teamAbbreviation: string;
    teamOwner: string;
    pickNumber: number;
    roundNumber: number;
    roundPickNumber: number;
    playerName: string;
    playerPosition: string;
    playerTeam: string;
    playerProjectedPoints: number | null;
    playerADP: number | null;
    perceivedValue: number;
    isRookie?: boolean; // True if player is a rookie
  }>;
  teamGrades?: Array<{
    teamName: string;
    teamOwner: string;
    grade: "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "F";
    gradeScore: number;
    strategy: {
      strategy: "Hero RB" | "Hero WR" | "Balanced" | "Zero RB" | "Zero WR" | "TE Premium" | "QB Early" | "Unknown";
      confidence: number;
      reasoning: string;
    };
    bestPicks: Array<{
      teamName: string;
      teamAbbreviation: string;
      teamOwner: string;
      pickNumber: number;
      roundNumber: number;
      roundPickNumber: number;
      playerName: string;
      playerPosition: string;
      playerTeam: string;
      playerProjectedPoints: number | null;
      playerADP: number | null;
      perceivedValue: number;
    }>;
    worstPicks: Array<{
      teamName: string;
      teamAbbreviation: string;
      teamOwner: string;
      pickNumber: number;
      roundNumber: number;
      roundPickNumber: number;
      playerName: string;
      playerPosition: string;
      playerTeam: string;
      playerProjectedPoints: number | null;
      playerADP: number | null;
      perceivedValue: number;
    }>;
    projectedStarterPoints: number;
    benchDepthScore: number;
    reasoning: string;
  }>;
  totalTeams?: number;
  [key: string]: unknown;
}

export class PromptBuilder {
  private options: PromptBuilderOptions;
  private template: ContentTemplate;
  private persona: PersonaPrompt;
  private facts: FactsBlock;

  constructor(options: PromptBuilderOptions) {
    // A placeholder ADP column (see `adpLooksLikePlaceholder`) is erased here so the prose and the
    // FACTS block agree that no ADP exists; perceivedValue is ADP-derived and goes with it.
    const picks = options.leagueData?.draftPicks;
    this.options = adpLooksLikePlaceholder(picks)
      ? {
          ...options,
          leagueData: {
            ...options.leagueData,
            draftPicks: (picks ?? []).map(pick => ({ ...pick, playerADP: null, perceivedValue: 0 })),
          },
        }
      : options;
    this.template = contentTemplates[options.contentType];
    // Unknown slugs fall back to the default anchor rather than throwing — archived and
    // mis-typed personas must still be able to produce an article.
    this.persona = getPersona(options.persona);

    if (!this.template) {
      throw new Error(`Unknown content type: ${options.contentType}`);
    }

    this.facts = buildFactsBlock(options);
  }

  build(): { systemPrompt: string; userPrompt: string; facts: FactsBlock; maxTokens: number } {
    if (this.facts.missing.length > 0) {
      console.warn("MISSING DATA for", this.options.contentType, this.facts.missing);
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt();

    console.log("=== PromptBuilder ===", {
      contentType: this.options.contentType,
      persona: this.persona.slug,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      factsTeams: this.facts.teams.length,
      factsMatchups: this.facts.matchups.length,
      factsUpcoming: this.facts.upcoming.length,
      factsQuotes: this.facts.quotes.length,
      factsMissing: this.facts.missing.length,
    });

    return { systemPrompt, userPrompt, facts: this.facts, maxTokens: this.persona.maxTokens };
  }

  /** System prompt order is fixed: contract, voice, quotes, relationships, template, gaps. */
  private buildSystemPrompt(): string {
    const persona = this.persona;
    const parts: string[] = [GROUNDING_CONTRACT];

    parts.push(`WHO YOU ARE
${persona.voice}

Your signature moves:
${persona.signatureMoves.map(move => `- ${move}`).join('\n')}

Never do these (style rules — they never override the grounding contract):
${persona.neverDo.map(rule => `- ${rule}`).join('\n')}

How you handle certainty:
- When the facts are strong: ${persona.truthPosture.whenCertain}
- When the data is thin: ${persona.truthPosture.whenUnsure}
- When something is listed in facts.missing: ${persona.truthPosture.whenDataMissing}`);

    parts.push(`QUOTES
- Attribution pattern: ${persona.quoteStyle.attributionPattern}
- How you react to a quote: ${persona.quoteStyle.reactionStyle}
- When a manager did not respond: ${persona.quoteStyle.whenNoQuote}

Hard rules for quotes:
- Quotation marks mean verbatim text from facts.quotes. Copy it character for character.
- A paraphrase never goes inside quotation marks.
- First reference is "Name, Team"; the team alone afterwards.
- A person in facts.nonRespondents may only be described with the sanctioned phrasing above. Never
  invent their reaction, their reasoning, or a reason for their silence.
- For every ledger quote you use, respond to it in voice in the same section. That reply is what you
  report in quotes[].writerResponse.

How a quote is placed in the body — this is the only way to print one:
- Put the directive line ":::quote{id=Q1}" on a line of its own, where the quote belongs, using the
  id from facts.quotes. Write it exactly like that, with no spaces inside the braces. One directive
  per quote, for every ledger quote you print.
- Do not also repeat the quote text inside quotation marks anywhere in the body. The directive
  prints the words, the speaker, the team and the week.
- Your reply to the quote goes in quotes[].writerResponse, not in the body prose.
- You may write your own prose in the lines after the directive; the directive line stands alone.
- Every id you place must exist in facts.quotes. There is no directive for a manager who did not
  respond.`);

    if (this.facts.relationships.length > 0) {
      const lines = this.facts.relationships.map(relationship => {
        const team = this.facts.teams.find(candidate => candidate.id === relationship.teamId);
        const posture = persona.relationshipPosture[relationship.tier];
        const recent = relationship.recentEvents
          .slice(0, 3)
          .map(event => `${event.week ? `Wk ${event.week}: ` : ''}${event.evidence} (${event.delta > 0 ? '+' : ''}${event.delta})`)
          .join(' · ');
        return `- ${relationship.manager} (${team?.name ?? relationship.teamId}): ${relationship.tier}, score ${relationship.score}. ${posture}${recent ? ` Recent: ${recent}` : ''}`;
      });

      parts.push(`RELATIONSHIPS
These are your standing relationships with the managers in this league. Relationship evidence is a
fact: you may quote it back ("you told Sam that I should stick to mock drafts").
${lines.join('\n')}`);
    }

    const recordBlock = this.buildRecordBlock();
    if (recordBlock) parts.push(recordBlock);

    const sections = this.templateSections();
    parts.push(`TEMPLATE — ${this.template.name}
Write these sections, in this order. Word counts are CEILINGS, never quotas.
${sections.map(section => `- ${section.name} (${section.description}): up to ${section.wordCount ?? 200} words`).join('\n')}
Whole-article ceiling: ${this.template.estimatedWords} words. Coming in well under it is a good outcome.`);

    // A preview is the one article whose subject has not happened yet. Without this, the model
    // reaches for the only games it can see - last week's - and files a recap under a preview
    // headline.
    if (this.options.contentType === 'weekly_preview') {
      parts.push(`LOOK-AHEAD — THIS ARTICLE IS A PREVIEW
- The games you are writing about are in facts.upcoming. Not one of them has been played. They have
  no score, no winner, no margin and no box score, and you must never describe one as if they did.
  Future tense only.
- Last week's results (facts.matchups) are context, never the subject. Cite a result to set a team
  up for the game ahead; do not recap the week. If your article reads like a recap, it is wrong.
- A projection is a projection, not a score. Say so whenever you use one, and never turn one into a
  result or a prediction of an exact final.
- Head-to-head numbers in facts.upcoming are games already played. They are history and may be
  cited as such.
- You may be as certain as your voice demands about what you EXPECT to happen. You may never state
  what DID happen in a game that has not been played.`);
    }

    if (this.facts.missing.length > 0) {
      parts.push(`MISSING DATA
The following is unavailable for this article. Name the gap in character if it matters; never fill it.
${this.facts.missing.map(entry => `- ${entry}`).join('\n')}`);
    }

    if (this.options.includeExamples !== false && persona.exampleOutputs.length > 0) {
      parts.push(`VOICE SAMPLES — style only. The braces are placeholders, not content. Never copy a
placeholder, a number, or a name out of these lines into your article.
${persona.exampleOutputs.map(sample => `- ${sample}`).join('\n')}`);
    }

    return parts.join('\n\n');
  }

  /**
   * YOUR RECORD (spec §8.4). Emitted only when the writer actually has a history in this league —
   * resolved claims are quotable facts; an empty ledger is not a licence to invent one.
   */
  private buildRecordBlock(): string | null {
    const claims = this.facts.priorClaims;
    const record = this.facts.priorRecord;
    const decided = record ? record.hits + record.misses : 0;
    if (claims.length === 0 && decided === 0) return null;

    const parts = [`YOUR RECORD
These are predictions you made in earlier articles for this league, and how they turned out. They
are facts. You may cite one by week, with its outcome, in your own words. Nothing else about your
past coverage is available to you.`];

    if (claims.length > 0) {
      parts.push(
        claims
          .map(claim => {
            const week = claim.week ? `Wk ${claim.week}` : 'undated';
            return `- [${week}] ${claim.outcome ?? 'open'}: "${claim.claim}"`;
          })
          .join('\n')
      );
    }

    if (record && decided > 0) {
      const open = record.open > 0 ? `, with ${record.open} still open` : '';
      parts.push(
        `Your record in this league is ${record.hits}-${record.misses}${open}. You may state it once, in a single line.`
      );
      if (this.persona.slug === 'mel-diaper') {
        parts.push(`Close the article with this line, exactly: "Mel's Receipts: ${record.hits}-${record.misses}"`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * A readable rendering of `this.facts.format` (spec: format audit). Every field it prints is
   * already in the FACTS block above it — this is prose, not a new source of truth — so a section
   * with nothing to say for the requested lines is simply omitted rather than guessed at.
   */
  private formatLines(fields: Array<"scoring" | "roster" | "playoffs" | "divisions" | "waivers" | "tradeDeadline">): string {
    const format = this.facts.format;
    const lines: string[] = [];

    if (fields.includes("scoring") && format.scoring) {
      lines.push(`- Scoring: ${format.scoring}`);
    }
    if (fields.includes("roster") && format.rosterShape) {
      lines.push(`- Roster: ${format.rosterShape}`);
    }
    if (fields.includes("playoffs")) {
      if (format.regularSeasonWeeks !== undefined) {
        lines.push(`- Regular season: ${format.regularSeasonWeeks} weeks`);
      }
      if (format.playoffTeamCount !== undefined) {
        let playoffLine = `- Playoffs: ${format.playoffTeamCount} teams`;
        if (format.playoffRounds !== undefined) playoffLine += `, ${format.playoffRounds} rounds`;
        if (format.playoffRoundLengthWeeks === 2) playoffLine += ' (two-week rounds)';
        if (format.playoffWeeksRange) playoffLine += ` — ${format.playoffWeeksRange}`;
        lines.push(playoffLine);
      } else {
        lines.push('- Playoffs: field size not in the payload. Do not assume a number of playoff teams.');
      }
      if (format.seedingRule) lines.push(`- Seeding: ${format.seedingRule}`);
    }
    if (fields.includes("divisions") && format.divisions.length > 0) {
      lines.push(`- Divisions: ${format.divisions.map(division => division.name).join(', ')}`);
    }
    if (fields.includes("waivers")) {
      if (format.waiverType) {
        lines.push(`- Waivers: ${format.waiverType}`);
      } else {
        lines.push('- Waivers: type not in the payload. Do not assume FAAB or rolling waivers.');
      }
    }
    if (fields.includes("tradeDeadline") && format.tradeDeadline) {
      const status =
        format.tradeDeadlineStatus === 'passed'
          ? 'has passed'
          : format.tradeDeadlineStatus === 'soon'
            ? 'is coming up soon'
            : undefined;
      lines.push(`- Trade deadline: ${format.tradeDeadline}${status ? ` (${status})` : ''}`);
    }

    return lines.length > 0 ? `LEAGUE FORMAT:\n${lines.join('\n')}\n` : '';
  }

  /** Template sections, with the weekly-recap playoff sections resolved against the payload. */
  private templateSections() {
    const playoffData = (this.options.leagueData as LeagueDataContext & { playoffBreakdown?: PlayoffBreakdown })
      .playoffBreakdown;

    return this.template.sections.filter(section => {
      // A quotes section exists only when there are quotes — for every content type.
      if (section.name === 'team_comments') return this.facts.quotes.length > 0;
      if (this.options.contentType !== 'weekly_recap') return section.required;
      if (section.name === 'championship_game') return playoffData?.isChampionshipWeek || false;
      if (section.name === 'playoff_games') {
        return (playoffData?.playoffGameCount || 0) > 0 && !playoffData?.isChampionshipWeek;
      }
      if (section.name === 'playoff_implications') return playoffData?.isPlayoffWeek || false;
      return section.required;
    });
  }

  private buildUserPrompt(): string {
    const { leagueData, customContext } = this.options;

    // FACTS first. Everything after it is a readable rendering of the same data.
    let prompt = `${serializeFacts(this.facts)}

Write a ${this.template.name} article for "${leagueData.leagueName}".

The <FACTS> block above is the complete set of facts available to you. Cite ids from it in the
structured fields of your output. The prose below restates the same data in a more readable form —
where the two ever disagree, <FACTS> wins.
`;

    const sections = this.templateSections();
    prompt += `\nSECTIONS (word counts are ceilings):\n`;
    sections.forEach(section => {
      prompt += `- ${section.name} (${section.description}): up to ${section.wordCount ?? 200} words\n`;
    });

    prompt += `\n${this.addContentSpecificData(leagueData)}`;

    if (customContext) {
      prompt += `\nADDITIONAL CONTEXT FROM THE COMMISSIONER:\n${customContext}\n`;
    }

    prompt += `\nFORMATTING AND ACCURACY
- Markdown prose. Clear section headings written in your voice.
- Stay in character throughout, and stay inside the grounding contract throughout.
- Refer to teams and managers by the names in <FACTS>. Never print a raw id in the prose.
- Attribute a player to a fantasy team only via that player's fantasyTeamId. A player object's
  nflTeam is their NFL club and is never their fantasy team.
- Bench players: only discuss one when the player carries a benchImpact object, and when you do,
  say plainly that they were benched, who they would have replaced, and the point gain from
  benchImpact. Bench players without benchImpact are not part of the story.
- Every number you print must be in <FACTS>, or a sum or difference of two numbers that are, with
  both inputs shown.
- If a section has thin material, write less. Padding is the failure mode this desk cares about.`;

    return prompt;
  }

  private addContentSpecificData(data: LeagueDataContext): string {
    let contextData = '';

    switch (this.options.contentType) {
      case 'weekly_recap':
        contextData = this.buildWeeklyRecapData(data);
        break;
      case 'weekly_preview':
        contextData = this.buildWeeklyPreviewData(data);
        break;
      case 'power_rankings':
        contextData = this.buildPowerRankingsData(data);
        break;
      case 'trade_analysis':
        contextData = this.buildTradeAnalysisData(data);
        break;
      case 'rivalry_week_special':
        contextData = this.buildRivalryData(data);
        break;
      case 'waiver_wire_report':
        contextData = this.buildWaiverWireData(data);
        break;
      case 'season_welcome':
        contextData = this.buildSeasonWelcomeData(data);
        break;
      case 'mock_draft':
        contextData = this.buildMockDraftData(data);
        break;
      case 'draft_rankings':
        contextData = this.buildDraftRankingsData(data);
        break;
      case 'trade_rumor_mill':
        contextData = this.buildTradeRumorData(data);
        break;
      // Spec §8.5. Each of the seven has a path; the ones whose material is the ordinary league
      // overview reuse `buildGenericData` rather than inventing a near-duplicate builder.
      case 'draft_strategy_guide':
        contextData = this.buildDraftStrategyData(data);
        break;
      case 'team_name_power_rankings':
        contextData = this.buildTeamNameRankingsData(data);
        break;
      case 'trade_block_tuesday':
        contextData = this.buildTradeRumorData(data);
        break;
      case 'playoff_picture':
        contextData = this.buildPlayoffPictureData(data);
        break;
      case 'commissioner_corner':
      case 'hall_of_shame':
      case 'player_glazing':
        contextData = this.buildGenericData(data);
        break;
      default:
        contextData = this.buildGenericData(data);
    }

    return contextData;
  }

  private formatMatchupDetails(matchup: Matchup, isChampionshipGame = false, isPlayoffGame = false): string {
    const teamAInfo = matchup.teamAOwner ? `${matchup.teamA} (${matchup.teamAOwner})` : matchup.teamA;
    const teamBInfo = matchup.teamBOwner ? `${matchup.teamB} (${matchup.teamBOwner})` : matchup.teamB;
    let details = `\n${teamAInfo} (${matchup.scoreA}) vs ${teamBInfo} (${matchup.scoreB})`;
    
    // Add projected scores for context
    if (matchup.projectedScoreA && matchup.projectedScoreB) {
      details += `\n  Projected: ${matchup.projectedScoreA.toFixed(1)} - ${matchup.projectedScoreB.toFixed(1)}`;
    }
    
    // Add playoff tier information
    if (matchup.playoffTier) {
      details += ` [${matchup.playoffTier}]`;
    }
    
    // Determine closeness and upsets with enhanced messaging
    if (matchup.closeness) {
      details += ` [${matchup.closeness.toUpperCase()}]`;
    }
    if (matchup.isUpset) {
      if (isChampionshipGame) {
        details += ' **CHAMPIONSHIP UPSET**';
      } else if (isPlayoffGame) {
        details += ' **PLAYOFF UPSET**';
      } else {
        details += ' **UPSET**';
      }
    }
    
    // Enhanced memorable moments
    if (matchup.memorableMoment) {
      details += `\n  💥 ${matchup.memorableMoment}`;
    }
    
    details += '\n';
    
    // Top performers with enhanced detail for championship/playoff games
    if (matchup.topPerformers && matchup.topPerformers.length > 0) {
      const performerCount = isChampionshipGame ? 5 : (isPlayoffGame ? 4 : 3);
      details += '  Top performers:\n';
      matchup.topPerformers.slice(0, performerCount).forEach((perf) => {
        const loose = perf as unknown as Record<string, unknown>;
        const playerName = perf.playerName || perf.player || 'Unknown Player';
        const position = perf.position ? ` (${perf.position})` : '';
        // `fantasyTeamName` is authoritative. `nflTeam` is a separate, differently-named key.
        // The legacy `team` key is ambiguous and only used when nothing better is present.
        const fantasyTeam =
          (typeof loose.fantasyTeamName === 'string' && loose.fantasyTeamName) ||
          (typeof loose.teamName === 'string' && loose.teamName) ||
          perf.team;
        const nflTeam = typeof loose.nflTeam === 'string' ? loose.nflTeam : undefined;
        const fantasyLabel = fantasyTeam ? ` fantasy team: ${fantasyTeam}` : '';
        const nflLabel = nflTeam ? `, NFL: ${nflTeam}` : '';
        const overPerf = perf.overPerformance ? ` (+${perf.overPerformance}% vs proj)` : '';
        const lineupStatus = perf.isStarter === false ? ' [BENCH]' : ' [STARTER]';
        const benchNote = perf.benchImpact && perf.wouldHaveReplacedPlayer ?
          ` (would have replaced ${perf.wouldHaveReplacedPlayer} for +${perf.pointImprovementIfStarted} pts)` : '';
        details += `    - ${playerName}${position} - ${perf.points.toFixed(1)} pts${overPerf}${lineupStatus}${benchNote} —${fantasyLabel}${nflLabel}\n`;
      });
    }
    
    // Bench points analysis (especially important for close games)
    if (matchup.benchPointsA !== undefined && matchup.benchPointsB !== undefined) {
      details += `  Bench points: ${matchup.teamA} (${matchup.benchPointsA.toFixed(1)}) vs ${matchup.teamB} (${matchup.benchPointsB.toFixed(1)})\n`;
      
      // Highlight significant bench disparities
      const benchDiff = Math.abs(matchup.benchPointsA - matchup.benchPointsB);
      if (benchDiff > 20) {
        const strongerBench = matchup.benchPointsA > matchup.benchPointsB ? matchup.teamA : matchup.teamB;
        details += `  📊 ${strongerBench} had significantly stronger bench production (+${benchDiff.toFixed(1)} pts)\n`;
      }
    }
    
    return details;
  }

  private buildWeeklyRecapData(data: LeagueDataContext): string {
    if (!data.recentMatchups || data.recentMatchups.length === 0) {
      throw new InsufficientDataError('weekly_recap', ['matchup_results']);
    }

    let recap = '';
    
    // Check if we have playoff breakdown data
    const hasPlayoffData = (data as LeagueDataContext & { playoffBreakdown?: PlayoffBreakdown }).playoffBreakdown;
    if (hasPlayoffData) {
      const playoffData = (data as LeagueDataContext & { playoffBreakdown?: PlayoffBreakdown }).playoffBreakdown;
      
      // Add playoff context header
      if (playoffData?.isChampionshipWeek) {
        recap += '🏆 CHAMPIONSHIP WEEK 🏆\n\n';
      } else if (playoffData?.isPlayoffWeek) {
        recap += '🏈 PLAYOFF WEEK 🏈\n\n';
      } else {
        recap += 'THIS WEEK\'S MATCHUPS:\n\n';
      }
      
      // CHAMPIONSHIP GAME (highest priority)
      if (playoffData?.isChampionshipWeek && playoffData?.championshipGame) {
        recap += '🏆 CHAMPIONSHIP GAME:\n';
        recap += this.formatMatchupDetails(playoffData?.championshipGame, true);
        recap += '\n';
      }
      
      // PLAYOFF GAMES (WINNERS_BRACKET)
      if (playoffData?.playoffMatchups && playoffData.playoffMatchups.length > 0 && !playoffData?.isChampionshipWeek) {
        recap += '🏈 PLAYOFF GAMES (Winners Bracket):\n';
        playoffData?.playoffMatchups?.forEach((matchup) => {
          recap += this.formatMatchupDetails(matchup, false, true);
        });
        recap += '\n';
      }
      
      // CONSOLATION GAMES
      if (playoffData?.consolationMatchups && playoffData.consolationMatchups.length > 0) {
        const bracketType = playoffData?.consolationMatchups?.[0]?.playoffTier === 'WINNERS_CONSOLATION_LADDER' 
          ? 'Consolation Playoff' : 'Consolation';
        recap += `📊 ${bracketType.toUpperCase()} GAMES:\n`;
        playoffData?.consolationMatchups?.forEach((matchup) => {
          recap += this.formatMatchupDetails(matchup);
        });
        recap += '\n';
      }
      
      // REGULAR SEASON GAMES (if any)
      if (playoffData?.regularSeasonMatchups && playoffData.regularSeasonMatchups.length > 0) {
        recap += '📅 REGULAR SEASON GAMES:\n';
        playoffData?.regularSeasonMatchups?.forEach((matchup) => {
          recap += this.formatMatchupDetails(matchup);
        });
        recap += '\n';
      }
    } else {
      // Fallback to original format if no playoff data
      recap += 'THIS WEEK\'S MATCHUPS:\n';
      data.recentMatchups.forEach(matchup => {
        recap += this.formatMatchupDetails(matchup);
      });
    }

    // Add injury report with impact analysis
    if (data.injuryReport && data.injuryReport.length > 0) {
      recap += '\nKEY INJURIES & FANTASY IMPACT:\n';
      data.injuryReport.slice(0, 5).forEach(injury => {
        recap += `- ${injury.playerName} (${injury.position}, ${injury.team}) - ${injury.status}`;
        if (injury.fantasyImpact) {
          recap += ` - ${injury.fantasyImpact}`;
        }
        recap += '\n';
      });
    }

    // Enhanced standings with streaks
    if (data.standings) {
      recap += '\nCURRENT STANDINGS & MOMENTUM:\n';
      data.standings.slice(0, 6).forEach(team => {
        recap += `${team.rank}. ${team.team} (${team.wins}-${team.losses}`;
        if (team.ties > 0) recap += `-${team.ties}`;
        recap += `)`;
        if (team.streakType && team.streakLength) {
          recap += ` [${team.streakType}${team.streakLength}]`;
        }
        if (team.playoffSeed) {
          recap += ` - #${team.playoffSeed} seed`;
        }
        if (team.division) {
          recap += ` [${team.division}]`;
        }
        recap += '\n';
      });
      const divisionsLine = this.formatLines(['divisions']);
      if (divisionsLine) recap += `\n${divisionsLine}`;
    }

    // Manager activity highlights
    if (data.managerActivity && data.managerActivity.length > 0) {
      recap += '\nMANAGER ACTIVITY THIS WEEK:\n';
      const activeManagers = data.managerActivity
        .filter(m => m.totalTransactions > 0)
        .sort((a, b) => b.totalTransactions - a.totalTransactions)
        .slice(0, 3);
      
      activeManagers.forEach(manager => {
        recap += `- ${manager.manager}: ${manager.totalTransactions} moves`;
        if (manager.trades > 0) recap += ` (${manager.trades} trades)`;
        recap += '\n';
      });
    }

    // Recent transactions
    if (data.transactions && data.transactions.length > 0) {
      const recentTransactions = data.transactions.slice(0, 5);
      recap += '\nNOTABLE TRANSACTIONS:\n';
      recentTransactions.forEach(trans => {
        if (trans.type === 'waiver_claim' && trans.playerAdded) {
          recap += `- ${trans.teamName} claimed ${trans.playerAdded.playerName} (${trans.playerAdded.position})`;
          if (trans.faabBid) recap += ` for $${trans.faabBid} FAAB`;
          recap += '\n';
        } else if (trans.type === 'add_drop' && trans.playerAdded && trans.playerDropped) {
          recap += `- ${trans.teamName} added ${trans.playerAdded.playerName} (${trans.playerAdded.position}), dropped ${trans.playerDropped.playerName}\n`;
        }
      });
    }

    // Weather impact if any
    if (data.weatherImpact && data.weatherImpact.length > 0) {
      recap += '\nWEATHER IMPACT:\n';
      data.weatherImpact.slice(0, 3).forEach(weather => {
        recap += `- ${weather.game}: ${weather.conditions}`;
        if (weather.fantasyImpact) {
          recap += ` (Passing: ${weather.fantasyImpact.passing})`;
        }
        recap += '\n';
      });
    }

    if (this.facts.waivers.latestRun && this.facts.waivers.latestRun.claims.length > 0) {
      recap += `\nIf a waiver claim from this week is relevant to a team in this recap, facts.waivers
in the <FACTS> block above has it (W… lines). You may cite one; keep it to a line, never the focus.\n`;
    }

    return recap;
  }

  /**
   * The look-ahead slate. `weekly_preview` is the one content type whose subject has not happened
   * yet, so it is built from `upcomingMatchups` (unplayed games) and never from `recentMatchups`.
   * Last week's results appear only as one line of context per side.
   *
   * With no upcoming games there is nothing to preview, and inventing a slate is exactly the
   * failure this refuses: the pipeline surfaces the gap and refunds instead.
   */
  private buildWeeklyPreviewData(data: LeagueDataContext): string {
    const upcoming = data.upcomingMatchups ?? [];
    if (upcoming.length === 0) {
      throw new InsufficientDataError('weekly_preview', ['upcoming_matchups']);
    }

    const week = upcoming[0].week ?? data.currentWeek + 1;
    let preview = `WEEK ${week} SLATE — NONE OF THESE GAMES HAS BEEN PLAYED.\n`;
    preview += `There is no score, no winner and no box score for any of them. Everything below is\n`;
    preview += `season-to-date form and, where ESPN published one, a projection.\n`;

    upcoming.forEach((game, index) => {
      const home = game.teamAOwner ? `${game.teamA} (${game.teamAOwner})` : game.teamA;
      const away = game.teamBOwner ? `${game.teamB} (${game.teamBOwner})` : game.teamB;
      const homeForm = this.formatPreviewForm(game.teamARecord, game.teamAPointsFor);
      const awayForm = this.formatPreviewForm(game.teamBRecord, game.teamBPointsFor);

      preview += `\nGAME ${index + 1}${game.isPlayoff ? ' [PLAYOFF]' : ''}: ${home}${homeForm} vs ${away}${awayForm}`;

      if (game.projectedScoreA !== undefined && game.projectedScoreB !== undefined) {
        preview += `\n  Projected: ${game.projectedScoreA.toFixed(1)} - ${game.projectedScoreB.toFixed(1)} (a projection, not a result)`;
      } else {
        preview += `\n  Projected: not published for this game`;
      }

      if (game.headToHead && game.headToHead.teamAWins + game.headToHead.teamBWins > 0) {
        const { teamAWins, teamBWins } = game.headToHead;
        const leader =
          teamAWins === teamBWins
            ? `even at ${teamAWins}-${teamBWins}`
            : teamAWins > teamBWins
              ? `${game.teamA} leads ${teamAWins}-${teamBWins}`
              : `${game.teamB} leads ${teamBWins}-${teamAWins}`;
        preview += `\n  Head-to-head on record: ${leader}`;
      }

      const homeLast = this.lastResultLine(data, game.teamA, game.teamAId);
      const awayLast = this.lastResultLine(data, game.teamB, game.teamBId);
      if (homeLast) preview += `\n  ${game.teamA} last time out: ${homeLast}`;
      if (awayLast) preview += `\n  ${game.teamB} last time out: ${awayLast}`;
      preview += '\n';
    });

    if (data.standings && data.standings.length > 0) {
      preview += `\nSTANDINGS GOING IN:\n`;
      data.standings.forEach(team => {
        const row = team as typeof team & { teamName?: string; pointsFor?: number };
        preview += `${team.rank}. ${team.team ?? row.teamName ?? "Unknown team"} (${team.wins}-${team.losses}`;
        if (team.ties > 0) preview += `-${team.ties}`;
        preview += typeof row.pointsFor === "number" ? `) — ${row.pointsFor.toFixed(1)} PF` : `)`;
        if (team.streakType && team.streakLength) preview += ` [${team.streakType}${team.streakLength}]`;
        preview += '\n';
      });
    }

    if (data.injuryReport && data.injuryReport.length > 0) {
      preview += `\nINJURY REPORT:\n`;
      data.injuryReport.slice(0, 5).forEach(injury => {
        preview += `- ${injury.playerName} (${injury.position}, ${injury.team}) — ${injury.status}`;
        if (injury.fantasyImpact) preview += ` — ${injury.fantasyImpact}`;
        preview += '\n';
      });
    }

    preview += `\nWEEKLY PREVIEW RULES:
- Every game above is unplayed. Write about it in the future tense only. No result, no winner, no
  margin, no "held on", no "survived" — none of that exists yet for these games.
- Last week is context, never the subject. One line of it per team is the ceiling, and only where it
  sets up the game ahead. If you find yourself recapping, you have written the wrong article.
- A projection is a projection. Say so when you use one, and never report it as a score.
- Head-to-head numbers above are games already played and may be cited as history.
- The only facts about these games are the records, points for, projections and head-to-head above.
  Anything else about them has not happened.`;

    return preview;
  }

  /** " [5-2-0, 733.5 PF]" — the season-to-date form printed beside a team in the preview. */
  private formatPreviewForm(record?: string, pointsFor?: number): string {
    const parts: string[] = [];
    if (record) parts.push(record);
    if (pointsFor !== undefined) parts.push(`${pointsFor.toFixed(1)} PF`);
    return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
  }

  /**
   * One line of context for a team's most recent completed game, drawn from `recentMatchups`.
   * Both matchup shapes are accepted (ids or names in `teamA`/`teamB`), and the line always names
   * both scores so nothing in it is a number the writer cannot source.
   */
  private lastResultLine(data: LeagueDataContext, teamName: string, teamId?: string): string | null {
    const keys = new Set(
      [teamName, teamId].filter((value): value is string => Boolean(value)).map(value => value.toLowerCase())
    );

    let best: { week: number; line: string } | null = null;

    for (const matchup of data.recentMatchups ?? []) {
      const loose = matchup as unknown as Record<string, unknown>;
      const sideKeys = (...candidates: unknown[]) =>
        candidates
          .filter((value): value is string => typeof value === 'string')
          .map(value => value.toLowerCase());

      const homeKeys = sideKeys(matchup.teamA, loose.teamAName, loose.teamAId);
      const awayKeys = sideKeys(matchup.teamB, loose.teamBName, loose.teamBId);
      const isHome = homeKeys.some(key => keys.has(key));
      const isAway = awayKeys.some(key => keys.has(key));
      if (!isHome && !isAway) continue;

      const week = matchup.week ?? data.currentWeek;
      if (best && best.week >= week) continue;

      const own = isHome ? matchup.scoreA : matchup.scoreB;
      const other = isHome ? matchup.scoreB : matchup.scoreA;
      const opponent = isHome
        ? (typeof loose.teamBName === 'string' ? loose.teamBName : matchup.teamB)
        : (typeof loose.teamAName === 'string' ? loose.teamAName : matchup.teamA);

      const verdict = own > other ? 'beat' : own < other ? 'lost to' : 'tied';
      let line = `week ${week}, ${verdict} ${opponent} ${own.toFixed(1)}-${other.toFixed(1)}`;

      const bench = isHome ? matchup.benchPointsA : matchup.benchPointsB;
      if (typeof bench === 'number' && bench > 0) {
        line += `, ${bench.toFixed(1)} points left on the bench`;
      }

      best = { week, line };
    }

    return best ? best.line : null;
  }

  private buildPowerRankingsData(data: LeagueDataContext): string {
    let rankings = this.formatLines(['divisions']);
    rankings += 'CURRENT TEAM RECORDS (playoff seed order when known):\n';

    const sortedTeams = [...data.teams].sort((a, b) => {
      const seedA = a.playoffSeed;
      const seedB = b.playoffSeed;
      if (seedA !== undefined && seedB !== undefined) return seedA - seedB;
      if (seedA !== undefined) return -1;
      if (seedB !== undefined) return 1;
      const winDiff = b.record.wins - a.record.wins;
      return winDiff !== 0 ? winDiff : b.pointsFor - a.pointsFor;
    });

    sortedTeams.forEach((team, index) => {
      rankings += `${index + 1}. ${team.name} (${team.record.wins}-${team.record.losses}`;
      if (team.record.ties > 0) rankings += `-${team.record.ties}`;
      const pointsFor = team.pointsFor ?? team.record.pointsFor ?? 0;
      const pointsAgainst = team.pointsAgainst ?? team.record.pointsAgainst ?? 0;
      rankings += `) - ${pointsFor.toFixed(1)} PF, ${pointsAgainst.toFixed(1)} PA`;
      if (team.division) rankings += ` [${team.division}]`;
      rankings += '\n';
      
      // Add top performers from each team
      if (team.roster && team.roster.length > 0) {
        const topPlayers = team.roster
          .filter(p => p.stats?.seasonStats?.averagePoints)
          .sort((a, b) => (b.stats?.seasonStats?.averagePoints || 0) - (a.stats?.seasonStats?.averagePoints || 0))
          .slice(0, 2);
        
        if (topPlayers.length > 0) {
          rankings += `  Key players: `;
          topPlayers.forEach((player, idx) => {
            const avg = player.stats?.seasonStats?.averagePoints?.toFixed(1) || '0';
            rankings += `${player.fullName || player.playerName} (${avg} ppg)`;
            if (idx < topPlayers.length - 1) rankings += ', ';
          });
          rankings += '\n';
        }
      }
    });

    // Add recent performance trends
    if (data.recentMatchups && data.recentMatchups.length > 0) {
      rankings += '\nRECENT PERFORMANCE TRENDS:\n';
      
      // Calculate recent scoring averages
      const recentScores: Record<string, number[]> = {};
      data.recentMatchups.forEach(matchup => {
        if (!recentScores[matchup.teamA]) recentScores[matchup.teamA] = [];
        if (!recentScores[matchup.teamB]) recentScores[matchup.teamB] = [];
        recentScores[matchup.teamA].push(matchup.scoreA);
        recentScores[matchup.teamB].push(matchup.scoreB);
      });
      
      Object.entries(recentScores).slice(0, 5).forEach(([teamId, scores]) => {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const team = data.teams.find(t => t.externalId === teamId || t.name === teamId);
        if (team) {
          rankings += `- ${team.name}: ${avg.toFixed(1)} ppg last ${scores.length} games\n`;
        }
      });
    }

    if (this.facts.waivers.isFaab && this.facts.waivers.budgets.length > 0) {
      rankings += `\nFAAB remaining is a standings-adjacent fact: facts.waivers.budgets in the <FACTS>
block above has each team's B… line. If a team's waiver spend is relevant to its ranking, you may
cite it; keep it to a line, never the focus.\n`;
    }

    return rankings;
  }

  private buildTradeAnalysisData(data: LeagueDataContext): string {
    if (!data.trades || data.trades.length === 0) {
      throw new InsufficientDataError('trade_analysis', ['trade_details']);
    }

    const latestTrade = data.trades[0];
    const teamAData = data.teams.find(t => t.name === latestTrade.teamA || t.externalId === latestTrade.teamA);
    const teamBData = data.teams.find(t => t.name === latestTrade.teamB || t.externalId === latestTrade.teamB);

    let tradeAnalysis = `TRADE DETAILS:
Team A: ${latestTrade.teamA}
- Record: ${teamAData ? `${teamAData.record.wins}-${teamAData.record.losses}` : 'Unknown'}
- Standing: ${data.standings?.find(s => s.team === latestTrade.teamA)?.rank || 'Unknown'}
- Manager: ${teamAData?.manager || 'Unknown'}

Team B: ${latestTrade.teamB}
- Record: ${teamBData ? `${teamBData.record.wins}-${teamBData.record.losses}` : 'Unknown'}
- Standing: ${data.standings?.find(s => s.team === latestTrade.teamB)?.rank || 'Unknown'}
- Manager: ${teamBData?.manager || 'Unknown'}

Players from Team A: ${latestTrade.playersFromA.map(p => `${p.playerName} (${p.position})`).join(', ')}
Players from Team B: ${latestTrade.playersFromB.map(p => `${p.playerName} (${p.position})`).join(', ')}
Trade Date: ${latestTrade.date}
`;

    // Add player performance data if available
    if (latestTrade.playersFromA.length > 0 && teamAData?.roster) {
      tradeAnalysis += '\nPLAYER PERFORMANCE (Team A assets):\n';
      latestTrade.playersFromA.forEach(player => {
        const rosterPlayer = teamBData?.roster?.find(p => p.playerId === player.playerId);
        if (rosterPlayer?.stats?.seasonStats) {
          tradeAnalysis += `- ${player.playerName}: ${rosterPlayer.stats.seasonStats.averagePoints?.toFixed(1)} ppg`;
          if (rosterPlayer.stats.recentPerformance) {
            tradeAnalysis += ` (${rosterPlayer.stats.recentPerformance.trend})`;
          }
          if (rosterPlayer.injuryStatus) {
            tradeAnalysis += ` [${rosterPlayer.injuryStatus}]`;
          }
          tradeAnalysis += '\n';
        }
      });
    }

    if (latestTrade.playersFromB.length > 0 && teamBData?.roster) {
      tradeAnalysis += '\nPLAYER PERFORMANCE (Team B assets):\n';
      latestTrade.playersFromB.forEach(player => {
        const rosterPlayer = teamAData?.roster?.find(p => p.playerId === player.playerId);
        if (rosterPlayer?.stats?.seasonStats) {
          tradeAnalysis += `- ${player.playerName}: ${rosterPlayer.stats.seasonStats.averagePoints?.toFixed(1)} ppg`;
          if (rosterPlayer.stats.recentPerformance) {
            tradeAnalysis += ` (${rosterPlayer.stats.recentPerformance.trend})`;
          }
          if (rosterPlayer.injuryStatus) {
            tradeAnalysis += ` [${rosterPlayer.injuryStatus}]`;
          }
          tradeAnalysis += '\n';
        }
      });
    }

    // Add team needs analysis
    tradeAnalysis += '\nTEAM NEEDS ANALYSIS:\n';
    if (teamAData?.roster) {
      const positionCounts: Record<string, number> = {};
      teamAData.roster.forEach(p => {
        const pos = p.position.replace(/[0-9]/g, '');
        positionCounts[pos] = (positionCounts[pos] || 0) + 1;
      });
      tradeAnalysis += `Team A depth: RB(${positionCounts['RB'] || 0}), WR(${positionCounts['WR'] || 0}), TE(${positionCounts['TE'] || 0})\n`;
    }
    if (teamBData?.roster) {
      const positionCounts: Record<string, number> = {};
      teamBData.roster.forEach(p => {
        const pos = p.position.replace(/[0-9]/g, '');
        positionCounts[pos] = (positionCounts[pos] || 0) + 1;
      });
      tradeAnalysis += `Team B depth: RB(${positionCounts['RB'] || 0}), WR(${positionCounts['WR'] || 0}), TE(${positionCounts['TE'] || 0})\n`;
    }

    if (latestTrade.tradeGrade) {
      tradeAnalysis += `\nINITIAL GRADES: Team A: ${latestTrade.tradeGrade.teamA}, Team B: ${latestTrade.tradeGrade.teamB}\n`;
    }

    const tradeDeadlineLine = this.formatLines(['tradeDeadline']);
    if (tradeDeadlineLine) tradeAnalysis += `\n${tradeDeadlineLine}`;

    tradeAnalysis += '\nAnalyze this trade considering team needs, player performance trends, injury risks, and playoff implications.';
    
    return tradeAnalysis;
  }

  private buildRivalryData(data: LeagueDataContext): string {
    // Check for existing rivalries
    if (data.rivalries && data.rivalries.length > 0) {
      // Find the most intense rivalry
      const rivalry = data.rivalries.find(r => r.intensity === "bitter" || r.intensity === "heated") || data.rivalries[0];
      
      let rivalryData = `RIVALRY MATCHUP:
${rivalry.teamA.name} vs ${rivalry.teamB.name}

RIVALRY HISTORY:
- All-time record: ${rivalry.teamA.name} ${rivalry.allTimeRecord.teamAWins}-${rivalry.allTimeRecord.teamBWins}${rivalry.allTimeRecord.ties > 0 ? `-${rivalry.allTimeRecord.ties}` : ''}
- Intensity level: ${rivalry.intensity.toUpperCase()}
${rivalry.backstory ? `- Backstory: ${rivalry.backstory}` : ''}

CURRENT SEASON STATUS:
`;
      
      const teamAData = data.teams.find(t => t.id === rivalry.teamA.id || t.externalId === rivalry.teamA.id);
      const teamBData = data.teams.find(t => t.id === rivalry.teamB.id || t.externalId === rivalry.teamB.id);
      
      if (teamAData && teamBData) {
        rivalryData += `${rivalry.teamA.name}: ${teamAData.record.wins}-${teamAData.record.losses}, ${(teamAData.pointsFor ?? teamAData.record.pointsFor ?? 0).toFixed(1)} PF
${rivalry.teamB.name}: ${teamBData.record.wins}-${teamBData.record.losses}, ${(teamBData.pointsFor ?? teamBData.record.pointsFor ?? 0).toFixed(1)} PF

RECENT FORM:
`;
        if (teamAData.recentForm) {
          rivalryData += `${rivalry.teamA.name}: ${teamAData.recentForm.wins}-${teamAData.recentForm.losses} last 3 weeks, ${teamAData.recentForm.avgPoints.toFixed(1)} ppg\n`;
        }
        if (teamBData.recentForm) {
          rivalryData += `${rivalry.teamB.name}: ${teamBData.recentForm.wins}-${teamBData.recentForm.losses} last 3 weeks, ${teamBData.recentForm.avgPoints.toFixed(1)} ppg\n`;
        }
      }
      
      if (rivalry.recentGames && rivalry.recentGames.length > 0) {
        rivalryData += '\nRECENT HEAD-TO-HEAD:\n';
        rivalry.recentGames.slice(-3).forEach(game => {
          rivalryData += `Week ${game.week}: ${rivalry.teamA.name} ${game.scoreA} - ${game.scoreB} ${rivalry.teamB.name}\n`;
        });
      }
      
      rivalryData += '\nWrite about this matchup using the history above. Every head-to-head result you cite must appear in <FACTS> or in the lines above.';
      
      return rivalryData;
    }
    
    // No imported rivalry record. Fall back to the two best teams, and say so.
    const sortedTeams = [...data.teams].sort((a, b) => b.record.wins - a.record.wins);
    if (sortedTeams.length < 2) {
      throw new InsufficientDataError('rivalry_week_special', ['rivalry_history', 'team_rosters']);
    }
    const team1 = sortedTeams[0];
    const team2 = sortedTeams[1];

    let rivalryData = `RIVALRY MATCHUP:
${team1.name} (${team1.record.wins}-${team1.record.losses}) vs ${team2.name} (${team2.record.wins}-${team2.record.losses})

CURRENT SEASON STATS:
${team1.name}:
- Manager: ${team1.manager}
- Points For: ${(team1.pointsFor ?? team1.record.pointsFor ?? 0).toFixed(1)}
- Playoff Seed: ${team1.playoffSeed || 'TBD'}
${team1.recentForm ? `- Recent Form: ${team1.recentForm.wins}-${team1.recentForm.losses}, ${team1.recentForm.avgPoints.toFixed(1)} ppg` : ''}

${team2.name}:
- Manager: ${team2.manager}
- Points For: ${(team2.pointsFor ?? team2.record.pointsFor ?? 0).toFixed(1)}
- Playoff Seed: ${team2.playoffSeed || 'TBD'}
${team2.recentForm ? `- Recent Form: ${team2.recentForm.wins}-${team2.recentForm.losses}, ${team2.recentForm.avgPoints.toFixed(1)} ppg` : ''}
`;

    // Check for previous matchups this season
    const headToHead = data.recentMatchups?.filter(m => 
      (m.teamA === team1.name && m.teamB === team2.name) ||
      (m.teamA === team2.name && m.teamB === team1.name)
    );
    
    if (headToHead && headToHead.length > 0) {
      rivalryData += '\nPREVIOUS MATCHUPS THIS SEASON:\n';
      headToHead.forEach(game => {
        rivalryData += `Week ${game.week}: ${game.teamA} ${game.scoreA} - ${game.scoreB} ${game.teamB}`;
        if (game.memorableMoment) {
          rivalryData += ` (${game.memorableMoment})`;
        }
        rivalryData += '\n';
      });
    }

    rivalryData += `\nNOTE: this league has no imported rivalry record, so there is no rivalry history to draw on. These are simply the two teams with the best records. Say that plainly rather than inventing a backstory.`;
    
    return rivalryData;
  }

  private buildWaiverWireData(data: LeagueDataContext): string {
    // A waiver report without the free-agent pool has nothing to recommend; measured 2026-09-02,
    // the writer produced an honest "the list didn't come through" piece, which is not a report.
    if (!data.availablePlayers || data.availablePlayers.length === 0) {
      throw new InsufficientDataError('waiver_wire_report', ['available_players (ESPN free-agent pool)']);
    }
    const formatLines = this.formatLines(['waivers', 'roster', 'scoring']);
    let waiverData = `LEAGUE CONTEXT:
- Current week: ${data.currentWeek}
- Total teams: ${data.teams.length}
${!this.facts.format.rosterShape ? `- Roster size: ${data.rosterSize || 16}\n` : ''}
${formatLines}`;

    waiverData += this.buildWaiverLedgerData();

    // Find available players (low ownership percentage)
    const availablePlayers: Array<{ playerId: string; playerName: string; position: string; team: string; ownership?: { percentOwned?: number; percentChange?: number; }; }> = [];
    const ownedPlayers = new Set<string>();
    
    // Collect all rostered players
    data.teams.forEach(team => {
      if (team.roster) {
        team.roster.forEach(player => {
          ownedPlayers.add(player.playerId);
          
          // Check for low ownership that might be available
          if (player.ownership && player.ownership.percentOwned && player.ownership.percentOwned < 50) {
            availablePlayers.push({
              playerId: player.playerId,
              playerName: player.fullName || player.playerName,
              position: player.position,
              team: player.team,
              ownership: {
                percentOwned: player.ownership.percentOwned,
                percentChange: player.ownership.percentChange,
              },
            });
          }
        });
      }
    });

    if (availablePlayers.length > 0) {
      waiverData += 'TRENDING AVAILABLE PLAYERS:\n';
      availablePlayers
        .sort((a, b) => (b.ownership?.percentChange || 0) - (a.ownership?.percentChange || 0))
        .slice(0, 10)
        .forEach(player => {
          waiverData += `- ${player.playerName} (${player.position}, NFL: ${player.team}) - ${player.ownership?.percentOwned}% owned`;
          if (player.ownership?.percentChange && player.ownership.percentChange > 0) {
            waiverData += ` (+${player.ownership.percentChange}% this week)`;
          }
          waiverData += '\n';
        });
    }

    // Add team needs analysis
    waiverData += '\nTEAM NEEDS ANALYSIS:\n';
    data.teams.slice(0, 5).forEach(team => {
      const positionCounts: Record<string, number> = {};
      if (team.roster) {
        team.roster.forEach(player => {
          const mainPos = player.position.replace(/[0-9]/g, ''); // Remove numbers from positions
          positionCounts[mainPos] = (positionCounts[mainPos] || 0) + 1;
        });
      }
      
      const needs: string[] = [];
      if ((positionCounts['RB'] || 0) < 4) needs.push('RB');
      if ((positionCounts['WR'] || 0) < 4) needs.push('WR');
      if ((positionCounts['TE'] || 0) < 2) needs.push('TE');
      
      if (needs.length > 0) {
        waiverData += `- ${team.name}: Needs ${needs.join(', ')}\n`;
      }
    });

    waiverData += '\nCreate waiver wire recommendations with statistical backing based on the available players and team needs.';

    return waiverData;
  }

  /**
   * Renders `facts.waivers` as readable prose (owner goal, 2026-09-02: the waiver wire report must
   * take FAAB spend into account) — the latest processed run, every team's budget, and season
   * highlights, each line already computed and citable by id in the FACTS block above. For a
   * non-FAAB league this describes waiver priority instead and never mentions a dollar figure.
   */
  private buildWaiverLedgerData(): string {
    const waivers = this.facts.waivers;

    if (!waivers.isFaab) {
      return `\nWAIVER TYPE: this league does not use FAAB. Describe waiver-priority or first-come,
first-served activity in plain English. Never print a dollar figure or invent a bid amount.\n`;
    }

    const lines: string[] = [
      '\nFAAB WAIVER LEDGER:',
      'Every dollar figure and every claim below must come from one of these lines; never estimate a bid or a remaining budget.',
    ];

    if (waivers.latestRun && waivers.latestRun.claims.length > 0) {
      lines.push(`\nMost recent processed run — Week ${waivers.latestRun.week}:`);
      waivers.latestRun.claims.forEach(claim => lines.push(`- ${claim.line}`));
    } else {
      lines.push('\nNo waiver claims have been processed yet this season.');
    }

    if (waivers.budgets.length > 0) {
      lines.push('\nBUDGETS:');
      waivers.budgets.forEach(budget => lines.push(`- ${budget.line}`));
    }

    const season = waivers.season;
    if (season.biggestBid || season.mostActive || season.lowestRemaining.length > 0) {
      lines.push('\nSEASON HIGHLIGHTS:');
      if (season.biggestBid) {
        lines.push(
          `- Biggest bid of the season: ${season.biggestBid.teamName} spent $${season.biggestBid.bid} on ${season.biggestBid.player} in Week ${season.biggestBid.week}.`
        );
      }
      if (season.mostActive) {
        lines.push(`- Most active team: ${season.mostActive.teamName}, ${season.mostActive.acquisitions} pickups.`);
      }
      if (season.lowestRemaining.length > 0) {
        lines.push(
          `- Least FAAB remaining: ${season.lowestRemaining.map(entry => `${entry.teamName} ($${entry.remaining})`).join(', ')}.`
        );
      }
      if (season.totalSpent !== undefined) {
        lines.push(`- League-wide FAAB spent so far: $${season.totalSpent}.`);
      }
      if (season.averageWinningBid !== undefined) {
        lines.push(`- Average winning bid: $${season.averageWinningBid}.`);
      }
    }

    return lines.join('\n') + '\n';
  }

  private buildGenericData(data: LeagueDataContext): string {
    if (!data.teams || data.teams.length === 0) {
      throw new InsufficientDataError(this.options.contentType, ['team_rosters (teams)']);
    }
    const leader = [...data.teams].sort((a, b) => b.record.wins - a.record.wins)[0];
    let genericData = `LEAGUE OVERVIEW:
- ${data.teams.length} teams
- Current leader: ${leader.name} (${leader.record.wins}-${leader.record.losses})
- Week ${data.currentWeek} of the season
${this.formatLines(['scoring', 'playoffs', 'divisions'])}`;

    // Add league history if available
    if (data.leagueHistory) {
      genericData += `- League founded: ${data.leagueHistory.foundedYear}\n`;
      genericData += `- Total seasons: ${data.leagueHistory.totalSeasons}\n`;
    }

    // Find league-wide top performers
    const allPlayers: Array<{ playerId: string; playerName: string; position: string; team: string; avgPoints: number; totalPoints: number; }> = [];
    data.teams.forEach(team => {
      if (team.roster) {
        team.roster.forEach(player => {
          if (player.stats?.seasonStats?.averagePoints) {
            allPlayers.push({
              playerId: player.playerId,
              playerName: player.fullName || player.playerName,
              position: player.position,
              team: team.name,
              avgPoints: player.stats.seasonStats.averagePoints,
              totalPoints: player.stats.seasonStats.appliedTotal || 0,
            });
          }
        });
      }
    });

    if (allPlayers.length > 0) {
      genericData += '\nTOP PERFORMERS THIS SEASON:\n';
      allPlayers
        .sort((a, b) => b.avgPoints - a.avgPoints)
        .slice(0, 5)
        .forEach((player, idx) => {
          genericData += `${idx + 1}. ${player.playerName} (${player.position}) - ${player.avgPoints.toFixed(1)} ppg - fantasy team: ${player.team}
`;
        });
    }

    return genericData;
  }

  /** Pre-draft planning material: settings, order, and the pool with ADP where it exists. */
  private buildDraftStrategyData(data: LeagueDataContext): string {
    if (!data.teams || data.teams.length === 0) {
      throw new InsufficientDataError('draft_strategy_guide', ['team_rosters (teams)']);
    }

    const order = data.draftOrder ?? data.draftSettings?.pickOrder ?? [];

    let guide = `DRAFT STRATEGY CONTEXT:\n\nLEAGUE SETTINGS:\n`;
    guide += `- ${data.leagueType || 'Redraft'} | ${data.draftType || 'Snake'}\n`;
    guide += `- ${data.teams.length} teams | ${data.rosterSize || 16} roster spots\n\n`;
    guide += this.formatLines(['scoring', 'roster', 'playoffs']);

    if (order.length > 0) {
      guide += `DRAFT ORDER:\n${order.map(pick => `${pick.position}. ${pick.teamName}`).join(' | ')}\n\n`;
    }

    if (data.availablePlayers && data.availablePlayers.length > 0) {
      guide += `PLAYER POOL BY POSITION (ADP is average draft position; lower is earlier):\n`;
      ['QB', 'RB', 'WR', 'TE'].forEach(position => {
        const pool = data.availablePlayers!
          .filter(player => player.position === position)
          .sort(
            (a, b) =>
              (a.ownership?.averageDraftPosition ?? Number.MAX_SAFE_INTEGER) -
              (b.ownership?.averageDraftPosition ?? Number.MAX_SAFE_INTEGER)
          )
          .slice(0, position === 'QB' || position === 'TE' ? 8 : 14);
        if (pool.length === 0) return;
        guide += `\n${position}s:\n`;
        pool.forEach(player => {
          const adp = player.ownership?.averageDraftPosition;
          guide += `- ${player.playerName} (${player.proTeam || player.team || 'NFL team unknown'})`;
          guide += adp ? ` — ADP ${adp.toFixed(1)}` : ` — no ADP in the payload`;
          if (player.projectedStats) {
            guide += `, projected ${player.projectedStats.projectedTotal.toFixed(0)} pts`;
          }
          guide += '\n';
        });
      });
      guide += '\n';
    }

    guide += `STRATEGY GUIDE RULES:
- This is a plan for a draft that has not happened. Never describe a pick as made.
- Every positional claim is carried by the ADP or projection in the pool above, or it is not made.
- Slot advice is about the order above: name the slot, name what it can realistically get.
- No invented tiers, no invented ADP. If the payload has no ADP for a player, say so.`;

    return guide;
  }

  /** The names themselves are the subject matter, so they are printed verbatim and in full. */
  private buildTeamNameRankingsData(data: LeagueDataContext): string {
    if (!data.teams || data.teams.length === 0) {
      throw new InsufficientDataError('team_name_power_rankings', ['team_rosters (teams)']);
    }

    let names = `EVERY TEAM NAME IN THIS LEAGUE (copy them character for character):\n`;
    data.teams.forEach((team, index) => {
      const record = `${team.record.wins}-${team.record.losses}${team.record.ties > 0 ? `-${team.record.ties}` : ''}`;
      names += `${index + 1}. "${team.name}" — manager ${team.manager}, ${record}\n`;
    });

    names += `\nTEAM NAME RANKING RULES:
- Rank the names, not the teams. A bad team can hold the best name in the league.
- Print every name exactly as it appears above, including punctuation and capitalisation.
- Never invent a joke that requires a name the league does not have.
- The record and manager are context. They are not the criteria unless you say so out loud.`;

    return names;
  }

  /** Standings, the seed line, and the results the picture is computed from. */
  private buildPlayoffPictureData(data: LeagueDataContext): string {
    if (!data.standings || data.standings.length === 0) {
      throw new InsufficientDataError('playoff_picture', ['standings']);
    }

    const format = this.facts.format;
    let picture = `PLAYOFF PICTURE CONTEXT:\n`;
    picture += `- Week ${data.currentWeek}\n\n`;
    picture += this.formatLines(['playoffs', 'divisions']);

    picture += `\nSTANDINGS (ranked by playoff seed when known):\n`;
    data.standings.forEach(team => {
      picture += `${team.rank}. ${team.team} (${team.wins}-${team.losses}`;
      if (team.ties > 0) picture += `-${team.ties}`;
      picture += `) — ${team.pointsFor.toFixed(1)} PF, ${team.pointsAgainst.toFixed(1)} PA`;
      if (team.streakType && team.streakLength) picture += ` [${team.streakType}${team.streakLength}]`;
      if (team.playoffSeed) picture += ` [#${team.playoffSeed} seed]`;
      if (team.division) picture += ` [${team.division}]`;
      picture += '\n';
    });

    if (data.divisionStandings && data.divisionStandings.length > 0) {
      picture += `\nSTANDINGS BY DIVISION:\n`;
      data.divisionStandings.forEach(group => {
        picture += `${group.division}:\n`;
        group.teams.forEach(team => {
          picture += `  ${team.rank}. ${team.team} (${team.record}) — ${team.pointsFor.toFixed(1)} PF\n`;
        });
      });
    }

    if (data.recentMatchups && data.recentMatchups.length > 0) {
      picture += `\nMOST RECENT RESULTS:\n`;
      data.recentMatchups.slice(0, 8).forEach(matchup => {
        picture += `- Week ${matchup.week ?? data.currentWeek}: ${matchup.teamA} ${matchup.scoreA} - ${matchup.scoreB} ${matchup.teamB}\n`;
      });
    }

    if (data.upcomingSchedule && data.upcomingSchedule.length > 0) {
      picture += `\nNEXT OPPONENTS:\n`;
      data.upcomingSchedule.forEach(entry => {
        picture += `- ${entry.teamName} vs ${entry.nextOpponent}`;
        if (entry.nextOpponentRank) picture += ` (#${entry.nextOpponentRank})`;
        picture += '\n';
      });
    }

    picture += `\nPLAYOFF PICTURE RULES:
- Seeding comes from the standings above and nowhere else.
- Every piece of elimination or clinching arithmetic shows both inputs.
- ${format.playoffTeamCount ? `The field is ${format.playoffTeamCount} teams.` : 'The payload does not say how many teams make the playoffs. Say that instead of assuming a number.'}
- ${format.seedingRule ? `Seeding rule: ${format.seedingRule}.` : 'The payload does not say how seeding is determined beyond the standings order above.'}
- No playoff odds. There is no odds model in this payload, so there is no percentage to print.`;

    return picture;
  }

  private buildMockDraftData(data: LeagueDataContext): string {
    console.log("=== buildMockDraftData START (OPTIMIZED) ===");
    console.log("Draft order available:", !!data.draftOrder);
    console.log("Available players:", data.availablePlayers?.length || 0);

    // A mock draft is a prediction over the available-player pool. Without the pool the model
    // has nothing to draft from; measured 2026-09-02, it wrote a one-section stub and stopped.
    // Refuse up front so the scheduler defers (and re-syncs) instead of publishing a stub.
    if (!data.availablePlayers || data.availablePlayers.length === 0) {
      throw new InsufficientDataError('mock_draft', ['available_players (ESPN free-agent pool)']);
    }

    let mockDraftData = `MOCK DRAFT INFORMATION:\n\n`;
    
    // Compact League Settings
    mockDraftData += `LEAGUE SETTINGS:\n`;
    mockDraftData += `- ${data.leagueType || 'Redraft'} | ${data.draftType || 'Snake'}\n`;
    mockDraftData += `- ${data.teams.length} teams | ${data.rosterSize || 16} roster spots\n`;
    mockDraftData += this.formatLines(['scoring', 'roster']);
    mockDraftData += '\n';
    
    // Draft Order (compact format)
    if (data.draftOrder && data.draftOrder.length > 0) {
      mockDraftData += `DRAFT ORDER:\n`;
      const orderList = data.draftOrder
        .slice(0, 12) // Limit to 12 teams max
        .map(pick => `${pick.position}. ${pick.teamName}`)
        .join(' | ');
      mockDraftData += `${orderList}\n\n`;
    }
    
    // Enhanced player pool presentation with outlook and projections
    if (data.availablePlayers && data.availablePlayers.length > 0) {
      mockDraftData += `TOP 50 DRAFT-ELIGIBLE PLAYERS:\n\n`;
      
      // Group players by position
      const playersByPosition = data.availablePlayers.reduce((acc: Record<string, typeof data.availablePlayers>, player: typeof data.availablePlayers[0]) => {
        const pos = player.position || 'UNKNOWN';
        if (!acc[pos]) acc[pos] = [];
        acc[pos].push(player);
        return acc;
      }, {} as Record<string, typeof data.availablePlayers>);
      
      // Show top players by position with enhanced data
      const positions = ['QB', 'RB', 'WR', 'TE'];
      positions.forEach(pos => {
        if (playersByPosition[pos] && playersByPosition[pos].length > 0) {
          mockDraftData += `\n${pos}s:\n`;
          const topPlayers = playersByPosition[pos]
            .slice(0, pos === 'QB' || pos === 'TE' ? 8 : 15); // More players shown
          
          topPlayers.forEach((p, idx) => {
            mockDraftData += `${idx + 1}. ${p.playerName} (${p.proTeam})`;
            
            // Add projected stats if available
            if (p.projectedStats) {
              mockDraftData += ` - Proj: ${p.projectedStats.projectedTotal.toFixed(0)} pts (${p.projectedStats.projectedAverage.toFixed(1)} ppg)`;
            }
            
            // Add outlook if available (truncate if too long)
            if (p.seasonOutlook && p.seasonOutlook.length > 0) {
              const outlook = p.seasonOutlook.length > 250 
                ? p.seasonOutlook.substring(0, 250) + '...' 
                : p.seasonOutlook;
              mockDraftData += `\n   Outlook: ${outlook}`;
            }
            
            mockDraftData += '\n';
          });
        }
      });
      mockDraftData += '\n';
    }
    
    // OPTIMIZED: Simplified team list
    if (data.teams && data.teams.length > 0) {
      mockDraftData += `DRAFT POSITIONS:\n`;
      const teamList = data.teams
        .filter(team => team.draftPosition && team.draftPosition > 0)
        .sort((a, b) => (a.draftPosition || 0) - (b.draftPosition || 0))
        .slice(0, 12)
        .map(team => {
          const pos = team.draftPosition || 0;
          if (pos > 0 && pos <= 3) return `${pos}. ${team.name} (early)`;
          if (pos > 0 && pos >= data.teams.length - 2) return `${pos}. ${team.name} (turn)`;
          return `${pos}. ${team.name}`;
        });
      mockDraftData += teamList.join(', ') + '\n\n';
    }
    
    // OPTIMIZED: Condensed strategy notes
    mockDraftData += `KEY DRAFT STRATEGY:\n`;
    mockDraftData += `- Format: ${data.leagueType} ${data.draftType} (${data.scoringType})\n`;
    
    if (data.draftType === 'Auction') {
      mockDraftData += `- Budget wisely, target 2-3 studs + depth\n`;
    } else {
      mockDraftData += `- Early picks: Elite RB/WR | Mid: Best available | Late: Upside\n`;
    }
    
    if (data.leagueType === 'Dynasty') {
      mockDraftData += `- Prioritize youth and multi-year value\n`;
    } else if (data.leagueType === 'Keeper') {
      mockDraftData += `- Account for keeper values in strategy\n`;
    }
    
    mockDraftData += `\nMOCK DRAFT PREDICTION INSTRUCTIONS:
- You are PREDICTING what each team WILL draft based on their needs and the available players
- This is a pre-draft prediction exercise - no picks have been made yet
- Present your predictions for rounds 1-2 in a "by team" format
- Base predictions on: team needs, draft position, player projections, player outlook, and league scoring settings
- For each pick, explain WHY you predict that team will select that player
- For later rounds (3+), provide general strategy predictions and likely targets
- Remember: You're forecasting future decisions, not critiquing past ones
- Use player projections and outlook to justify picks, NOT just ADP rankings
- Avoid mentioning ADP unless it's crucial for explaining a reach/value pick`;
    
    const finalLength = mockDraftData.length;
    console.log("Optimized mock draft data length:", finalLength, "(was", mockDraftData.length, ")");
    console.log("=== buildMockDraftData END (OPTIMIZED) ===");
    
    return mockDraftData;
  }

  /**
   * One pick, printed the same way everywhere it appears (spec §8.6): ADP and the signed delta on
   * every pick, plus the perceivedValue score. The reader — and the model — never has to infer a
   * sign from a label.
   */
  private formatDraftPick(pick: NonNullable<LeagueDataContext['draftPicks']>[number]): string {
    const adp = pick.playerADP;
    const delta = adp === null || adp === undefined ? undefined : pick.pickNumber - adp;
    const adpLabel =
      adp === null || adp === undefined
        ? 'no ADP in the payload'
        : `ADP ${adp.toFixed(1)}, delta ${delta! >= 0 ? '+' : ''}${delta!.toFixed(1)}`;
    const projected =
      pick.playerProjectedPoints === null || pick.playerProjectedPoints === undefined
        ? ''
        : `, proj ${pick.playerProjectedPoints.toFixed(0)} pts`;
    // perceivedValue is derived from ADP; without an ADP it is noise, so it is not printed.
    const value =
      adp === null || adp === undefined
        ? ''
        : `, perceivedValue ${pick.perceivedValue >= 0 ? '+' : ''}${pick.perceivedValue.toFixed(1)}`;
    const rookie = pick.isRookie ? ' [rookie]' : '';
    return `${pick.pickNumber}. ${pick.playerName} (${pick.playerPosition}, ${pick.playerTeam}) → ${pick.teamName} — ${adpLabel}${projected}${value}${rookie}`;
  }

  private buildDraftRankingsData(data: LeagueDataContext): string {
    console.log("=== buildDraftRankingsData START ===");

    let draftData = `POST-DRAFT RANKINGS & ANALYSIS:\n\n`;

    draftData += `HOW TO READ A PICK LINE:\n`;
    draftData += `- delta = pick number minus ADP. Positive delta = drafted LATER than ADP (value). Negative delta = drafted EARLIER than ADP (reach).\n`;
    draftData += `- perceivedValue is this desk's score for the pick: positive is value, negative is a reach, and it is already scaled for round.\n\n`;

    // League Information
    draftData += `LEAGUE SETTINGS:\n`;
    draftData += `- ${data.leagueName}\n`;
    draftData += `- ${data.totalTeams} teams | ${data.scoringType || 'PPR'} scoring\n`;
    draftData += `- ${data.draftType || 'Snake'} draft format\n\n`;
    
    // Team-by-Team Draft Analysis
    if (data.teamGrades && data.teamGrades.length > 0) {
      draftData += `TEAM-BY-TEAM DRAFT ANALYSIS:\n`;
      data.teamGrades
        .sort((a, b) => b.gradeScore - a.gradeScore)
        .forEach((team, index) => {
          draftData += `${index + 1}. ${team.teamName} (${team.teamOwner}) - GRADE: ${team.grade}\n`;
          draftData += `   Score: ${team.gradeScore.toFixed(1)}/100\n`;
          // Only mention strategy if confidence is very high (>80%)
          if (team.strategy.confidence > 0.8) {
            draftData += `   Strategy: ${team.strategy.strategy}\n`;
          }
          draftData += `   Projected Starter Points: ${team.projectedStarterPoints.toFixed(0)}\n`;
          const bestPick = team.bestPicks[0];
          if (bestPick) {
            draftData += `   Best Pick: ${this.formatDraftPick(bestPick)}\n`;
          }
          // Same dedupe rule as the league-wide lists: a pick is best or worst, never both.
          const worstPick = team.worstPicks.find(pick => pick.playerName !== bestPick?.playerName);
          if (worstPick && worstPick.perceivedValue < -20) {
            draftData += `   Biggest Reach: ${this.formatDraftPick(worstPick)}\n`;
          }
          draftData += `   Reasoning: ${team.reasoning}\n`;
          draftData += `\n`;
        });
      draftData += `\n`;
    }
    
    // Draft Pick Details (Top 3 rounds for space efficiency)
    if (data.draftPicks && data.draftPicks.length > 0) {
      const topRoundPicks = data.draftPicks.filter(pick => pick.roundNumber <= 3);
      
      if (topRoundPicks.length > 0) {
        draftData += `TOP 3 ROUNDS BREAKDOWN:\n`;
        
        // Group by round
        const picksByRound = topRoundPicks.reduce((acc, pick) => {
          if (!acc[pick.roundNumber]) acc[pick.roundNumber] = [];
          acc[pick.roundNumber].push(pick);
          return acc;
        }, {} as Record<number, typeof topRoundPicks>);
        
        Object.entries(picksByRound)
          .sort(([a], [b]) => Number(a) - Number(b))
          .forEach(([round, picks]) => {
            draftData += `\nRound ${round}:\n`;
            picks.sort((a, b) => a.pickNumber - b.pickNumber)
              .forEach(pick => {
                draftData += `${this.formatDraftPick(pick)}\n`;
              });
          });
        draftData += `\n`;
      }
      
      // Hot Take Best Picks - Mix of high projected points and value
      const hotTakeBestPicks: Array<NonNullable<typeof data.draftPicks>[0]> = [];
      
      // Get top projected players by position who were drafted
      const positionGroups = ['QB', 'RB', 'WR', 'TE'];
      positionGroups.forEach(position => {
        if (data.draftPicks) {
          const positionPicks = data.draftPicks
            .filter(pick => pick.playerPosition === position && pick.playerProjectedPoints !== null)
            .sort((a, b) => (b.playerProjectedPoints || 0) - (a.playerProjectedPoints || 0));
          
          // Add top 2 projected players for this position
          if (positionPicks.length > 0) {
            hotTakeBestPicks.push(...positionPicks.slice(0, 2));
          }
        }
      });
      
      // Add some high-value picks (steals) - players drafted significantly later than their ADP
      if (data.draftPicks) {
        const valueSteals = data.draftPicks
          .filter(pick => 
            pick.playerADP && 
            pick.pickNumber > pick.playerADP + 10 && // Drafted at least 10 spots later than ADP (true steals)
            pick.perceivedValue > 0 // Still has positive value
          )
          .sort((a, b) => (b.pickNumber - b.playerADP!) - (a.pickNumber - a.playerADP!)) // Sort by biggest steal (pick number - ADP)
          .slice(0, 3);
        hotTakeBestPicks.push(...valueSteals);
        
        // Add rookie sleepers (players marked as rookies, or late ADP with decent projections)
        const rookieSleepers = data.draftPicks
          .filter(pick => 
            (pick.isRookie || 
             (pick.playerADP && pick.playerADP > 100 && pick.playerProjectedPoints && pick.playerProjectedPoints > 150)) &&
            pick.perceivedValue > 0
          )
          .sort((a, b) => (b.playerProjectedPoints || 0) - (a.playerProjectedPoints || 0))
          .slice(0, 2);
        hotTakeBestPicks.push(...rookieSleepers);
      }
      
      // Remove duplicates and limit
      const uniqueBestPicks = hotTakeBestPicks
        .filter((pick, index, arr) => arr.findIndex(p => p.playerName === pick.playerName) === index)
        .slice(0, 8);

      if (uniqueBestPicks.length > 0) {
        draftData += `HOT TAKE BEST PICKS:\n`;
        uniqueBestPicks.forEach(pick => {
          draftData += `${this.formatDraftPick(pick)}\n`;
        });
        draftData += `\n`;
      }
      
      // Hot Take Worst Picks - Mix of reaches and low projections
      const hotTakeWorstPicks: Array<NonNullable<typeof data.draftPicks>[0]> = [];
      
      if (data.draftPicks) {
        // Get extreme reaches (drafted much earlier than ADP)
        const extremeReaches = data.draftPicks
          .filter(pick => pick.playerADP && pick.pickNumber < pick.playerADP - 20)
          .sort((a, b) => (a.playerADP || 0) - (b.playerADP || 0) - (b.pickNumber - a.pickNumber))
          .slice(0, 4);
        hotTakeWorstPicks.push(...extremeReaches);
        
        // Get players with lowest projected points by position (drafted too early for their projection)
        positionGroups.forEach(position => {
          const positionPicks = data.draftPicks!
            .filter(pick => pick.playerPosition === position && pick.playerProjectedPoints !== null && pick.pickNumber <= 120)
            .sort((a, b) => (a.playerProjectedPoints || 0) - (b.playerProjectedPoints || 0));
          
          // Add bottom 1-2 projected players for this position (if drafted reasonably early)
          if (positionPicks.length > 2) {
            const worstProjected = positionPicks.slice(0, position === 'QB' || position === 'TE' ? 1 : 2);
            hotTakeWorstPicks.push(...worstProjected);
          }
        });
        
        // Add some terrible value picks
        const terribleValue = data.draftPicks
          .filter(pick => pick.perceivedValue < -30)
          .sort((a, b) => a.perceivedValue - b.perceivedValue)
          .slice(0, 3);
        hotTakeWorstPicks.push(...terribleValue);
      }
      
      // Unified dedupe: a player appears in exactly one of the two lists. Best wins the tie, so
      // the same name can never be sold as a steal in one paragraph and a reach in the next.
      const bestNames = new Set(uniqueBestPicks.map(pick => pick.playerName));
      const uniqueWorstPicks = hotTakeWorstPicks
        .filter((pick, index, arr) => arr.findIndex(p => p.playerName === pick.playerName) === index)
        .filter(pick => !bestNames.has(pick.playerName))
        .slice(0, 6);

      if (uniqueWorstPicks.length > 0) {
        draftData += `HOT TAKE QUESTIONABLE PICKS:\n`;
        uniqueWorstPicks.forEach(pick => {
          draftData += `${this.formatDraftPick(pick)}\n`;
        });
        draftData += `\n`;
      }
    }
    
    // Draft Strategy Analysis
    if (data.teamGrades) {
      draftData += `STRATEGY BREAKDOWN:\n`;
      const strategies = data.teamGrades.reduce((acc, team) => {
        const strategy = team.strategy.strategy;
        if (!acc[strategy]) acc[strategy] = [];
        acc[strategy].push(team);
        return acc;
      }, {} as Record<string, typeof data.teamGrades>);
      
      Object.entries(strategies).forEach(([strategy, teams]) => {
        draftData += `${strategy}: ${teams.map(t => t.teamName).join(', ')} (${teams.length} teams)\n`;
      });
      draftData += `\n`;
    }
    
    draftData += `GRADING METHODOLOGY:\n`;
    draftData += `- Grades based on: projected starter points (40%), perceived pick value vs ADP (40%), bench depth (20%)\n`;
    draftData += `- Strategy analysis considers first 5 picks and position distribution\n`;
    draftData += `- Consider league scoring system (${data.scoringType}) when evaluating positional value\n\n`;

    draftData += `DRAFT RANKINGS INSTRUCTIONS:\n`;
    draftData += `- Read the delta on the pick line: positive is value, negative is a reach. Say which one it is.\n`;
    draftData += `- Every pick you call a steal or a reach is quoted with its ADP and its delta.\n`;
    draftData += `- A player appears in the best list or the questionable list, never both.\n`;
    draftData += `- Focus on ACTUAL draft results and grades, not predictions\n`;
    draftData += `- Go through EACH TEAM INDIVIDUALLY and give them their personalized grade and analysis\n`;
    draftData += `- Don't group teams by grade (no "A+ teams", "B teams" sections) - analyze each team separately\n`;
    draftData += `- Use the provided team-by-team data with specific reasoning for each team's grade\n`;
    draftData += `- If the quote ledger has a manager's words, place them inside that team's own grade block\n`;
    draftData += `- Attribution is "{MANAGER} of {TEAM}" on first reference, and the quote is verbatim\n`;
    draftData += `- Say what the manager was asked about, using the questionTopic from the ledger\n`;
    draftData += `- Respond to the quote in your own voice in the same paragraph\n`;
    draftData += `- A team with no quote gets analysed without one, and you say nothing about why\n`;
    draftData += `- Be critical of bad picks but give credit where due\n`;
    draftData += `- Include specific analysis of each team's strategy (when provided), best picks, and biggest reaches\n`;
    draftData += `- NEVER mention confidence levels or percentages related to draft strategy analysis\n`;
    draftData += `- The "Hot Take Best Picks" list is elite projections, picks with a positive delta, and rookie sleepers\n`;
    draftData += `- Rookies are identified by the isRookie field, determined from ESPN's eligibility data\n`;
    draftData += `- The "Hot Take Questionable Picks" list is negative deltas and low-projection players drafted early\n`;
    draftData += `- Make bold, entertaining takes on these picks - don't just list them, give hot takes!\n`;
    draftData += `- Reference the grading methodology but don't be overly technical\n`;
    draftData += `- Make it entertaining while being informative with personalized takes for each team\n`;
    
    console.log("Draft rankings data length:", draftData.length);
    console.log("=== buildDraftRankingsData END ===");
    
    return draftData;
  }

  private buildTradeRumorData(data: LeagueDataContext): string {
    console.log("=== buildTradeRumorData START ===");
    
    let rumorData = `TRADE RUMOR CONTEXT:\n\n`;
    
    // League standings for context
    rumorData += `CURRENT STANDINGS:\n`;
    if (data.standings && data.standings.length > 0) {
      data.standings.slice(0, 8).forEach(team => {
        rumorData += `${team.rank}. ${team.team} (${team.wins}-${team.losses}`;
        if (team.ties > 0) rumorData += `-${team.ties}`;
        rumorData += `) - ${team.pointsFor.toFixed(1)} PF`;
        if (team.playoffSeed) {
          rumorData += ` [#${team.playoffSeed} seed]`;
        }
        rumorData += '\n';
      });
    }
    rumorData += '\n';
    
    // Recent trades in the league for context
    if (data.trades && data.trades.length > 0) {
      rumorData += `RECENT TRADE ACTIVITY:\n`;
      data.trades.slice(0, 3).forEach(trade => {
        rumorData += `- ${trade.teamA} traded ${trade.playersFromA.map(p => p.playerName).join(', ')} `;
        rumorData += `for ${trade.playersFromB.map(p => p.playerName).join(', ')} from ${trade.teamB}\n`;
      });
      rumorData += '\n';
    }
    
    // Team needs analysis
    rumorData += `TEAM NEEDS & SITUATIONS:\n`;
    data.teams.forEach(team => {
      const positionCounts: Record<string, number> = {};
      if (team.roster) {
        team.roster.forEach(player => {
          const mainPos = player.position.replace(/[0-9]/g, '');
          positionCounts[mainPos] = (positionCounts[mainPos] || 0) + 1;
        });
      }
      
      const needs: string[] = [];
      if ((positionCounts['RB'] || 0) < 4) needs.push('RB');
      if ((positionCounts['WR'] || 0) < 4) needs.push('WR');
      if ((positionCounts['TE'] || 0) < 2) needs.push('TE');
      
      if (needs.length > 0 || team.record.wins <= 3 || team.record.wins >= 7) {
        rumorData += `- ${team.name} (${team.record.wins}-${team.record.losses})`;
        if (needs.length > 0) {
          rumorData += ` needs: ${needs.join(', ')}`;
        }
        if (team.record.wins >= 7) {
          rumorData += ` [Contender - buying]`;
        } else if (team.record.wins <= 3) {
          rumorData += ` [Rebuilding - selling]`;
        }
        rumorData += '\n';
      }
    });
    rumorData += '\n';
    
    // Hot players who could be trade targets
    if (data.teams.length > 0) {
      rumorData += `HOT TRADE COMMODITIES:\n`;
      const allPlayers: Array<{
        playerName: string;
        position: string;
        teamName: string;
        avgPoints?: number;
        trend?: string;
      }> = [];
      
      data.teams.forEach(team => {
        if (team.roster) {
          team.roster.forEach(player => {
            if (player.stats?.seasonStats?.averagePoints && player.stats.seasonStats.averagePoints > 10) {
              allPlayers.push({
                playerName: player.fullName || player.playerName,
                position: player.position,
                teamName: team.name,
                avgPoints: player.stats.seasonStats.averagePoints,
                trend: player.stats.recentPerformance?.trend
              });
            }
          });
        }
      });
      
      // Show top performers who might be trade targets
      allPlayers
        .sort((a, b) => (b.avgPoints || 0) - (a.avgPoints || 0))
        .slice(0, 10)
        .forEach(player => {
          rumorData += `- ${player.playerName} (${player.position}, ${player.teamName}) - ${player.avgPoints?.toFixed(1)} ppg`;
          if (player.trend) {
            rumorData += ` [${player.trend}]`;
          }
          rumorData += '\n';
        });
    }
    
    const tradeDeadlineLine = this.formatLines(['tradeDeadline']);
    if (tradeDeadlineLine) rumorData += `\n${tradeDeadlineLine}`;

    rumorData += `\nTHE ASKING PRICE — REPORTING RULES:
- This column reports only three things: completed transactions, standing trade-block listings, and
  on-record manager statements. Nothing else is printable.
- No unnamed sources. "Word is", "hearing", "league sources" and "sources say" are not available.
- Use the names in <FACTS>. Never print a raw player id or team id.
- Timestamp what you can timestamp, using only dates present in <FACTS>.
- You get exactly one speculative paragraph. It stands alone and opens with "My read, not reporting:".
- Never characterize a manager's motive unless the manager stated it on the record.
- If there is no listing and no transaction, the market is quiet. Report that it is quiet; that is
  the story, and it is a short one.

The ADDITIONAL CONTEXT section below, if present, carries the specific listing or transaction this
column is about — the player and team names, positions, and stats. Use those names verbatim.`;
    
    console.log("Trade rumor data length:", rumorData.length);
    console.log("=== buildTradeRumorData END ===");
    
    return rumorData;
  }

  private buildSeasonWelcomeData(data: LeagueDataContext): string {
    console.log("=== buildSeasonWelcomeData START ===");
    console.log("Previous seasons available:", data.previousSeasons ? Object.keys(data.previousSeasons).length : 0);
    console.log("Previous season years:", data.previousSeasons ? Object.keys(data.previousSeasons) : []);
    
    let welcomeData = `WELCOME TO THE ${new Date().getFullYear()} SEASON!\n\n`;
    
    welcomeData += `LEAGUE OVERVIEW:\n`;
    welcomeData += `- League Name: ${data.leagueName}\n`;
    welcomeData += `- Number of Teams: ${data.teams.length}\n`;
    welcomeData += `- Scoring Type: ${data.scoringType || 'PPR'}\n`;
    welcomeData += `- Roster Size: ${data.rosterSize || 16}\n`;
    if (data.leagueType) {
      welcomeData += `- League Type: ${data.leagueType}\n`;
    }
    
    if (data.leagueHistory) {
      welcomeData += `- League Founded: ${data.leagueHistory.foundedYear}\n`;
      welcomeData += `- Total Seasons Played: ${data.leagueHistory.totalSeasons}\n\n`;
      
      // Add previous champions
      if (data.leagueHistory.seasons && data.leagueHistory.seasons.length > 0) {
        console.log("League history seasons:", data.leagueHistory.seasons.length);
        welcomeData += `RECENT CHAMPIONS:\n`;
        data.leagueHistory.seasons
          .filter(s => s.champion)
          .slice(-3)
          .forEach(season => {
            console.log("Champion data for", season.year, ":", season.champion);
            if (season.champion) {
              welcomeData += `- ${season.year}: ${season.champion.teamName} (${season.champion.owner})
`;
            }
          });
        welcomeData += '\n';
      }
    }

    // Current season teams and managers
    welcomeData += `\n${new Date().getFullYear()} SEASON TEAMS:\n`;
    data.teams.forEach((team, idx) => {
      welcomeData += `${idx + 1}. ${team.name} - Manager: ${team.manager}\n`;
    });

    // Previous season analysis if available
    if (data.previousSeasons && Object.keys(data.previousSeasons).length > 0) {
      const lastYear = Math.max(...Object.keys(data.previousSeasons).map(Number));
      const lastSeasonTeams = data.previousSeasons[lastYear];
      
      console.log("Last year:", lastYear);
      console.log("Last season teams:", lastSeasonTeams?.length || 0);
      
      if (lastSeasonTeams && lastSeasonTeams.length > 0) {
        console.log("Sample last season team:", {
          name: lastSeasonTeams[0].teamName,
          manager: lastSeasonTeams[0].manager,
          rosterSize: lastSeasonTeams[0].roster?.length,
        });
      }
      
      welcomeData += `\nRETURNING PLAYERS FROM ${lastYear} ROSTERS:\n`;
      
      // Track which players are on which teams
      const currentRosters: Record<string, Set<string>> = {};
      const previousRosters: Record<string, Set<string>> = {};
      
      // Build current roster map
      data.teams.forEach(team => {
        currentRosters[team.externalId || team.name] = new Set();
        if (team.roster) {
          team.roster.forEach(player => {
            currentRosters[team.externalId || team.name].add(player.playerId);
          });
        }
      });
      console.log("Current rosters built for", Object.keys(currentRosters).length, "teams");
      
      // Build previous roster map and find key players
      lastSeasonTeams.forEach(team => {
        previousRosters[team.teamId] = new Set();
        team.roster.forEach(player => {
          previousRosters[team.teamId].add(player.playerId);
        });
      });
      console.log("Previous rosters built for", Object.keys(previousRosters).length, "teams");
      
      // Find notable keepers and player movements
      welcomeData += '\nKEY ROSTER MOVES:\n';
      
      // Track keepers by team
      const keepersByTeam: Record<string, string[]> = {};
      let totalKeepers = 0;
      let totalNewPlayers = 0;
      
      data.teams.forEach(currentTeam => {
        const currentTeamId = currentTeam.externalId || currentTeam.name;
        const lastSeasonTeam = lastSeasonTeams.find(t => t.teamId === currentTeamId);
        
        if (lastSeasonTeam && currentTeam.roster) {
          const keepers: string[] = [];
          const additions: string[] = [];
          
          currentTeam.roster.forEach(player => {
            if (previousRosters[currentTeamId]?.has(player.playerId)) {
              // This is a keeper
              if (player.acquisitionType === 'DRAFT' && ['RB', 'WR', 'QB', 'TE'].includes(player.position)) {
                keepers.push(`${player.fullName || player.playerName} (${player.position})`);
                totalKeepers++;
              }
            } else if (player.acquisitionType === 'DRAFT') {
              // New draft pick
              additions.push(`${player.fullName || player.playerName} (${player.position})`);
              totalNewPlayers++;
            }
          });
          
          if (keepers.length > 0) {
            keepersByTeam[currentTeam.name] = keepers;
          }
          
          // Report on this team
          if (keepers.length > 0 || additions.length > 0) {
            welcomeData += `\n${currentTeam.name}:\n`;
            if (keepers.length > 0) {
              welcomeData += `  Kept from last season: ${keepers.slice(0, 3).join(', ')}\n`;
            }
            if (additions.length > 0) {
              welcomeData += `  Key additions: ${additions.slice(0, 3).join(', ')}\n`;
            }
          }
        }
      });
      
      console.log("Total keepers found:", totalKeepers);
      console.log("Total new players:", totalNewPlayers);
      
      // Show notable players from last season rosters
      welcomeData += '\nNOTABLE PLAYERS FROM LAST SEASON:\n';
      const allLastSeasonPlayers: Array<{ name: string; position: string; team: string }> = [];
      
      lastSeasonTeams.forEach(team => {
        team.roster
          .filter(p => ['QB', 'RB', 'WR', 'TE'].includes(p.position) && p.acquisitionType === 'DRAFT')
          .slice(0, 5) // Top 5 drafted players per team
          .forEach(player => {
            allLastSeasonPlayers.push({
              name: player.fullName || player.playerName,
              position: player.position,
              team: team.teamName
            });
          });
      });
      
      console.log("Notable players from last season:", allLastSeasonPlayers.length);
      
      // Group by position
      const byPosition = allLastSeasonPlayers.reduce((acc, player) => {
        if (!acc[player.position]) acc[player.position] = [];
        acc[player.position].push(player);
        return acc;
      }, {} as Record<string, typeof allLastSeasonPlayers>);
      
      ['QB', 'RB', 'WR', 'TE'].forEach(pos => {
        if (byPosition[pos] && byPosition[pos].length > 0) {
          welcomeData += `\n${pos}s from ${lastYear}:\n`;
          byPosition[pos].slice(0, 8).forEach(player => {
            welcomeData += `- ${player.name} (${player.team})\n`;
          });
        }
      });
    } else {
      console.log("No previous seasons data available!");
      welcomeData += '\n\nNOTE: No previous season data available. This appears to be the first season!\n';
    }
    
    // Memorable moments section if present
    if (data.memorableMoments && Array.isArray(data.memorableMoments) && data.memorableMoments.length > 0) {
      welcomeData += `\nMEMORABLE MOMENTS (Recent Seasons):\n`;
      const moments = data.memorableMoments;
      moments
        .slice(0, 12)
        .forEach(m => {
          welcomeData += `- ${m.seasonId}: ${m.description}\n`;
        });
    }

    welcomeData += '\n\nUse this information to create an engaging season welcome package that gets managers excited for the new season!';
    
    console.log("Season welcome data length:", welcomeData.length);
    console.log("=== buildSeasonWelcomeData END ===");
    
    return welcomeData;
  }
}

// Example usage function
export async function generatePrompt(options: PromptBuilderOptions) {
  const builder = new PromptBuilder(options);
  return builder.build();
}