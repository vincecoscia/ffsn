/**
 * Measure what one Sam Ortega interview costs: opener → reply analysis → follow-up → analysis
 * → close. Every cost below comes from `costUsd` on the result the service returns, which already
 * carries cache pricing; the `[interview usage]` log lines are printed alongside for the detail.
 *
 * The routing under test (spec §10.3.2): questions run on Opus 5, reply analysis on Sonnet 5 at
 * low effort, and the close is a template with no model call at all — it shows as $0.0000 below.
 *
 *   npx vite-node scripts/measure-interview.ts
 *
 * Needs ANTHROPIC_API_KEY. Costs a few cents. Not part of `npm test`.
 */
import {
  conversationService,
  shouldUseTemplatedClose,
  type ConversationContext,
} from "../src/lib/ai/conversation-service";

interface Call {
  label: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
}

const calls: Call[] = [];

function record(
  label: string,
  result: { usage?: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number }; costUsd: number }
): void {
  calls.push({
    label,
    model: result.usage?.model ?? "(template, no call)",
    input: result.usage?.inputTokens ?? 0,
    output: result.usage?.outputTokens ?? 0,
    cacheRead: result.usage?.cacheReadTokens ?? 0,
    costUsd: result.costUsd,
  });
}

function context(history: ConversationContext["conversationHistory"]): ConversationContext {
  return {
    userId: "user_measure",
    leagueId: "league_measure",
    scheduledContentId: undefined,
    contentType: "weekly_recap",
    week: 7,
    seasonId: 2026,
    managerName: "Priya Rao",
    teamName: "Sunday Scaries",
    interviewerPersona: "sam-ortega",
    writerPersona: "mel-diaper",
    opponentName: "Kittle Me This",
    opponentScore: 118.4,
    margin: 5.5,
    benchPoints: 31.2,
    topBenchPlayer: { player: "Jaylen Waddle", position: "WR", points: 22.6, projectedPoints: 14.1 },
    lineupDecisions: [
      {
        benchedPlayer: "Jaylen Waddle",
        benchedPoints: 22.6,
        startedPlayer: "Rome Odunze",
        startedPoints: 6.4,
        position: "WR",
        pointGain: 16.2,
      },
    ],
    transactionsThisWeek: [
      { type: "waiver", playersAdded: ["Tyjae Spears"], playersDropped: ["Rico Dowdle"], bidAmount: 17 },
    ],
    teamPerformance: {
      teamId: "T2",
      teamName: "Sunday Scaries",
      score: 112.9,
      projectedScore: 121.3,
      won: false,
      underperformers: [{ player: "Rome Odunze", position: "WR", expectedPts: 13.2, actualPts: 6.4 }],
      overperformers: [{ player: "Bijan Robinson", position: "RB", expectedPts: 18.6, actualPts: 27.9 }],
    },
    leagueContext: {
      standings: [
        { teamId: "T1", teamName: "Kittle Me This", rank: 2, record: "5-2" },
        { teamId: "T2", teamName: "Sunday Scaries", rank: 6, record: "4-3" },
      ],
    },
    writerContext: {
      persona: "mel-diaper",
      name: "Mel Diaper",
      relationship: { score: -22, tier: "cold" },
      recentMentions: [
        {
          week: 6,
          stance: "roast",
          evidence: "Priya Rao paid nineteen picks of air for Jalen Hurts and is still paying.",
          articleTitle: "Draft Grades: Receipts Edition",
        },
      ],
    },
    conversationHistory: history,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const opener = await conversationService.generateConversationQuestion(context([]), apiKey);
  record("opener", opener);
  console.log(`\nOPENER: ${opener.question}\n`);

  const reply =
    "I had Waddle in there until about 11:40, then I got cute. And honestly Mel can stick to mock drafts, he has never watched one of my games.";
  const analysis = await conversationService.analyzeUserResponse(reply, context([]), apiKey);
  record("analysis 1", analysis);
  console.log(`ANALYSIS: quotes=${JSON.stringify(analysis.quotableSegments)} writerSentiment=${JSON.stringify(analysis.writerSentiment)}\n`);

  const history: ConversationContext["conversationHistory"] = [
    { role: "ai", content: opener.question, timestamp: Date.now() - 60_000 },
    { role: "user", content: reply, timestamp: Date.now() - 30_000 },
  ];
  const followUp = await conversationService.generateConversationQuestion(context(history), apiKey);
  record("follow-up", followUp);
  console.log(`FOLLOW-UP (${followUp.intent}): ${followUp.question}\n`);

  const reply2 = "No, that's it. Print it.";
  const analysis2 = await conversationService.analyzeUserResponse(reply2, context(history), apiKey);
  record("analysis 2", analysis2);
  console.log(`ANALYSIS 2: quotes=${JSON.stringify(analysis2.quotableSegments)}\n`);

  const closingContext = context([
    ...history,
    { role: "ai", content: followUp.question, timestamp: Date.now() - 20_000 },
    { role: "user", content: reply2, timestamp: Date.now() - 10_000 },
  ]);
  console.log(`shouldUseTemplatedClose: ${shouldUseTemplatedClose(closingContext)}`);
  const close = await conversationService.generateConversationQuestion(closingContext, apiKey);
  record("close", close);
  console.log(`CLOSE (${close.intent}): ${close.question}\n`);

  const total = calls.reduce((sum, entry) => sum + entry.costUsd, 0);
  const modelled = calls.filter(entry => entry.costUsd > 0).length;
  console.log("call  what        model                input  output  cached  cost");
  calls.forEach((entry, index) => {
    console.log(
      `${String(index + 1).padEnd(5)} ${entry.label.padEnd(11)} ${entry.model.padEnd(20)} ` +
        `${String(entry.input).padStart(5)}  ${String(entry.output).padStart(6)}  ` +
        `${String(entry.cacheRead).padStart(6)}  $${entry.costUsd.toFixed(4)}`
    );
  });
  console.log(
    `\nFull interview: $${total.toFixed(4)} across ${modelled} model call(s); ` +
      `${calls.length - modelled} turn(s) served from a template.`
  );
  console.log(JSON.stringify({ calls, totalUsd: total }));
}

await main();
