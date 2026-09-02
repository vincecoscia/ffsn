/**
 * Does Sam honor "No comment"? Sends a decline as the first reply and prints what the interviewer
 * decides (spec §5: thank once, close, set shouldRecordDecline). Costs a few cents.
 *
 *   npx vite-node scripts/measure-decline.ts
 */
import { conversationService, type ConversationContext } from "../src/lib/ai/conversation-service";

const base: ConversationContext = {
  userId: "user_decline",
  leagueId: "league_decline",
  scheduledContentId: undefined,
  contentType: "weekly_recap",
  week: 10,
  seasonId: 2025,
  managerName: "Brett Brosius",
  teamName: "Tua Deez Nuts",
  interviewerPersona: "sam-ortega",
  writerPersona: "curtis-vaughn",
  opponentName: "IR Squad",
  opponentScore: 152.8,
  margin: 25.5,
  benchPoints: 44.5,
  teamPerformance: {
    teamId: "1",
    teamName: "Tua Deez Nuts",
    score: 127.3,
    won: false,
    underperformers: [],
    overperformers: [],
  },
  leagueContext: { standings: [] },
  conversationHistory: [],
};

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const opener = await conversationService.generateConversationQuestion(base, apiKey);
  console.log(`OPENER: ${opener.question}`);

  const reply = "No comment.";
  const analysis = await conversationService.analyzeUserResponse(reply, base, apiKey);
  console.log(`ANALYSIS of "${reply}": quotes=${JSON.stringify(analysis.quotableSegments)} offTopic=${analysis.offTopicScore} needsFollowUp=${analysis.needsFollowUp}`);

  const next = await conversationService.generateConversationQuestion(
    {
      ...base,
      conversationHistory: [
        { role: "ai", content: opener.question, timestamp: Date.now() - 60_000 },
        { role: "user", content: reply, timestamp: Date.now() - 30_000 },
      ],
    },
    apiKey
  );
  console.log(`NEXT (intent=${next.intent}, shouldEnd=${next.shouldEndAfterResponse}, recordDecline=${next.shouldRecordDecline}): ${next.question}`);
  console.log(next.shouldRecordDecline && next.intent === "closing" ? "DECLINE PATH: OK" : "DECLINE PATH: NOT HONORED");
}

await main();
