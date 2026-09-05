// The Wire — tier-3 stock lines (spec §3.3): hand-written league posts per persona per event
// kind, filled with slot tokens and chosen deterministically from a seed. No model, ever.
//
// Voice source: ffsn-ai-personas.md and the persona definitions in persona-prompts.ts. Every line
// uses only SLOT_TOKENS and never carries an invented statistic, name or quote — the slots are the
// facts, the words around them are the character. A line's `rating` is the lowest league rating it
// may appear at; a salty/unfiltered line also needs the persona's own allowance at that rating,
// which for the reserved desk (Curtis, Sam, Nina, Dex) is rationed to one piece in three by the
// same seeded rule articles use.
//
// Slot vocabulary per kind (what the Convex hooks are expected to supply; a sentence whose slots
// are missing is dropped by fill.ts, so a line's first sentence uses only the core slots):
//   waiver_processed  team, manager, player, pos, bid, losingBids, faab, week
//   add_drop          team, manager, player, pos, week
//   trade             team, opponentTeam, player, week, manager
//   week_final        team (winner), opponentTeam (loser), score, opponentScore, margin, week, record
//   game_of_week      team (winner), opponentTeam, score, opponentScore, margin, week
//   streak            team, streak ("W4"), record, week, manager
//   top_score         team, manager, score, week, player, points
//   low_score         team, manager, score, week, opponentTeam, margin
//   bench_points      team, points (bench), margin, score, week, player, manager
//   claim_settled     writer, claim, outcome ("hit"|"miss"), record, team, week
//   article_published title, url, writer, week
//
// Pure: imports the contract, fill.ts, language.ts and persona-prompts.ts only.

import { countProfanity, type LanguageRating } from "../language";
import { effectiveLanguageRange, fnv1a, personaPrompts } from "../persona-prompts";
import { fillVariant, isSlotToken, splitTemplateSentences, templateTokens } from "./fill";
import type { LeagueEventKind, StockLine, WireEventKind, WirePersona, WireSlots, WireTag } from "./types";

const REPORTED: WireTag[] = ["REPORTED"];
const FINAL: WireTag[] = ["FINAL"];

function clean(text: string, tags?: WireTag[]): StockLine {
  return tags ? { text, rating: "clean", tags } : { text, rating: "clean" };
}
function salty(text: string, tags?: WireTag[]): StockLine {
  return tags ? { text, rating: "salty", tags } : { text, rating: "salty" };
}
function unfiltered(text: string, tags?: WireTag[]): StockLine {
  return tags ? { text, rating: "unfiltered", tags } : { text, rating: "unfiltered" };
}

/* ------------------------------------------------------------------------------------------- *
 * Dex Alvarez — Insider · Transactions Desk. Phone-hit fragments, tier tags, "Stand by."
 * ------------------------------------------------------------------------------------------- */

const DEX_WAIVER: StockLine[] = [
  clean("REPORTED: {team} lands {player} ({pos}) for {bid}. {losingBids}. Filed. Stand by.", REPORTED),
  clean("Here's what I've got. {team}, {player}, {bid}. Processed. {faab} left in the account. Back to you.", REPORTED),
  clean("Waivers cleared. {player} to {team} at {bid}. {losingBids} behind it. That's the wire.", REPORTED),
  clean("{team}: {player} ({pos}), {bid}, processed. Checked twice. Phone works.", REPORTED),
  clean("REPORTED: {bid} on {player}. {team} wins the claim. {losingBids}. More when I have it.", REPORTED),
  clean("Week {week} waivers. {team} spent {bid} on {player}. {faab} left. Noted. Filed.", REPORTED),
  clean("{player} is a {team} player as of this morning's log. Price: {bid}. Stand by.", REPORTED),
  clean("One claim worth reading out. {team}, {player}, {bid}. Back to you.", REPORTED),
  clean("REPORTED: {team} paid {bid} for {player} ({pos}). {losingBids} came in under it. That's the wire.", REPORTED),
  clean("{manager} put {bid} on {player}. Cleared. {faab} left for the rest of the year. Filed.", REPORTED),
  clean("Waiver desk, Week {week}: {team} adds {player}. {bid}. Stand by.", REPORTED),
  clean("{team} won {player} at {bid}. {losingBids}. The market spoke, briefly. Back to you.", REPORTED),
  clean("REPORTED: {player} ({pos}) to {team}. Bid {bid}. Balance after: {faab}.", REPORTED),
  clean("Claim processed. {team}. {player}. {bid}. Three facts, one line. That's the wire.", REPORTED),
  clean("{team} outbid the room for {player}. {losingBids}. Price {bid}. More when I have it.", REPORTED),
  clean("Here's the waiver that moved money: {team}, {player}, {bid}. Stand by.", REPORTED),
  clean("REPORTED, straight off the log: {team} bid {bid} on {player} and got him. {faab} remains. Filed.", REPORTED),
  clean("Week {week}, waivers: {player} goes to {team} for {bid}. {losingBids}. Checked twice.", REPORTED),
  clean("{team} bought a {pos}: {player}, {bid}. Whether they needed one is above this desk. Back to you.", REPORTED),
  clean("Processed: {player} to {team}, {bid}. {losingBids}. Stand by.", REPORTED),
  clean("REPORTED: {team} clears the claim on {player}. {bid}. {faab} left. The phone did not ring about it.", REPORTED),
  clean("{bid} for {player}. {team}. {losingBids}. Nobody called to explain it, and nobody had to.", REPORTED),
  salty("Waivers cleared and {player} went to {team} for {bid}. The rest of the wire: dead as hell. Checked twice.", REPORTED),
  unfiltered("{team}, {player}, {bid}. The rest of the wire was bleak as shit. Back to you.", REPORTED),
];

const DEX_ADD_DROP: StockLine[] = [
  clean("REPORTED: {team} adds {player} ({pos}). Free agent, no bid, no fuss. Filed.", REPORTED),
  clean("{team} picked up {player}. Week {week}. That's a move; it counts. Back to you.", REPORTED),
  clean("Here's what I've got: {player} to {team}, off the street. Stand by.", REPORTED),
  clean("Transaction desk: {team} adds {player} ({pos}). One line, one move. More when I have it.", REPORTED),
  clean("{manager} made a move. {player}, {pos}, added. Noted. Filed.", REPORTED),
  clean("{team}: {player} in. Week {week}. Checked twice. Phone works.", REPORTED),
  clean("REPORTED: free-agent pickup. {player} ({pos}) lands with {team}. That's the wire.", REPORTED),
  clean("Add: {player}. Team: {team}. Tier: REPORTED. Stand by.", REPORTED),
  clean("{team} went shopping and came back with {player}. No bid needed. Back to you.", REPORTED),
  clean("On the wire: {team} adds {player} ({pos}). Filed.", REPORTED),
  clean("{player} ({pos}) is on {team}'s roster as of now. Free-agent add. More when I have it.", REPORTED),
  clean("REPORTED: {team} adds {player}. That is the whole hit. Back to you.", REPORTED),
  clean("Week {week}. {team}. {player}. Added. Four words, four facts. Stand by.", REPORTED),
  clean("{manager} added {player} ({pos}) to {team}. Nobody outbid; nobody had to. That's the wire.", REPORTED),
  clean("Straight pickup, no waiver: {player} to {team}. Filed.", REPORTED),
  clean("{team} adds {player}. The market for {pos} just moved by one. Back to you.", REPORTED),
  clean("REPORTED: {player} added by {team} in Week {week}. Free agent, not a waiver. Stand by.", REPORTED),
  clean("New name on {team}: {player}, {pos}. Filed. More when I have it.", REPORTED),
  clean("{team} adds {player}. A move is a move. This desk logs all of them.", REPORTED),
  clean("Here's the add. {player}, {pos}, {team}. Here's the tier: REPORTED. Back to you.", REPORTED),
  clean("{manager} was awake, apparently: {player} added to {team}. Checked twice.", REPORTED),
  salty("{team} adds {player} ({pos}). The rest of this league is dead as hell. Filed.", REPORTED),
  unfiltered("{team} adds {player}. The rest of the league did shit-all. Checked twice.", REPORTED),
];

const DEX_TRADE: StockLine[] = [
  clean("REPORTED: {team} and {opponentTeam} made a trade. Filed Week {week}. Analysis to follow. Stand by.", REPORTED),
  clean("Trade. {team}, {opponentTeam}. Week {week}. It's in the log. That's the wire.", REPORTED),
  clean("Here's what I've got: {team} and {opponentTeam}, {player} in the deal. Two teams, one signature each. Back to you.", REPORTED),
  clean("REPORTED: {player} changes hands. {team} and {opponentTeam} agreed. Nobody says why yet, and nobody has to. More when I have it.", REPORTED),
  clean("A trade went through. Repeat: a trade went through. {team} and {opponentTeam}. Stand by.", REPORTED),
  clean("{team} and {opponentTeam} moved {player}. Filed. My read comes later; this line is REPORTED.", REPORTED),
  clean("Week {week} trade desk: {team}, {opponentTeam}. Signed and processed. More when I have it.", REPORTED),
  clean("STATED: nothing yet. REPORTED: {team} and {opponentTeam} traded, {player} in the deal. Back to you.", REPORTED),
  clean("Two-team deal. {team}. {opponentTeam}. Processed this week. Checked twice.", REPORTED),
  clean("The market has a pulse: {team} and {opponentTeam} made a trade. Stand by.", REPORTED),
  clean("REPORTED: {player} changes hands between {team} and {opponentTeam}. Filed Week {week}.", REPORTED),
  clean("Trade filed. {team} and {opponentTeam} both signed. The log is the story; the analysis is next. Back to you.", REPORTED),
  clean("{manager} pulled the trigger with {opponentTeam}. Trade processed, Week {week}. Stand by.", REPORTED),
  clean("One trade on the wire: {team} and {opponentTeam}. The terms are in the log; the read is next.", REPORTED),
  clean("REPORTED: {team} and {opponentTeam} traded. Somebody in this league answered the phone. Filed.", REPORTED),
  clean("Not a rumor. Not a listing. A trade: {team}, {opponentTeam}, Week {week}. That's the wire.", REPORTED),
  clean("{player} moved. {team} and {opponentTeam} did the moving. Processed. More when I have it.", REPORTED),
  clean("Trade desk, live: {team} and {opponentTeam} got a deal done. My read, not reporting: somebody blinked. Stand by.", ["REPORTED", "OPINION"]),
  clean("REPORTED: a trade cleared. {team} on one side, {opponentTeam} on the other, {player} in the middle. Back to you.", REPORTED),
  clean("Week {week}. {team}. {opponentTeam}. Trade. Filed at the desk, checked twice.", REPORTED),
  clean("The market finally produced a trade: {team} and {opponentTeam}. Phone works after all.", REPORTED),
  salty("A trade. An actual, filed, processed trade: {team} and {opponentTeam}. Hell of a day for this desk. Stand by.", REPORTED),
  unfiltered("{team} and {opponentTeam} made a trade. Holy shit, a trade. Filed. Back to you.", REPORTED),
];

const DEX_ARTICLE: StockLine[] = [
  clean("New from the desk. {writer}: \"{title}\". {url}. Read it; that's the whole assignment."),
  clean("Filed: \"{title}\", by {writer}. {url}. Stand by."),
  clean("REPORTED: {writer} has a piece up. \"{title}\". {url}. Back to you.", REPORTED),
  clean("Off the desk: \"{title}\" — {writer}. {url}."),
  clean("{writer} filed. Title: \"{title}\". Link: {url}. That's the wire."),
  clean("New piece. {writer}. \"{title}\". {url}. More when I have it."),
  clean("One item from the newsroom: \"{title}\", {writer}. {url}. Noted. Filed."),
  clean("Desk update: {writer} is up with \"{title}\". {url}. Read it before the next hit."),
  clean("Story's live. {writer}, \"{title}\". {url}. Checked the link twice. Works."),
];

/* ------------------------------------------------------------------------------------------- *
 * Curtis Vaughn — Studio Anchor. Teleprompter cadence, one dry tag, the toss by first name.
 * ------------------------------------------------------------------------------------------- */

const CURTIS_WEEK_FINAL: StockLine[] = [
  clean("Good evening. Final in Week {week}: {team} {score}, {opponentTeam} {opponentScore}. That is a result. Let's go to the board.", FINAL),
  clean("Final: {team} over {opponentTeam} by {margin}. {team} moves to {record}. We'll leave that there.", FINAL),
  clean("The desk can confirm a final. {team} {score}, {opponentTeam} {opponentScore}. Do with that what you will.", FINAL),
  clean("{team} {score}, {opponentTeam} {opponentScore}. Final. Nina has the bench math.", FINAL),
  clean("Week {week} is in the books for {team}: a win by {margin}, record now {record}. Stay with us.", FINAL),
  clean("For those keeping score at home: {team} {score}, {opponentTeam} {opponentScore}. That's a final.", FINAL),
  clean("Final from Week {week}. {team} by {margin}. {opponentTeam} will have questions; Sam is asking them.", FINAL),
  clean("The board says {team} {score}, {opponentTeam} {opponentScore}. The board is rarely wrong. Final.", FINAL),
  clean("{team} wins. {opponentTeam} does not. Margin, {margin}. That is the item.", FINAL),
  clean("In a development that surprised no one on this set, a game ended: {team} {score}, {opponentTeam} {opponentScore}. Final.", FINAL),
  clean("Final. {team} over {opponentTeam}, {score} to {opponentScore}. More on that after the break.", FINAL),
  clean("Good evening. {team} is {record} after a {margin}-point win over {opponentTeam}. We'll have more on that after the break.", FINAL),
  clean("Scoreboard, Week {week}: {team} {score}, {opponentTeam} {opponentScore}. Reggie has thoughts, and he's up next.", FINAL),
  clean("{team} by {margin}. That is a margin. {opponentTeam} left the building with {opponentScore}. Final.", FINAL),
  clean("The desk regrets to report, on behalf of {opponentTeam}, a final: {team} {score}, {opponentTeam} {opponentScore}.", FINAL),
  clean("Final in Week {week}. {team} {score}. {opponentTeam} {opponentScore}. Dex is working the phones on what happens next.", FINAL),
  clean("{team} wins by {margin} and sits at {record}. Read that once, flat, and move on. This is FFSN.", FINAL),
  clean("Result: {team} {score}, {opponentTeam} {opponentScore}. Margin {margin}. We'll leave that there.", FINAL),
  clean("Top of the show: {team} beat {opponentTeam} by {margin} in Week {week}. That's the weather. Now the board.", FINAL),
  clean("{team} {score}. {opponentTeam} {opponentScore}. Final. One of those teams is {record}. It's the first one.", FINAL),
  clean("Final, read once: {team} over {opponentTeam} by {margin}. Stay with us.", FINAL),
  clean("A final for Week {week}. {team} by {margin}. Walt will tell you what it means; I'll tell you the number.", FINAL),
  salty("Final: {team} {score}, {opponentTeam} {opponentScore}. Well, hell. Let's go to the board.", FINAL),
  unfiltered("{team} {score}, {opponentTeam} {opponentScore}. That's a final, and that's bullshit. We'll be right back.", FINAL),
];

const CURTIS_GAME_OF_WEEK: StockLine[] = [
  clean("Game of the week: {team} {score}, {opponentTeam} {opponentScore}. Decided by {margin}. Everything else was decided by more. Let's go to the board."),
  clean("Tightest game on the board in Week {week}: {team} over {opponentTeam} by {margin}. That is a margin. Nina has the bench math."),
  clean("Good evening. Your game of the week went to {team}, {score} to {opponentScore}, by {margin}. We'll call that parity."),
  clean("{team} and {opponentTeam} gave us the closest thing to a game this week: {margin} the difference. {team} took it."),
  clean("Game of the week, Week {week}. {team} {score}. {opponentTeam} {opponentScore}. {margin} between them. Stay with us."),
  clean("The one worth watching: {team} over {opponentTeam} by {margin}. Sam is on the sideline with the loser."),
  clean("By {margin}. That's how close {team} and {opponentTeam} were, and that's why it's the game of the week. Final: {score} to {opponentScore}."),
  clean("For those keeping score at home, the score to keep: {team} {score}, {opponentTeam} {opponentScore}. Margin {margin}."),
  clean("Game of the week goes to {team}. {opponentTeam} lost it by {margin}. Do with that what you will."),
  clean("Week {week}'s closest call: {team} {score}, {opponentTeam} {opponentScore}. Reggie is up next, and he has a view."),
  clean("{team} over {opponentTeam}, {margin} the margin, and nobody on this set had to raise their voice. Game of the week."),
  clean("Closest game on the board: {team} and {opponentTeam}, separated by {margin}. {team} had the {score}. Final."),
  clean("Game of the week: {margin} points, {team} on the right side of it, {opponentTeam} on the other. More after the break."),
  clean("The desk presents the game of the week. {team} {score}, {opponentTeam} {opponentScore}. We'll leave that there."),
  clean("{margin}. That is the number that made {team} and {opponentTeam} the game of Week {week}. The score was {score} to {opponentScore}."),
  clean("Game of the week. {team} by {margin}. {opponentTeam} was right there, which is the polite way to put it."),
  clean("Coming up: everything but the game of the week, which was {team} {score}, {opponentTeam} {opponentScore}. That one's done."),
  clean("Week {week}, game of the week: {team} edges {opponentTeam}, {score} to {opponentScore}. Margin {margin}. Stay with us."),
  clean("The closest game was decided by {margin}. {team} won it. {opponentTeam} will be hearing from Sam. This is FFSN."),
  clean("Good evening. {team} beat {opponentTeam} by {margin} in the game of the week, and nobody else came close. Let's go to the board."),
  clean("Game of the week: {team} {score}, {opponentTeam} {opponentScore}. Dex is working the phones; Nina has the math; I have the score."),
  salty("Game of the week came down to {margin}. {team} took it, {score} to {opponentScore}. Well, hell. Stay with us."),
  unfiltered("{team} over {opponentTeam} by {margin}. Game of the week. Horseshit margin, real result. We'll be right back."),
];

const CURTIS_STREAK: StockLine[] = [
  clean("Good evening. {team} is {record}, streak {streak}. That is a trend. Let's go to the board."),
  clean("{team}, {streak}. Record {record}. Read once, flat. Stay with us."),
  clean("For those keeping score at home: {team} has run it to {streak}. We'll leave that there."),
  clean("Streak watch, Week {week}: {team} at {streak}, {record} overall. Nina has the math on whether it means anything."),
  clean("{streak}. That is {team}'s streak and this desk reads it without comment. Next item."),
  clean("In a development that surprised no one on this set, {team} extended the streak: {streak}. Record {record}."),
  clean("The desk notes {team} at {streak} through Week {week}. Do with that what you will."),
  clean("{team}: {record}, {streak}. Walt has feelings about it. Walt is up later."),
  clean("Streak update. {team}. {streak}. We'll have more on that after the break."),
  clean("Top of the show: {team} is on a {streak} streak at {record}. That's the weather. Now the board."),
  clean("{manager}'s {team} is {streak}. Say it once and move on; that's the anchor's job."),
  clean("{team} keeps the streak alive: {streak}, {record} on the year. Reggie will want flowers handed out. He's up next."),
  clean("The streak is real and it is {streak}. {team}. Record {record}. This is FFSN."),
  clean("Week {week} standings note: {team} at {streak}. That is a run. We'll leave that there."),
  clean("{team}, {streak}, {record}. Three facts, one item. Stay with us."),
  clean("The desk regrets nothing, but it does note {team}'s {streak}. Record {record}."),
  clean("{team} is {record} and riding {streak}. Dex is checking whether anybody in this league has noticed."),
  clean("Streak, {team}: {streak}. If it holds, Nina has a column for it. If it doesn't, Walt does."),
  clean("Good evening. {team} is on a {streak} run. That's the item; that's the tag; that's the show."),
  clean("{streak} for {team}. Record {record}. Coming up: everybody else."),
  clean("The board shows {team} at {streak} through Week {week}. The board does not editorialise. Neither do I."),
  salty("{team}: {streak}, {record}. Well, hell. Let's go to the board."),
  unfiltered("{team} at {streak}. Reggie says dawg; Walt says fluke; the board says {record}. That's bullshit from one of them, and we'll be right back."),
];

const CURTIS_ARTICLE: StockLine[] = [
  clean("New from the desk. {writer} has \"{title}\". {url}. We'll leave that there."),
  clean("Good evening. {writer} filed \"{title}\". {url}. Read it after the break."),
  clean("From the newsroom: \"{title}\", by {writer}. {url}. Stay with us."),
  clean("The desk presents \"{title}\". {writer} wrote it; I'm reading the headline. {url}."),
  clean("Coming up, in print: \"{title}\" by {writer}. {url}. This is FFSN."),
  clean("{writer} is up with \"{title}\". {url}. Do with that what you will."),
  clean("New piece on the board: \"{title}\" — {writer}. {url}."),
  clean("We go now to {writer}, in writing: \"{title}\". {url}. More after the break."),
  clean("Filed and published: \"{title}\", {writer}. {url}. That's the show."),
];

/* ------------------------------------------------------------------------------------------- *
 * Nina Sharpe — The Numbers Desk. Lecture register, the number, the grade, "That's the segment."
 * ------------------------------------------------------------------------------------------- */

const NINA_BENCH: StockLine[] = [
  clean("Class. {team} left {points} on the bench in Week {week}. Circle that column. That's the segment."),
  clean("Pop quiz: {team} scored {score} and benched {points}. Which number is the manager's fault? Show your work."),
  clean("{team}: {points} bench points, lost by {margin}. Was it the schedule? It was not. That's the segment."),
  clean("Circle this: {points} on {team}'s bench. Everyone look at the board. Only one of those numbers is a decision."),
  clean("{player} sat and scored for {team}. Bench total: {points}. I checked it twice. I may frame it."),
  clean("Week {week}, bench math. {team}: {points} sitting down. The story says bad luck. The column says lineup."),
  clean("{team} benched {points} points and lost by {margin}. Not supported: \"nothing I could do.\" Show your work."),
  clean("The bench doesn't have a schedule, and {team}'s scored {points}. Class dismissed early; that's the whole lesson."),
  clean("{manager} left {points} on the bench. Hold it loosely; one week. I am holding it loosely. I am also still right."),
  clean("Everyone look at {team}'s row. Starters {score}. Bench {points}. Circle the second one."),
  clean("Bench points, Week {week}: {team}, {points}. That is a real column. That's the segment."),
  clean("{team} scored {score} and had {points} more sitting down. Was it momentum? It was not. It was a lineup."),
  clean("Partial credit for {team}'s {score}. None for the {points} on the bench. Grade posted."),
  clean("{points} bench points for {team}. Reggie will say scoreboard. The scoreboard has a bench column too."),
  salty("{team} benched {points} and lost by {margin}. Hell of a column, and only one of them is a decision."),
  unfiltered("{team}'s bench scored {points}. The starters scored {score}. That is, and I am using the technical term, a fucking problem. Moving on."),
];

const NINA_CLAIM: StockLine[] = [
  clean("Class. {writer} wrote: \"{claim}\". Week {week} says {outcome}. Record on the desk: {record}. That's the segment."),
  clean("Grading homework. Claim: \"{claim}\" ({writer}). Outcome: {outcome}. Show your work; {writer} did."),
  clean("A claim settled. \"{claim}\" — {writer}. Result: {outcome}. Running record {record}."),
  clean("Circle this column: {writer}'s calls, now {record}. The latest — \"{claim}\" — was a {outcome}."),
  clean("Week {week}: {writer} said \"{claim}\". The board says {outcome}. No partial credit; the board doesn't give it."),
  clean("Pop quiz: was {writer} right about {team}? \"{claim}\" — {outcome}. Grade posted, record {record}."),
  clean("Claim, graded: \"{claim}\". Writer: {writer}. Outcome: {outcome}. That's the segment."),
  clean("The desk keeps score on itself. {writer}: \"{claim}\". {outcome}. Now {record} on the year."),
  clean("\"{claim}\" was {writer}'s call. Result in Week {week}: {outcome}. I checked it twice."),
  clean("{writer} on {team}: \"{claim}\". Settled: {outcome}. The record is {record}, and I'm holding it loosely."),
  clean("Homework returned. {writer}, \"{claim}\": {outcome}. Sample is still small. I am still right about the sample."),
  clean("Settled in Week {week}: \"{claim}\". {writer} took the swing; the board says {outcome}."),
  clean("Record check, {writer}: {record} after \"{claim}\" came in a {outcome}. Circle that column."),
  clean("\"{claim}\" ({writer}). {outcome}. That is a real column and I may frame it."),
  salty("\"{claim}\" — {writer}. {outcome}. Hell of a call, graded. Record {record}."),
  unfiltered("{writer}: \"{claim}\". {outcome}. I don't grade on a curve and I don't give a shit about the narrative. Record {record}."),
];

const NINA_ARTICLE: StockLine[] = [
  clean("Class. Required reading: \"{title}\", by {writer}. {url}. Show your work after."),
  clean("New on the board: \"{title}\" — {writer}. {url}. Circle the numbers."),
  clean("{writer} filed \"{title}\". {url}. I have not graded it yet. I will."),
  clean("Homework: \"{title}\", {writer}. {url}. There will be a quiz."),
  clean("Everyone look at the board. {writer}, \"{title}\". {url}. That's the segment."),
  clean("Published: \"{title}\" by {writer}. {url}. The columns are in there. Find them."),
  clean("New from the desk: \"{title}\". {writer} wrote it. {url}. Read it twice; I did."),
  clean("{writer} is up: \"{title}\". {url}. Hold the narrative loosely. Hold the numbers tight."),
  clean("Reading assignment, Week {week}: \"{title}\" ({writer}). {url}."),
];

/* ------------------------------------------------------------------------------------------- *
 * Reggie Banks — The Results Desk. Joy in caps, flowers, "Scoreboard!" Never angry.
 * ------------------------------------------------------------------------------------------- */

const REGGIE_TOP: StockLine[] = [
  clean("{score}. TOP SCORE IN THE LEAGUE, Week {week}. {team}. GIVE THAT MAN HIS FLOWERS!"),
  clean("Put some respect on {team}. {score} points. That's a DAWG. Scoreboard!"),
  clean("{manager} put up {score} this week. I don't care where anybody was drafted. {score}! Flowers!"),
  clean("High score, Week {week}: {team}, {score}. {player} led the way with {points}. THAT is a lineup!"),
  clean("{team} dropped {score} on the league. Cute drafts, everybody else. {score}. I'll wait."),
  clean("SCOREBOARD! {team}, {score}, top of the week. You can take that to the bank."),
  clean("{player} went for {points} and {team} went for {score}. GIVE THAT MAN HIS FLOWERS."),
  clean("Top score: {team}. {score}. Paper said whatever paper says. The scoreboard said {score}!"),
  clean("{manager}, you set that lineup and it scored {score}. That's on you, and I mean that as a compliment!"),
  clean("Week {week}'s DAWG: {team}, {score} points. Put some respect on it."),
  clean("{score} for {team}. Highest in the building. Projections are a bedtime story; that number is real!"),
  clean("Flowers, Week {week}: {team}, {score}. {player} with {points}. THAT is a manager."),
  clean("{team} led the league with {score}. Should-have is not a column. {score} is. SCOREBOARD!"),
  clean("Top of the board for the week: {team}, {score}. Nobody scored more. I'll wait."),
  salty("{team}, {score}, top score. Hell of a week. Damn right — flowers!"),
  unfiltered("{score}! {team}! SHUT THE FUCK UP — top score in the league. That's a fucking DAWG."),
];

const REGGIE_ARTICLE: StockLine[] = [
  clean("NEW from the desk! \"{title}\" by {writer}. {url}. Read it and then go set your lineup!"),
  clean("{writer} is up: \"{title}\". {url}. Put some respect on that headline."),
  clean("Story's LIVE: \"{title}\" — {writer}. {url}. Scoreboard talk inside!"),
  clean("\"{title}\". {writer} wrote it, and it's about what people DID. {url}."),
  clean("Flowers for the newsroom: \"{title}\" by {writer}. {url}. Read it!"),
  clean("Published! \"{title}\" — {writer}. {url}. You can take that to the bank."),
  clean("Fresh off the desk: \"{title}\", {writer}. {url}. That's a DAWG of a headline."),
  clean("{writer} filed \"{title}\". {url}. Go read what people DID this week!"),
  clean("New piece! \"{title}\" by {writer}. {url}. GIVE THAT WRITER THEIR FLOWERS."),
];

/* ------------------------------------------------------------------------------------------- *
 * Walt Brennan — The Veteran Columnist. Lowercase, the sigh in print, the aphorism.
 * ------------------------------------------------------------------------------------------- */

const WALT_LOW: StockLine[] = [
  clean("the low score this week belongs to {team}, at {score}. a bench is a confession; a score like that is a signed one."),
  clean("{score}. that was {team} in week {week}, and i have looked at that number for a while now without it getting any friendlier."),
  clean("somebody has to finish last on a sunday. this week it was {team}, with {score}, and i say that fondly, the way you'd say it about a car."),
  clean("{team} scored {score}. i've watched this league long enough to know the difference between a bad week and a lesson. i'll let you know which this was."),
  clean("the lowest score of the week: {team}, {score}. nina will show you the column. i'm interested in the man who filled it in."),
  clean("{manager}'s team put up {score}, lowest in the league. i'd call it a method if i thought anyone was following one."),
  clean("low score, week {week}: {team}, {score}. somebody is going to learn something from this. i've done this long enough not to bet on who."),
  clean("{team} lost to {opponentTeam} by {margin} and scored {score}. two numbers, and neither one of them is arguing with the other."),
  clean("a season is a mortgage, and {team} missed a payment this week: {score}, lowest on the board."),
  clean("{score} points. {team}. i don't need a metaphor for that one; the number is doing the work."),
  clean("the floor of the league this week was {team}, at {score}. floors are honest. that's their whole charm."),
  clean("{team}, {score}, week {week}. i've seen worse in this league. not often, and not for free."),
  clean("low man on the board: {team}, {score}. curtis will read it flat. i'll just sigh."),
  clean("{team} scored {score} and lost by {margin}. i looked for the excuse in there and found a lineup instead."),
  salty("{team} scored {score}, low of the week. a damn shame, and i've watched this league long enough to know the difference between a shame and a lesson."),
  unfiltered("it was a shitty week to be {team}. {score}, lowest on the board, and i have looked at that number for a while now without it getting any friendlier."),
];

const WALT_ARTICLE: StockLine[] = [
  clean("i wrote a column. it's called \"{title}\" and it's here: {url}. read it slowly; i did."),
  clean("new from the desk: \"{title}\", by {writer}. {url}. it's longer than it needs to be and shorter than i wanted."),
  clean("{writer} has a piece up, \"{title}\". {url}. i'd tell you what it means, but that's what the piece is for."),
  clean("\"{title}\" — {writer}. {url}. somebody is going to learn something from it. i've done this long enough not to bet on who."),
  clean("published: \"{title}\" by {writer}. {url}. curtis will read you the headline; i'll wait for you to read the rest."),
  clean("a column went up. \"{title}\", {writer}. {url}. it has an argument in it, which is more than most weeks."),
  clean("{writer}, \"{title}\". {url}. one argument, told as a story. that's the whole recipe."),
  clean("new piece: \"{title}\". {writer} wrote it. {url}. i'm entitled to the column; you're entitled to skip it."),
  clean("\"{title}\" is up, from {writer}. {url}. read it before sunday, or after. the league won't wait either way."),
];

/* ------------------------------------------------------------------------------------------- *
 * Mel Diaper — The Draft Disaster. Draft-anchored only: no P1 league kinds, just his byline.
 * ------------------------------------------------------------------------------------------- */

const MEL_ARTICLE: StockLine[] = [
  clean("NEW PIECE. \"{title}\". {url}. I have the receipts and I have ALL DAY. Read it."),
  clean("\"{title}\" — {writer}. {url}. The ADP sheet is in my hand and the CAPS LOCK is on."),
  clean("Published: \"{title}\". {url}. Somebody's draft is about to get a HEARING."),
  clean("{writer} filed \"{title}\". {url}. Read it. THEN argue with me. You'll lose."),
  clean("It's up. \"{title}\". {url}. Every accusation in there is pinned to a pick number. EVERY ONE."),
  clean("\"{title}\", by {writer}. {url}. I want a hearing and I want it in writing, and this is the writing."),
  clean("NEW from the draft desk: \"{title}\". {url}. Receipts attached. Volume attached. Read it."),
  clean("{writer}: \"{title}\". {url}. I had him three rounds later and I have the receipts. Click."),
  clean("\"{title}\". {url}. If your name is in there, you REACHED, and you know it."),
];

/* ------------------------------------------------------------------------------------------- *
 * Sam Ortega — Sideline Reporter. Present tense, the mic, nothing but her byline in P1.
 * ------------------------------------------------------------------------------------------- */

const SAM_ARTICLE: StockLine[] = [
  clean("I filed. \"{title}\" is up: {url}. I asked; here's exactly what they said."),
  clean("New from the desk: \"{title}\", by {writer}. {url}. I have the people. Nina has the rest of the numbers."),
  clean("\"{title}\" — {writer}. {url}. Every paragraph has a quote or a note that none was given."),
  clean("Story's live. \"{title}\". {url}. This is the part where I hold the mic and wait."),
  clean("{writer} filed \"{title}\". {url}. Read it; the quotes are theirs, the questions are mine."),
  clean("Published: \"{title}\" ({writer}). {url}. I ask. They answer. It's in there."),
  clean("I walk the sideline and I write it down. \"{title}\": {url}."),
  clean("New piece up: \"{title}\", {writer}. {url}. The follow-up questions are in there too."),
  clean("\"{title}\" is up. {url}. I'm already asking about the next one."),
];

/* ------------------------------------------------------------------------------------------- *
 * The library
 * ------------------------------------------------------------------------------------------- */

export const STOCK_LINES: Record<WirePersona, Partial<Record<LeagueEventKind, ReadonlyArray<StockLine>>>> = {
  "dex-alvarez": {
    waiver_processed: DEX_WAIVER,
    add_drop: DEX_ADD_DROP,
    trade: DEX_TRADE,
    article_published: DEX_ARTICLE,
  },
  "curtis-vaughn": {
    week_final: CURTIS_WEEK_FINAL,
    game_of_week: CURTIS_GAME_OF_WEEK,
    streak: CURTIS_STREAK,
    article_published: CURTIS_ARTICLE,
  },
  "nina-sharpe": {
    bench_points: NINA_BENCH,
    claim_settled: NINA_CLAIM,
    article_published: NINA_ARTICLE,
  },
  "reggie-banks": {
    top_score: REGGIE_TOP,
    article_published: REGGIE_ARTICLE,
  },
  "walt-brennan": {
    low_score: WALT_LOW,
    article_published: WALT_ARTICLE,
  },
  "mel-diaper": {
    article_published: MEL_ARTICLE,
  },
  "sam-ortega": {
    article_published: SAM_ARTICLE,
  },
};

/** Line counts per persona and kind, for the eval printout and the count test. */
export function stockLineCounts(): Array<{ persona: WirePersona; kind: LeagueEventKind; total: number; clean: number; salty: number; unfiltered: number }> {
  const out: Array<{ persona: WirePersona; kind: LeagueEventKind; total: number; clean: number; salty: number; unfiltered: number }> = [];
  for (const [persona, kinds] of Object.entries(STOCK_LINES) as Array<[WirePersona, Partial<Record<LeagueEventKind, ReadonlyArray<StockLine>>>]>) {
    for (const [kind, lines] of Object.entries(kinds) as Array<[LeagueEventKind, ReadonlyArray<StockLine>]>) {
      out.push({
        persona,
        kind,
        total: lines.length,
        clean: lines.filter(line => line.rating === "clean").length,
        salty: lines.filter(line => line.rating === "salty").length,
        unfiltered: lines.filter(line => line.rating === "unfiltered").length,
      });
    }
  }
  return out;
}

/** Representative slot values per kind: what tests fill with, and what the eval prints. */
export function sampleSlotsFor(kind: WireEventKind): WireSlots {
  const base: WireSlots = {
    team: "Kittle Me This",
    ownerTeam: "Moisty Loins",
    opponentTeam: "Sable Ridge Sentinels",
    manager: "Jordan Lee",
    player: "Joe Burrow",
    pos: "QB",
    nflTeam: "CIN",
    status: "Out",
    timetable: "6-8 weeks",
    faab: "$31",
    bestFA: "Jake Browning",
    backup: "Jake Browning",
    trendingAdds: "1,240",
    week: "4",
    score: "142.8",
    opponentScore: "131.2",
    margin: "11.6",
    points: "38.4",
    bid: "$14",
    losingBids: "2 losing bids",
    record: "5-2",
    streak: "W4",
    title: "The Bank Statement: Week 4",
    url: "https://ffsn.app/leagues/j57abc/articles/k9xyz",
    writer: "Nina Sharpe",
    claim: "Kittle Me This wins by 20",
    outcome: "hit",
  };
  switch (kind) {
    case "low_score":
      return { ...base, team: "Moisty Loins", score: "61.4", margin: "48.2" };
    case "streak":
      return { ...base, streak: "W4" };
    case "claim_settled":
      return { ...base, writer: "Nina Sharpe", outcome: "hit" };
    default:
      return base;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Picking
 * ------------------------------------------------------------------------------------------- */

const RATING_ORDER: Record<LanguageRating, number> = { clean: 0, salty: 1, unfiltered: 2 };

/** Tracked profanity words in a line's template text (the slots carry none). */
function lineProfanity(line: StockLine): number {
  const { mild, strong } = countProfanity(line.text);
  return mild + strong;
}

/**
 * Whether a line may appear at `rating` for this persona on this seed: clean lines always; a
 * salty/unfiltered line only when the league rating reaches it, the persona has an allowance at
 * the line's own rating, and the persona's effective range for this seed (the reserved desk's
 * one-in-three) covers the words the line carries.
 */
function lineAllowed(line: StockLine, persona: WirePersona, rating: LanguageRating, seed: string): boolean {
  if (line.rating === "clean") return true;
  if (rating === "clean" || RATING_ORDER[line.rating] > RATING_ORDER[rating]) return false;
  const prompt = personaPrompts[persona];
  if (!prompt || prompt.language.allowance[line.rating] <= 0) return false;
  const range = effectiveLanguageRange(prompt, rating, seed);
  return range.ceiling >= lineProfanity(line);
}

function sentenceResolves(sentence: string, slots: WireSlots): boolean {
  return templateTokens(sentence).every(token => isSlotToken(token) && (slots[token] ?? "").trim().length > 0);
}

/**
 * Whether a partial fill of this line is still a post: its opening sentence resolves, and at least
 * one sentence that actually names something (carries a slot) survives — "Three facts, one line."
 * on its own is furniture, not a post.
 */
function leadResolves(line: StockLine, slots: WireSlots): boolean {
  const sentences = splitTemplateSentences(line.text);
  if (sentences.length === 0 || !sentenceResolves(sentences[0], slots)) return false;
  return sentences.some(sentence => templateTokens(sentence).length > 0 && sentenceResolves(sentence, slots));
}

/**
 * A filled stock line for `persona` × `kind`, or `null` when the persona or kind is unknown, no
 * line is allowed at `rating`, or no candidate fills with these slots. Candidates are walked in
 * fnv1a(seed) order so the same seed always yields the same line and neighbouring seeds differ.
 * A line that fills completely is preferred; failing that, one whose lead sentence resolves (so a
 * post never opens on a leftover fragment like "Cleared. Filed.").
 */
export function pickStockLine(
  persona: string,
  kind: LeagueEventKind,
  slots: WireSlots,
  seed: string,
  rating: LanguageRating
): { text: string; tags: WireTag[] } | null {
  if (!(persona in STOCK_LINES)) return null;
  const slug = persona as WirePersona;
  const lines = STOCK_LINES[slug][kind];
  if (!lines || lines.length === 0) return null;
  const candidates = lines.filter(line => lineAllowed(line, slug, rating, seed));
  if (candidates.length === 0) return null;
  const start = fnv1a(seed) % candidates.length;
  const ordered = candidates.map((_line, offset) => candidates[(start + offset) % candidates.length]);

  let partial: { text: string; tags: WireTag[] } | null = null;
  for (const line of ordered) {
    const filled = fillVariant(line.text, slots);
    if (!filled.ok) continue;
    const result = { text: filled.text, tags: line.tags ? [...line.tags] : [] };
    if (!filled.dropped || filled.dropped.length === 0) return result;
    if (!partial && leadResolves(line, slots)) partial = result;
  }
  return partial;
}
