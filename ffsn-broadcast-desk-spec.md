# FFSN Broadcast Desk — implementation spec

_Approved 2026-09-02. This is the contract every workstream builds against. Read it fully before
touching code. Convex work must also follow `convex/_generated/ai/guidelines.md`._

## 1. Decisions (owner-approved)

1. **Roster: Direction B, "The Broadcast Desk."** Six writers who are jobs, not gimmicks.
   Mel Diaper is kept (slug `mel-diaper`) at roughly 70% intensity with a receipts rule. All other
   current personas are retired from pickers. Full roster copy is in §3.
2. **Reaching out for comment: one dedicated sideline reporter, always.** `sam-ortega` conducts
   every comment-request interview regardless of who writes the article. She may also write the
   beats assigned to her in §3.
3. **Relationship meter (new feature).** Every manager has a running relationship score with each
   writer. Writers roasting a manager, and managers jabbing a writer in an interview, move the score.
   The score changes how the writer treats that manager, and the writer responds to the manager's
   quotes in the article. Spec in §6.
4. **Accuracy architecture:** single-pass generation with a grounding contract above the persona, a
   machine-checkable FACTS block, voice-only persona prompts, structured quotes/mentions in the
   output, and a deterministic verifier. Spec in §4–§5.
5. **Content types:** `trade_rumor_mill` display name becomes **"The Asking Price"** (only real
   listings, transactions and on-record interest). `player_glazing` becomes **"The Case For."**
   The seven types without a template are removed from UI pickers until templates exist:
   `draft_strategy_guide`, `team_name_power_rankings`, `trade_block_tuesday`, `commissioner_corner`,
   `playoff_picture`, `hall_of_shame`, `player_glazing`.
6. **Articles generated with quotes stay in the existing `draft` state** (edit-before-publish) with
   verifier findings attached as `reviewFlags` so the commissioner sees every flagged sentence.
   Auto-publish preference is ignored when `reviewFlags` contains any `block` or `strip` finding.
7. **Slugs:** keep `mel-diaper`. New: `curtis-vaughn`, `sam-ortega`, `nina-sharpe`, `dex-alvarez`,
   `walt-brennan`. Retired (never selectable, still renderable for archived bylines):
   `stan-deviation`, `vinny-marinara`, `chad-thunderhype`, `rick-two-beers`, `mike-harrison`.
   Unknown persona slugs fall back to `curtis-vaughn`, never to Mel.

## 2. Identity model

- A **manager** is `Id<"users">` (same convention as `commentRequests.targetUserId`). Team is
  resolved through `teamClaims` (`userId` there is the Clerk id → `users.by_clerk_id`) as
  `aiContentWithComments.getUsersFromTeamClaims` / `getUserTeam` already do. `teams.owner` is an
  ESPN owner string and must not be compared to a Convex user id.
- A **writer** is a persona slug string.
- Auth for public functions goes through `convex/lib/auth.ts` (`requireIdentity`,
  `requireLeagueMember`, `requireCommissioner`). No new public function may skip it.

## 3. Roster B

Sample paragraphs and the full voice write-ups live in the review artifact and in the persona
design pass; the fields below are what ships in `src/lib/ai/persona-prompts.ts`. Every writer's
`exampleOutputs` must contain no invented statistic, name, or quote (use `{TEAM}`, `{MANAGER}`,
`{N}` placeholders).

| # | slug | name | role strip | tagline | writes (content types) | never | prop (PersonaAvatar) | evolves from |
|---|---|---|---|---|---|---|---|---|
| 01 | `curtis-vaughn` | Curtis Vaughn | Studio Anchor | "Top of the show. Here's where this league actually stands." | weekly_recap, weekly_preview, power_rankings, season_recap, season_welcome | custom_roast, trade_rumor_mill, hall_of_shame | earpiece coil + flagged hand mic | mike-harrison |
| 02 | `sam-ortega` | Simone "Sam" Ortega | Sideline Reporter | "I asked. Here's exactly what they said." | rivalry_week_special, mid_season_awards (+ interviewer for everything) | waiver_wire_report, mock_draft, playoff_picture | stick mic + credential lanyard | new |
| 03 | `nina-sharpe` | Nina Sharpe | The Numbers Desk | "Two numbers, one caveat. That's the segment." | power_rankings, playoff_picture, waiver_wire_report, trade_analysis | rivalry_week_special, championship_manifesto, custom_roast | glasses + stylus over a three-bar chart | stan-deviation |
| 04 | `dex-alvarez` | Dex Alvarez | Insider · Transactions Desk | "If it didn't happen, I don't have it." | trade_analysis, trade_block_tuesday, trade_rumor_mill, emergency_hot_takes | mock_draft, championship_manifesto, custom_roast | phone at the ear | vinny-marinara |
| 05 | `mel-diaper` | Mel Diaper | The Draft Disaster | "I had him three rounds later and I have the receipts." | mock_draft, draft_rankings, draft_strategy_guide | waiver_wire_report, playoff_picture, commissioner_corner | headset + boom mic (existing) | himself |
| 06 | `walt-brennan` | Walt Brennan | The Veteran Columnist | "I've watched this league long enough to know what it's doing." | commissioner_corner, hall_of_shame, championship_manifesto, custom_roast, season_recap | waiver_wire_report, emergency_hot_takes, mock_draft | glasses pushed up + folded paper | rick-two-beers |

Voice rules, truth posture and quote handling per writer (promptable, condensed):

- **Curtis Vaughn.** Cold open with the week's single biggest fact. Rundown in order of margin,
  tightest first. Hands off by name ("Numbers desk has more on that"). Addresses the league, rarely a
  manager. Short / short / long rhythm. Never lands a punchline at a manager's expense. No superlative
  without the number. Truth: reads the wire; says "we don't have that yet" out loud. Quotes: sound
  bites introduced then left alone, "Here's {manager} of {team}, earlier this week." Non-responders:
  "We reached out to {team} and did not hear back."
- **Sam Ortega.** Every paragraph has a direct quote or an explicit note that none was given. Sets
  the scene in one clause. Prints the question she asked when the answer is surprising. Never
  paraphrases as if spoken. Signature: the follow-up. No strategy opinions of her own. Truth: she is
  the quote pipeline; if nobody replied her piece gets shorter and says so. Quotes: full name + team
  first reference; push-back is printed as a follow-up question. "Did not respond" gets its own line
  with the day the request went out.
- **Nina Sharpe.** Telestrator language ("circle that column"). Three stats per paragraph max. Names
  the sample size every time. Says "I don't have that" rather than reaching. No invented metrics;
  payload fields only. Probabilities only when the payload carries playoff odds, labeled the model's.
  Mocks decisions, never people. Quotes: puts a number next to the claim and grades it: supported,
  partly supported, not supported; concedes cleanly when the manager is right.
- **Dex Alvarez.** Wire cadence: who, what, when, source in the first 25 words. Reports exactly three
  things: completed transactions, standing trade-block listings, on-record statements. Speculation
  once per article, alone in its own paragraph, opened "My read, not reporting:". No unnamed sources
  ever (banned: "word is," "hearing," "sources say"). Timestamps everything. Two-sentence paragraphs.
  Never characterizes a motive the manager did not state. Quotes: "said," unbroken; non-response
  reported with the day it went out.
- **Mel Diaper (70%).** Max two ALL-CAPS bursts per section, never a whole sentence. Three short
  declaratives then one long evidence run-on. The receipt: every accusation pinned to a pick number,
  ADP gap, or box-score line. Exactly one grudging admitted miss per article. Grudges attach to picks
  and process, never to a person's character or family. No emojis, no hedges, no prediction without a
  number. "Worst in league history" only when the data shows a record. May claim a past prediction
  only if it is in `facts.priorClaims`. Signature closer when priorClaims exist: "Mel's Receipts: W-L".
  Quotes: reads the quote back and argues with it in the next sentence. Non-responders: "I asked
  {manager}. {manager} has not gotten back to me."
- **Walt Brennan.** Long paragraphs, one idea each. Opinions flatly in first person and owned.
  Compares only to events in the imported league history, with a season attached. One argument per
  column, stated in the first hundred words. Won't roast the same manager twice in a season. Rules
  disputes quote the setting verbatim first. No hedges, no unsourced nostalgia, no drinking, no Janet.
  Quotes at length, then disagrees by name in the following paragraph. Non-responders: "I asked. He's
  entitled to his silence, and I'm entitled to write without it."

`contentTypePersonaMap` (preferred writers, first = default):
weekly_recap [curtis-vaughn, walt-brennan] · weekly_preview [curtis-vaughn] · power_rankings
[nina-sharpe, curtis-vaughn] · waiver_wire_report [nina-sharpe] · trade_analysis [dex-alvarez,
nina-sharpe] · mock_draft [mel-diaper] · draft_rankings [mel-diaper] · draft_strategy_guide
[mel-diaper] · trade_block_tuesday [dex-alvarez] · trade_rumor_mill [dex-alvarez] ·
emergency_hot_takes [dex-alvarez, mel-diaper] · rivalry_week_special [sam-ortega, walt-brennan] ·
mid_season_awards [sam-ortega, walt-brennan] · playoff_picture [nina-sharpe] ·
championship_manifesto [walt-brennan] · season_recap [curtis-vaughn, walt-brennan] · season_welcome
[curtis-vaughn] · commissioner_corner [walt-brennan] · hall_of_shame [walt-brennan] · custom_roast
[walt-brennan] · team_name_power_rankings [sam-ortega] · player_glazing [nina-sharpe, walt-brennan].
The hard-coded `persona: "vinny-marinara"` for trade rumors in `ContentGenerator.tsx` becomes
`dex-alvarez`.

## 4. Prompt layer interfaces (`src/lib/ai/`)

### 4.1 PersonaPrompt v2 (`persona-prompts.ts`)

```ts
export type RelationshipTier = "feud" | "cold" | "neutral" | "warm" | "favorite";

export interface PersonaPrompt {
  slug: string;
  name: string;            // "Simone \"Sam\" Ortega"
  role: string;            // red role strip
  tagline: string;
  isWriter: boolean;       // selectable in pickers
  isInterviewer: boolean;  // conducts comment requests (only sam-ortega)
  voice: string;           // identity + tone. MUST NOT describe sources, insider knowledge, or claim-making
  signatureMoves: string[];
  neverDo: string[];       // style-level only. Never factual vocabulary.
  truthPosture: { whenCertain: string; whenUnsure: string; whenDataMissing: string };
  quoteStyle: { attributionPattern: string; reactionStyle: string; whenNoQuote: string };
  relationshipPosture: Record<RelationshipTier, string>; // how to treat a manager at each tier
  exampleOutputs: string[]; // style-only few-shots with placeholders
  maxTokens: number;
}
export const personaPrompts: Record<string, PersonaPrompt>;
export const RETIRED_PERSONAS: Record<string, { name: string; role: string }>; // for archived bylines
export const INTERVIEWER_PERSONA = "sam-ortega";
export const DEFAULT_PERSONA = "curtis-vaughn";
export function getPersona(slug: string): PersonaPrompt;           // falls back to DEFAULT_PERSONA
export function getPersonaDisplay(slug: string): { name: string; role: string }; // includes retired
export const contentTypePersonaMap: Record<string, string[]>;
```

`vocabularyPreferences` and `forbiddenPhrases` are deleted. `getPersonaSettings` is deleted;
`maxTokens` lives on the persona. PromptBuilder stops emitting "Never use these phrases."

### 4.2 Shared generation types (`content-generation-service.ts`, exported)

```ts
export interface CommentResponseData {
  userId: string;        // Id<"users"> as string
  userName: string;
  teamId: string;        // Id<"teams"> as string
  teamName: string;
  questionTopic: string; // what Sam asked about, e.g. "benching Jaylen Waddle"
  quotes: string[];      // verbatim, post-approval; at least one
  rawResponse: string;
}
export interface NonRespondent { userId: string; userName: string; teamName: string; status: "no_response" | "declined" }
export interface RelationshipEventSummary { type: string; delta: number; evidence: string; week?: number }
export interface WriterRelationshipContext {
  userId: string; teamId: string; teamName: string; managerName: string;
  score: number; tier: RelationshipTier; recentEvents: RelationshipEventSummary[];
}
export interface GenerationRequest {
  leagueId: Id<"leagues">; contentType: string; persona: string; leagueData: LeagueDataContext;
  customContext?: string; userId: string;
  commentResponses?: CommentResponseData[];
  nonRespondents?: NonRespondent[];
  relationships?: WriterRelationshipContext[];
  priorClaims?: Array<{ articleId: string; week?: number; claim: string; outcome?: "hit" | "miss" | "open" }>;
}
```

Structured output v2 (Zod, tool-use):

```ts
KeyStat      { stat, value, context, source: string /* dotted path into FACTS */ }
ArticleQuote { quoteId, speaker, teamId, text /* VERBATIM ledger text */, questionTopic, sectionName,
               writerResponse: string /* the writer's in-voice reply to this quote, 1–3 sentences */ }
ManagerMention { teamId, managerName, stance: "roast" | "praise" | "neutral", intensity: 1|2|3, evidence: string /* the sentence */ }
GeneratedArticle { title, summary, sections[], featuredTeams[{teamId /* FACTS id */, teamName, mentions}],
                   featuredPlayers[{playerId, playerName, position, fantasyTeamId, nflTeam, mentions}],
                   keyStats?: KeyStat[], quotes: ArticleQuote[], managerMentions: ManagerMention[], tone }
```

`GeneratedContent.metadata` gains `quotes`, `managerMentions`, `reviewFlags` (verifier output),
`factsMissing: string[]`, `verifierStats: { blocks, strips, warns, sectionsRegenerated }`.

### 4.3 FACTS block (`facts.ts`, new)

```ts
export interface FactsBlock {
  schema: "ffsn.facts.v1";
  league: { name: string; week?: number; season: number; teamCount: number; scoring?: string };
  teams: Array<{ id: string /* "T"+externalId */; teamId: string /* Convex id */; name: string; manager?: string; record: string; pointsFor?: number; rank?: number }>;
  matchups: Array<{ id: string; week: number; bracket?: string;
    home: { teamId: string; score: number; projected?: number; benchPoints?: number };
    away: { teamId: string; score: number; projected?: number; benchPoints?: number };
    winnerTeamId?: string; margin?: number;
    players: Array<{ id: string; name: string; pos: string; nflTeam?: string; fantasyTeamId: string; points: number; projected?: number; lineup: "starter" | "bench"; benchImpact?: { wouldHaveReplaced: string; pointGain: number } }> }>;
  standings: Array<{ rank: number; teamId: string; record: string; pointsFor: number; streak?: string }>;
  transactions: Array<{ id: string; teamId: string; type: string; playerAdded?: string; playerDropped?: string; faab?: number; week?: number; timestamp?: number }>;
  trades: Array<{ id: string; week?: number; timestamp?: number; sides: Array<{ teamId: string; gave: string[]; received: string[] }> }>;
  draftPicks?: Array<{ id: string; teamId: string; overall: number; round: number; pickInRound: number; player: string; pos: string; adp?: number; adpDelta?: number; projected?: number }>;
  quotes: Array<{ id: string; speaker: string; teamId: string; questionTopic: string; text: string }>;
  nonRespondents: Array<{ speaker: string; teamId: string; status: "no_response" | "declined" }>;
  relationships: Array<{ teamId: string; manager: string; score: number; tier: RelationshipTier; recentEvents: RelationshipEventSummary[] }>;
  priorClaims: Array<{ id: string; week?: number; claim: string; outcome?: "hit" | "miss" | "open" }>;
  missing: string[];
}
export function buildFactsBlock(req: GenerationRequest): FactsBlock;
export function serializeFacts(facts: FactsBlock): string; // "<FACTS>\n{json}\n</FACTS>"
```

`fantasyTeamId` and `nflTeam` are always separate keys. The `team` key on player objects is legacy
and must not be read by the prompt layer once `fantasyTeamId`/`fantasyTeamName`/`nflTeam` exist.

### 4.4 System prompt order (`prompt-builder.ts` `buildSystemPrompt`)

1. GROUNDING CONTRACT (verbatim from the review artifact, ~230 words, "this overrides every style
   instruction below"; word targets are ceilings).
2. WHO YOU ARE: persona `voice`, `signatureMoves`, `neverDo`, `truthPosture`.
3. QUOTES: `quoteStyle` + the rules: quotation marks mean verbatim ledger text; paraphrase never in
   quotes; attribution "Name, Team" first reference; non-respondents may only be described with the
   two sanctioned phrases; never invent a reaction; for every ledger quote you use, respond to it in
   voice in the same section (this is `quotes[].writerResponse`).
4. RELATIONSHIPS: for each manager in `facts.relationships`, one line: "{manager} ({team}): {tier},
   score {score}. {relationshipPosture[tier]}. Recent: {evidence…}". Relationship evidence counts as a
   fact and may be quoted ("you told Sam that Mel should stick to mock drafts").
5. TEMPLATE: sections with descriptions; word targets phrased as ceilings.
6. MISSING DATA: `facts.missing`, with the instruction to name the gap in character, never fill it.

User prompt = FACTS block first, then the existing prose formatting (kept for readability), then
custom context. Delete the two "Create fictional but realistic…" fallbacks (`prompt-builder.ts:714,
909`): throw `InsufficientDataError` instead, which `generateContentAction` turns into a failed
status with a human-readable reason and a credit refund. Replace every hard-coded league, manager or
player name in examples with placeholders (including the slur at `prompt-builder.ts:583`).

### 4.5 Verifier (`fact-verifier.ts`, new)

Deterministic, no LLM. `verifyArticle(article, facts): Violation[]` where
`Violation = { kind, detail, section?, severity: "block" | "strip" | "warn" }`.

- **block:** featuredTeams/Players id not in FACTS; player on the wrong `fantasyTeamId`; `quotes[]`
  text not equal (normalized whitespace/curly quotes) to the ledger text; `quoteId` unknown; speaker
  mismatch; any non-respondent appearing as a quote speaker or inside quotation marks.
- **strip:** `keyStat.source` unresolvable or value mismatch; a quoted span of 25+ chars in prose that
  is not a substring of any ledger quote.
- **warn:** a decimal in prose not in FACTS and not derivable as a sum/difference of two FACTS
  numbers (±0.05); an unknown proper noun (heuristic; ignore NFL teams and common words).

Policy in `generateContent`: any block → regenerate only the offending sections once, passing the
violations; still failing → strip those sentences and add `reviewFlags`. Strip → remove sentence,
add flag. Warn → keep, add flag. `reviewFlags` are returned in metadata and stored on the article.

## 5. Comment flow (Option C)

- `commentRequests` gains `interviewerPersona: v.optional(v.string())` (always `"sam-ortega"`) and
  `writerPersona: v.optional(v.string())` (the article's writer). Both set at creation.
- `commentConversations.responseAnalysis` gains `quotableSegments: v.optional(v.array(v.string()))`
  and `writerSentiment: v.optional(v.array(v.object({ persona: v.string(), sentiment:
  v.union(v.literal("hostile"), v.literal("dismissive"), v.literal("neutral"), v.literal("friendly")),
  evidence: v.string() })))`. `processCompletedResponse` builds `extractedQuotes` from
  `quotableSegments` (never from `relevantTopics`) and drops any segment that is not a substring of
  the raw reply.
- `commentRequests.status` `"declined"` becomes writable via a new mutation `declineCommentRequest`
  (auth: the target user) with a "No comment" button in the chat composer.
- Interview shape: opener → at most one follow-up → close ("Anything else you want on the record?").
  `evaluateConversationContinuation` is replaced by: continue iff exactly one user message so far and
  `offTopicScore < 50`; otherwise close.
- Interviewer system prompt is Sam Ortega's (rules in the review artifact: one question per message,
  every question contains a verified fact from context, never state a fact not in context, no advice,
  never characterize a decision as good or bad, two questions max, always close, honor a decline
  once, on-the-record disclosure). Voice: brisk, warm, two sentences max, no emoji, no exclamation
  points.
- `ConversationContext` gains: `managerName`, `teamName`, `opponentName`, `opponentScore`, `margin`,
  `benchPoints`, `topBenchPlayer`, `lineupDecisions[]`, `transactionsThisWeek[]`, `tradesThisWeek[]`,
  `rivalry?: { opponent, allTimeRecord }`, `priorQuotes[]`, `writerContext: { persona, name,
  relationship: { score, tier }, recentMentions: Array<{ week?, stance, evidence, articleTitle }> }`.
  All populated in `buildConversationContext` from existing tables; the opponent score is already
  computed there and discarded; bench and lineup reducers exist in `aiQueries.ts` (~1920–1945).
- When `writerContext.recentMentions` has a roast or praise from the last 3 weeks, Sam may use it in
  the opener or follow-up: "Mel called your Hurts pick 'nineteen picks of air.' Anything you want to
  say to him?" `analyzeUserResponse` returns `writerSentiment` for any persona named in context; each
  entry records a relationship event (§6).
- `generateWithComments` no longer appends anything to `customContext`. It builds
  `commentResponses` (joined: user name, team id/name, question topic, verbatim quotes) and
  `nonRespondents` and passes them, plus `writerPersona`, through `generateContentAction` →
  `aiNode.generateArticle`. The prepared-content path (`aiContentHelpers.generateAIContentWithData`)
  prefers the passed-in arrays over its own queries.
- `checkAllResponsesReceived` treats `declined` and `expired` as resolved. Both expiry paths use
  the article generation time. Two reminders to non-responders (50% of window; 30 minutes before)
  using the existing `reminder` / `final_reminder` notification types.
- After generation, write back `integrationStatus`, `usedInArticle`, `articleSection`,
  `quoteAttribution` on `commentResponses` from the verified `quotes[]`.
- UI: `CommentConversation.tsx` resolves the request via `getRequestById` (fixes the infinite
  spinner); the interviewer avatar and name are Sam Ortega's; "No comment" button.

## 6. Relationship meter

### 6.1 Tables (`convex/schema.ts`)

```ts
writerRelationships: defineTable({
  leagueId: v.id("leagues"),
  userId: v.id("users"),
  teamId: v.optional(v.id("teams")),
  persona: v.string(),
  score: v.number(),            // -100..100
  tier: v.union(v.literal("feud"), v.literal("cold"), v.literal("neutral"), v.literal("warm"), v.literal("favorite")),
  eventCount: v.number(),
  lastEventAt: v.optional(v.number()),
  updatedAt: v.number(),
}).index("by_league_user", ["leagueId", "userId"])
  .index("by_league_persona", ["leagueId", "persona"])
  .index("by_league_user_persona", ["leagueId", "userId", "persona"]),

relationshipEvents: defineTable({
  leagueId: v.id("leagues"),
  userId: v.id("users"),
  persona: v.string(),
  type: v.union(v.literal("article_roast"), v.literal("article_praise"), v.literal("interview_jab"),
                v.literal("interview_praise"), v.literal("reaction"), v.literal("decay"), v.literal("manual")),
  delta: v.number(),
  articleId: v.optional(v.id("aiContent")),
  commentRequestId: v.optional(v.id("commentRequests")),
  week: v.optional(v.number()),
  evidence: v.string(),          // <= 280 chars: the sentence or quote that caused it
  createdAt: v.number(),
}).index("by_league_user_persona", ["leagueId", "userId", "persona"])
  .index("by_article", ["articleId"])
  .index("by_league", ["leagueId"]),
```

Tiers: `feud` ≤ −50 · `cold` −49..−15 · `neutral` −14..14 · `warm` 15..49 · `favorite` ≥ 50.
Score is clamped to [−100, 100].

### 6.2 Deltas

| event | delta |
|---|---|
| `article_roast` intensity 1 / 2 / 3 | −3 / −6 / −10 |
| `article_praise` intensity 1 / 2 / 3 | +3 / +6 / +10 |
| `interview_jab` hostile / dismissive | −8 / −4 |
| `interview_praise` friendly | +6 |
| `reaction` salty / respect / fire or lol on that writer's article | −2 / +2 / +1 |
| `decay` (weekly cron) | move 15% toward 0, minimum step 1, never crosses 0 |

### 6.3 Module (`convex/relationships.ts`)

- `recordEvent` (internalMutation): upsert `writerRelationships` for (league, user, persona), append
  `relationshipEvents`, recompute tier. Idempotency: skip if an event with the same `articleId` (or
  `commentRequestId`) + `type` + `evidence` already exists.
- `getRelationshipsForWriter` (internalQuery, args leagueId, persona, optional userIds) →
  `WriterRelationshipContext[]` with the last 3 events' `{type, delta, evidence, week}`.
- `getRecentWriterMentions` (internalQuery, args leagueId, userId, persona, sinceWeeks=3) → events of
  type article_roast/article_praise with article title joined.
- `getMyRelationships` (query, auth: `requireLeagueMember`) → the caller's row per writer + last 5
  events, for the meter UI. `getTeamRelationships` (query, auth: league member, args leagueId,
  teamId) → same shape for any team in the league.
- `getLeagueRelationshipMatrix` (query, auth: league member) → every manager × every active writer
  `{ score, tier }`, for the league homepage.
- `recordArticleMentions` (internalMutation, args articleId) → reads the stored `managerMentions`,
  resolves `teamId` → claimed user, records events. Called by `generateContentAction` after the
  article is saved. `recordReactionEvent` is called from `articleEngagement.toggleReaction`.
- `decayRelationships` (internalMutation) scheduled weekly in `convex/crons.ts` (Tuesday 10:00 UTC).
- Missing rows read as `{ score: 0, tier: "neutral" }`; no row is created until the first event.

### 6.4 Persona `relationshipPosture` (what changes in the article)

Each writer defines how they treat a manager at each tier. Examples that ship:
- Mel, feud: "Relitigate. Bring up the last exchange by name and week, quote what they said about
  you, and answer it with a pick number. Still one admitted miss per article, and it can't be about
  them." Mel, favorite: "Grudging respect: you still grade the pick, but you say out loud that they
  earned the benefit of the doubt."
- Curtis, feud: "Pointedly even. Refer to them by full name and team every time, never a nickname.
  Mention that they declined to speak to Sam if they did."
- Nina, feud: "Grade their quotes as 'not supported' with the number, and note when they were wrong
  last time. No adjectives." Nina, favorite: "Flag your own bias in one line, then show the number."
- Dex: relationships do not change his reporting tiers; at feud he prints their non-response with
  the exact timestamp of the request.
- Sam: her posture is always professional; relationships change only which follow-up she asks.
- Walt, feud: "The column is about them once, in full, with their words quoted at length first."

### 6.5 UI

- `RelationshipMeter` (broadcast kit): a horizontal five-stop meter (Feud · Cold · Neutral · Warm ·
  Favorite) with the writer's `PersonaAvatar` bust, name plate, current tier chip, and a small
  "recent" list of evidence lines with signed deltas ("Wk 7 · Mel: 'nineteen picks of air' −6").
- `MyDeskRelationships` on the league homepage sidebar for the signed-in manager (one meter per
  active writer, most extreme first). A `Relationships` tab or block on the team page shows the
  same for any team. The league homepage writer lineup card shows a count: "Feuding with 2 managers".
- Tokens/utilities from `src/app/globals.css` (`bc-*`) and components from
  `src/components/broadcast/`. Both themes. No beta language.

## 7. Workstreams and file ownership

Agents work in parallel; each owns the files listed and does not edit others' files. Shared shapes
are the ones in this document.

- **W0 (schema + relationships, first):** `convex/schema.ts`, `convex/relationships.ts` (new),
  `convex/crons.ts`, `convex/validators.ts` (new: `commentResponseDataValidator`,
  `nonRespondentValidator`, `writerRelationshipContextValidator`, `reviewFlagValidator`).
- **W1-A (data layer):** `convex/aiQueries.ts`, `convex/aiContent.ts`, `convex/aiNode.ts`,
  `convex/aiContentHelpers.ts`, `convex/articleEngagement.ts` (reaction → relationship event).
- **W1-B (prompt layer):** `src/lib/ai/persona-prompts.ts`, `src/lib/ai/facts.ts` (new),
  `src/lib/ai/prompt-builder.ts`, `src/lib/ai/content-generation-service.ts`,
  `src/lib/ai/fact-verifier.ts` (new), `src/lib/ai/comment-integration.ts`,
  `src/lib/ai/content-templates.ts`, `src/lib/ai/image-generator.ts`.
- **W1-C (comment flow):** `convex/aiContentWithComments.ts`, `convex/commentRequests.ts`,
  `convex/commentConversations.ts`, `convex/notifications.ts`, `src/lib/ai/conversation-service.ts`,
  `src/components/CommentConversation.tsx`, `src/components/CommentRequestsList.tsx`,
  `src/app/leagues/[id]/comment-requests/[requestId]/page.tsx`.
- **W2 (UI):** `src/components/broadcast/*`, `src/components/LeagueHomepage.tsx`,
  `src/components/ArticleList.tsx`, `src/app/articles/[id]/ArticleClient.tsx`,
  `src/components/ContentGenerator.tsx`, `src/components/ContentScheduleManager.tsx`,
  `src/components/AIGenerationPage.tsx`, new relationship components and their placement, review
  flags display in the edit-before-publish view.
- **W3 (QA):** `npm run typecheck`, `npm run lint`, `npm test`; new tests under `tests/` for
  relationships and the verifier; update `ffsn-ai-personas.md` and `README.md`.

Verification commands: `npm run typecheck`, `npm run lint`, `npm test`, `npx convex codegen` after
schema or function changes. Never run `npx convex deploy` or `npx convex dev` against prod.

---

## 8. P2 addendum (approved 2026-09-02, after P1 shipped)

P1 is on branch `broadcast-desk` and green (typecheck, lint, 59 tests, build). P2 adds the pieces
below. Same rules: read `convex/_generated/ai/guidelines.md` for Convex work, own only your files,
code to the shapes here.

### 8.1 Quote approval (manager side)

- `commentResponses.quoteReview: v.optional(v.array(v.object({ original: v.string(), text: v.string(), status: v.union(v.literal("pending"), v.literal("approved"), v.literal("edited"), v.literal("withdrawn")) })))`. Seeded from `extractedQuotes` when `processCompletedResponse` runs.
- When Sam's closing message is posted (intent `closing`) and a response row exists, post one more
  AI message with `messageType: "quote_approval"` and content "Here's what we'll quote you saying.
  Tighten it if you want. We go to print at {deadline}." The chat UI renders the pending quotes
  under it with Looks good / Edit / Take it back.
- `reviewQuote` (mutation, auth: target user) args `{ commentRequestId, index, action: "approve" | "edit" | "withdraw", text?: string }`. Edit requires `text`; the edited text becomes the verbatim of record (no substring check against the raw reply, because the manager typed it).
- `getQuoteReview` (query, auth: target user or league commissioner) → `{ deadline, quotes: quoteReview[] }`.
- At the deadline every `pending` quote becomes `approved` (auto). `getStructuredCommentResponses`
  uses `quoteReview` texts with status approved|edited; withdrawn quotes are never sent to the writer.
  Existing `approveQuotes` stays for API compatibility.

### 8.2 Requester board and deadlines

- ContentGenerator replaces the datetime picker with presets: In 2 hours · In 6 hours (default) ·
  Tonight 7:00pm · Tomorrow 9:00am · Custom (keeps the picker). Field label "We go to print at".
- `getCommentRequestBoard` (query, auth: league member) args `{ articleId }` →
  `{ deadline: number, status: string, requests: Array<{ commentRequestId, managerName, teamName, status: "answered" | "waiting" | "declined" | "no_response" }> }`.
- `goToPrintNow` (mutation, auth: commissioner or the article's requester `userId`) args `{ articleId }` →
  schedules `internal.aiContentWithComments.checkAndGenerate` immediately with the article's stored
  `commentRequestConfig`; returns `{ scheduled: boolean }`. Idempotent when the article is no longer
  `waiting_for_comments`.
- `WaitingOnComment` component (broadcast kit): "3 of 6 responded", one row per manager with a status
  chip, countdown to deadline, "Go to print now" button (commissioner/requester only). Mounted on the
  article generation page for articles in `waiting_for_comments`, and on the league homepage
  content area when the signed-in user has one waiting.

### 8.3 Inline pull quotes

- The writer places a quote in the body with a directive line `:::quote{id=Q1}` (the FACTS quote id),
  optionally followed by its own prose. The prompt says: use the directive for every ledger quote you
  print; do not also repeat the quote text inside quotation marks; your `writerResponse` goes in the
  `quotes[]` output, not in the body.
- Verifier: every `:::quote{id=…}` id must exist in the ledger (block otherwise) and every `quotes[]`
  entry must appear as a directive in some section (warn otherwise).
- `MarkdownPreview` accepts `quotes?: ArticleQuote[]` and renders each directive as `<PullQuote>`
  (speaker, team, week, writerResponse). The article page passes `article.quotes`. The trailing
  "From the sideline" block lists only quotes that were not placed inline.

### 8.4 Prior claims (Mel's Receipts, for every writer)

- Output schema gains `claims: Array<{ text: string; kind: "team_win" | "team_finish" | "player_points" | "trade_verdict" | "general"; subjectTeamId?: string; opponentTeamId?: string; subjectPlayer?: string; week?: number; minRank?: number; maxRank?: number; minPoints?: number }>`.
  Only explicit predictions, phrased as the writer wrote them. Stored on `aiContent.claims` with
  `outcome: "open"` and `persona`, `week`, `season`.
- `convex/claims.ts`: `resolveOpenClaims` (internalMutation, weekly cron Tuesday 09:30 UTC, before
  decay): `team_win` resolves from `matchups` for that week; `team_finish` from standings at the
  claim's week or season end; `player_points` from matchup player points; `trade_verdict` and
  `general` stay open (P3 LLM judge). Writes `outcome: "hit" | "miss"` and `resolvedAt`.
  `getPriorClaimsForWriter` (internalQuery) args `{ leagueId, persona, teamIds?: string[], limit? }`
  → `{ items: PriorClaim[], record: { hits, misses, open } }`. `getWriterRecords` (query, league
  member) args `{ leagueId }` → per active writer `{ persona, hits, misses, open }`.
- `generateContentAction` and `generateAIContentWithData` replace `priorClaims: []` with the query
  result; `GenerationRequest.priorRecord?: { hits, misses, open }`; `FactsBlock.priorRecord?` same.
  Prompt: when `priorClaims` is non-empty the writer may cite them by week; Mel closes with
  "Mel's Receipts: {hits}-{misses}"; every writer may mention their own record.
- UI: writer lineup cards show the record when hits+misses > 0 ("Receipts 4-2").

### 8.5 Seven templates

Add to `content-templates.ts`, same `ContentTemplate` shape as the rest, 4–6 sections each, word
targets as ceilings, `requiredData` from the existing keys: `draft_strategy_guide`,
`team_name_power_rankings`, `trade_block_tuesday`, `commissioner_corner`, `playoff_picture`,
`hall_of_shame`, `player_glazing` (display name "The Case For": honest problem first, the case, the
path, one named risk). `personaRoster.ts` derives availability from `contentTemplates` keys at
runtime instead of a hard-coded list.

### 8.6 Optional fact-check pass, ADP presentation

- `FACT_CHECK_LLM` env (Convex) = "1" enables a Sonnet 5 pass (`effort: "low"`, ≤800 output tokens)
  after the deterministic verifier is clean, for `draft_rankings`, `season_recap`, and any article with
  quotes: input FACTS + body, output `[{ claim, sectionName, verdict: supported|contradicted|unsupported, factPath? }]`;
  `contradicted` → strip + flag, `unsupported` → warn.
- Draft data: always print ADP and the signed delta for every pick; print `perceivedValue` with a
  one-line legend; unify best/worst dedupe so a player appears in only one list; delete the
  sign-correction prose.

### 8.7 Eval harness and desk metrics

- `src/lib/ai/__fixtures__/{rich-week,sparse-week,draft-day,empty-league}.json` as frozen
  `LeagueDataContext` objects (plus comment ledgers) with `expected.json` per fixture (facts counts,
  expected `missing`).
- `scripts/eval-articles.ts` + `npm run eval:articles [--live] [--persona x] [--type y]`. Offline mode
  (default, no API key): builds FACTS + prompts for every fixture × writer × the four highest-volume
  types, asserts prompt order and `missing`, runs the verifier on recorded sample outputs under
  `__fixtures__/samples/`. Live mode: generates with the real service, runs the verifier, prints a
  table of attribution accuracy, quote fidelity, ghost speakers, number precision, source validity,
  sparse-week restraint ratio, and a Sonnet 5 persona-adherence rubric (1–5).
- `generationStats` gains `factsCount`, `wordCount`, `quotesOffered`, `quotesUsed`.
- `convex/deskMetrics.ts` `getDeskMetrics` (query, commissioner) args `{ leagueId, sinceDays? }` →
  `{ perWriter: [{ persona, articles, ungroundedPer1k, quoteFidelity, paddingIndex }], recentFlags: [...] }`.
  Page `src/app/leagues/[id]/desk/page.tsx` "Desk metrics" (commissioner only): three stat tiles,
  per-writer table, recent flags list. Broadcast kit; both themes.

### 8.8 Ownership

- **P2-A (Convex):** `convex/schema.ts`, `convex/commentConversations.ts`,
  `convex/aiContentWithComments.ts`, `convex/claims.ts` (new), `convex/aiContent.ts`,
  `convex/aiContentHelpers.ts`, `convex/crons.ts`, `convex/validators.ts`.
- **P2-B (prompt layer):** `src/lib/ai/content-generation-service.ts`, `facts.ts`,
  `prompt-builder.ts`, `fact-verifier.ts`, `content-templates.ts`, `persona-prompts.ts`.
- **P2-C (UI):** `src/components/MarkdownPreview.tsx`, `src/components/ContentGenerator.tsx`,
  `src/components/CommentConversation.tsx`, `src/app/leagues/[id]/comment-requests/[requestId]/page.tsx`,
  `src/components/AIGenerationPage.tsx`, `src/app/articles/[id]/ArticleClient.tsx`,
  `src/components/broadcast/*`, `src/components/WriterLineup.tsx`, `src/components/LeagueHomepage.tsx`,
  new components.
- **P2-D (eval + metrics):** `src/lib/ai/__fixtures__/**`, `scripts/eval-articles.ts`, `package.json`
  scripts only, `convex/deskMetrics.ts` (new), `src/app/leagues/[id]/desk/**` (new), `tests/**`.
