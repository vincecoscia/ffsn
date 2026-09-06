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
// Dex Desk (spec §18), Dex unless noted. Slot values are strings D-A formats for prose:
//   lineup_move       team, manager, player, slot ("FLEX"), benched?, week?  — {benched} always sits in its own
//                     sentence, so a move with nobody benched simply loses that sentence.
//   late_swap         team, manager, player, slot, minutes ("40"), benched?  — news, never a verdict.
//   reads_the_wire    team, manager, player, status (the tag), hoursAgo — a plain-English gap ("two hours",
//                     "40 minutes"): the lines read "{hoursAgo} after the {status} tag". D-A never sends a
//                     bench move that followed an in-game injury (§16); the lines assume the tag came first.
//   trade_proposal    team (proposer), otherTeam (recipient), players ("A and B", both sides), manager
//   trade_declined    team (the side that declined or withdrew), otherTeam, players?
//   claims_in         player, pos, count ("three" teams), heat ("the bidding looks high" | "a bid or two in").
//                     LEAK POLICY (owner): no {team}, {manager}, {bid}, {faab}, {topBid}, no dollar figure —
//                     tests/wireStockLines.test.ts asserts it.
//   quiet_desk        team (one team or a joined list "A, B and C" — no line conjugates it), weeksSilent ("6"),
//                     deadline (plain English, "Tuesday, November 10")
//   weekly_rundown    week, adds, drops, claims (always) + topPlayer?, topBid?, faabLeader?, faabLeft? — every
//                     optional fact in its own sentence, so a league without FAAB loses only the FAAB sentences.
//   streaming_churn   team, unit ("D/ST" | "K"), count ("four"), player, streak? ("fourth D/ST in five weeks")
//   lineup_lock       team, manager, player, status — factual, at most a dry tag, never "mismanagement" (§16)
//   rumor_check       manager, player (the rostered name in the post), and players ONLY when a proposal exists.
//                     Two libraries: confirm lines carry {players} ("There is a proposal in the system involving
//                     {players}"), deny lines never do ("Nothing in the system on {player}. Yet."). Because a
//                     deny line would fill fine in the confirm case, slot dropping alone cannot choose, so
//                     pickStockLine picks the confirm library when {players} resolves and the deny library
//                     when it does not; pickRumorLine(branch, …) chooses explicitly. The confirm branch is
//                     behind the commissioner's leaks toggle (D-A's gate).
//   roster_note (Nina) team, position, benchCount — or, for an Active player parked on IR: team, player, status.
//                     pickStockLine picks the bench library when {benchCount} resolves, the IR library otherwise.
//   faab_watch (Nina)  team, faabLeft ("$7"), weeksLeft ("7")
//   sam_question, manager_post, manager_reply, writer_reply: no stock lines — pickStockLine returns null.
//
// Live game engine (spec §19), from the per-league fantasy pull while games are on:
//   matchup_live (Curtis) team (the LEADER right now), opponentTeam, score, opponentScore, margin?, week?
//                     One library reads for a lead change, a blowout and a comeback alike: every lead
//                     sentence says who leads and by what score, never who won — nothing is final.
//                     {margin} and {week} sit in their own sentences and drop when absent.
//   monday_needs (Nina) team (the trailing team), points (the DEFICIT), players (the Monday-night
//                     players, "A and B"), opponentTeam?, week?  — the gap and the names, factual;
//                     never a grade on the lineup (§16).
//
// Pure: imports the contract, fill.ts, language.ts and persona-prompts.ts only.

import { countProfanity, type LanguageRating } from "../language";
import { effectiveLanguageRange, fnv1a, personaPrompts } from "../persona-prompts";
import { fillVariant, isSlotToken, splitTemplateSentences, templateTokens } from "./fill";
import type { LeagueEventKind, SlotToken, StockLine, WireEventKind, WirePersona, WireSlots, WireTag } from "./types";

const REPORTED: WireTag[] = ["REPORTED"];
const FINAL: WireTag[] = ["FINAL"];
/** The live desk (spec §19): the matchup is still being played. */
const LIVE: WireTag[] = ["LIVE"];
/** A manager said it on the wire (STATED) and the log answered (REPORTED): rumor_check. */
const STATED_REPORTED: WireTag[] = ["STATED", "REPORTED"];

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
 * Dex Desk (spec §18) — league activity off the transaction log. Same phone hit, more kinds.
 * ------------------------------------------------------------------------------------------- */

const DEX_LINEUP_MOVE: StockLine[] = [
  clean("REPORTED: {player} in at {slot} for {team}. {benched} to the bench. Filed.", REPORTED),
  clean("Lineup change. {team}: {player} into {slot}. {benched} sits. Week {week}. Stand by.", REPORTED),
  clean("Here's what I've got. {team} moved {player} into {slot}. {benched} out of the lineup. Back to you.", REPORTED),
  clean("{manager} made a lineup move: {player} starts at {slot} for {team}. {benched} goes to the bench. Filed.", REPORTED),
  clean("REPORTED: {team} starts {player} at {slot}. Week {week}. Checked twice. Phone works.", REPORTED),
  clean("{team}: {player} in at {slot}. A lineup call is not a transaction, but this desk logs it anyway. More when I have it.", REPORTED),
  clean("Lineup desk. {player} to {slot}, {team}. {benched} to the bench. Two lines, one move. Stand by.", REPORTED),
  clean("{manager} of {team} moved {player} into {slot}. Filed. Sam may have a question. Back to you.", REPORTED),
  clean("REPORTED: lineup change at {team}. {player}, {slot}. {benched} out. Week {week}. That's the wire.", REPORTED),
  clean("{team} set {player} at {slot} this week. {benched} sits. Noted. Filed.", REPORTED),
  clean("Roster move, not a transaction: {team} slots {player} at {slot}. It still goes on the wire. Stand by.", REPORTED),
  clean("{player} into {slot} for {team}. {benched} out. Nobody called to explain it, and nobody has to. Back to you.", REPORTED),
  clean("{team} starts {player} at {slot}. Week {week} lineup. Checked the log twice. Filed.", REPORTED),
  clean("{team}: {manager} moved {player} to {slot}. {benched} to the bench. Filed. Stand by.", REPORTED),
  salty("{team}: {player} in at {slot}, {benched} out. A lineup move is not a trade, but hell, it's activity. Filed.", REPORTED),
  unfiltered("{team} moved {player} into {slot}. {benched} sits. Somebody in this league touched a roster. Holy shit. Back to you.", REPORTED),
];

const DEX_LATE_SWAP: StockLine[] = [
  clean("REPORTED: {team} moved {player} into {slot} with {minutes} minutes to kickoff. {benched} sits. Filed. Stand by.", REPORTED),
  clean("Late swap. {team}: {player} in at {slot}, {minutes} minutes before kickoff. {benched} to the bench. Back to you.", REPORTED),
  clean("{minutes} minutes out, {team} changed a lineup: {player} at {slot}. {benched} out. That's the wire.", REPORTED),
  clean("Here's what I've got, and it's fresh: {player} into {slot} for {team}, {minutes} minutes before kickoff. Filed.", REPORTED),
  clean("REPORTED: late lineup change at {team}. {player}, {slot}, {minutes} minutes to go. {benched} sits. Stand by.", REPORTED),
  clean("{manager} of {team} moved {player} into {slot} with {minutes} minutes on the clock. Filed. More when I have it.", REPORTED),
  clean("Kickoff minus {minutes}: {team} starts {player} at {slot}. {benched} out. Checked twice. Back to you.", REPORTED),
  clean("Late swap, {team}. {player} in at {slot}. {benched} sits. {minutes} minutes before kickoff. Filed.", REPORTED),
  clean("REPORTED: {player} into {slot} for {team}, {minutes} minutes before the game. {benched} to the bench. Stand by.", REPORTED),
  clean("{team} beat the lock by {minutes} minutes: {player} at {slot}. {benched} out. That's the wire.", REPORTED),
  clean("Late change. {manager} put {player} at {slot} for {team} with {minutes} minutes left before kickoff. Filed.", REPORTED),
  clean("{minutes} minutes to kickoff and {team} moved {player} into {slot}. {benched} sits. Timestamped. Filed. Back to you.", REPORTED),
  clean("Fresh off the log: {team}, {player} to {slot}, {minutes} minutes before kickoff. More when I have it.", REPORTED),
  salty("{team} moved {player} into {slot}, {minutes} minutes to kickoff. {benched} sits. Late as hell, and it counts. Filed.", REPORTED),
  unfiltered("{minutes} minutes to kickoff. {team}: {player} in at {slot}, {benched} out. Fast as shit. Filed. Back to you.", REPORTED),
];

const DEX_READS_THE_WIRE: StockLine[] = [
  clean("{team} benched {player} {hoursAgo} after the {status} tag. Somebody reads the wire. Filed.", REPORTED),
  clean("REPORTED: {status} on {player}, then a bench move by {team} {hoursAgo} later. That is a reader. Stand by.", REPORTED),
  clean("{player}: {status}. {team}: benched him {hoursAgo} after it posted. The wire works. Back to you.", REPORTED),
  clean("Here's what I've got. The {status} tag on {player} went up; {hoursAgo} later {team} sat him. Somebody's phone buzzed. Filed.", REPORTED),
  clean("{manager} benched {player} {hoursAgo} after the {status} tag. Reads the wire, or knows somebody who does. Filed.", REPORTED),
  clean("REPORTED: {team} moved {player} to the bench, {hoursAgo} after his {status} tag. Quick. Stand by.", REPORTED),
  clean("{status} tag on {player}. Bench move by {team} {hoursAgo} later. Tag, move, timestamp. That's the wire.", REPORTED),
  clean("{team} read the {status} tag on {player} and acted inside {hoursAgo}. This desk notices when people notice. Back to you.", REPORTED),
  clean("Somebody reads the wire: {team} benched {player} {hoursAgo} after the {status} tag went up. Filed.", REPORTED),
  clean("{player} ({status}) to the bench at {team}, {hoursAgo} after the tag. Fast hands. More when I have it.", REPORTED),
  clean("Wire to bench in {hoursAgo}. {team}, {player}, {status}. Somebody is paying attention. Filed.", REPORTED),
  clean("REPORTED: {manager} benched {player} {hoursAgo} after ESPN tagged him {status}. Reads the wire. Stand by.", REPORTED),
  clean("The {status} tag on {player} was up for {hoursAgo} before {team} sat him. That is a response time. Back to you.", REPORTED),
  salty("{team} benched {player} {hoursAgo} after the {status} tag. Somebody reads the wire. Hell, somebody reads. Filed.", REPORTED),
  unfiltered("{status} tag on {player}, bench move by {team} {hoursAgo} later. Somebody reads the wire. No shit. Back to you.", REPORTED),
];

const DEX_TRADE_PROPOSAL: StockLine[] = [
  clean("REPORTED: a package involving {players} is in the system between {team} and {otherTeam}. Terms under review. Stand by.", REPORTED),
  clean("Proposal on the wire. {team} to {otherTeam}. Pieces: {players}. Not done, not dead. Terms under review.", REPORTED),
  clean("Here's what I've got: {manager} sent {otherTeam} a proposal. {players} in the package. Terms under review. More when I have it.", REPORTED),
  clean("REPORTED: {team} and {otherTeam} have a proposal open. Names in it: {players}. Nobody has signed. Back to you.", REPORTED),
  clean("Trade desk, live: a proposal from {team} to {otherTeam} is pending. {players} involved. Terms under review. Filed.", REPORTED),
  clean("Not a trade. A proposal. {team}, {otherTeam}, {players}. Pending. That's the wire.", REPORTED),
  clean("{manager} of {team} put a package in front of {otherTeam}. {players}. Terms under review; the answer is theirs. Stand by.", REPORTED),
  clean("REPORTED: pending proposal, {team} and {otherTeam}. Pieces: {players}. Whether it clears is above this desk. Filed.", REPORTED),
  clean("Something in the system between {team} and {otherTeam}: a proposal involving {players}. Terms under review. Back to you.", REPORTED),
  clean("The market has a pulse. Proposal pending: {team} to {otherTeam}, {players} in it. Not done until it's done. Stand by.", REPORTED),
  clean("Proposal filed by {team}. Recipient: {otherTeam}. Package: {players}. Terms under review. More when I have it.", REPORTED),
  clean("REPORTED: {players} named in a proposal between {team} and {otherTeam}. Terms under review. No verdict from this desk; it isn't done. Filed.", REPORTED),
  clean("{team} is talking to {otherTeam}. Not rumor: a proposal, in the system, {players} in it. Terms under review.", REPORTED),
  salty("{team} sent {otherTeam} a package with {players} in it. A live proposal, hell yes. Terms under review. Stand by.", REPORTED),
  unfiltered("Proposal pending: {team} to {otherTeam}, {players}. The market isn't dead after all. Holy shit. Terms under review.", REPORTED),
];

const DEX_TRADE_DECLINED: StockLine[] = [
  clean("REPORTED: the proposal between {team} and {otherTeam} is dead. {players} stay where they are. Filed.", REPORTED),
  clean("Dead deal. {team} declined {otherTeam}. Package was {players}. Back to the yard sale. Stand by.", REPORTED),
  clean("Declined. {team}, {otherTeam}. {players} not moving. That's the wire.", REPORTED),
  clean("{team} passed on {otherTeam}'s package. {players} stay put. Nobody called to explain it, and nobody has to. Filed.", REPORTED),
  clean("REPORTED: no deal. {team} and {otherTeam} are done talking, for now. {players} were the pieces. Back to you.", REPORTED),
  clean("Off the board. {team} killed the proposal with {otherTeam}. {players} unmoved. Filed.", REPORTED),
  clean("The proposal between {team} and {otherTeam} died in the system. {players} go nowhere. Checked twice. Stand by.", REPORTED),
  clean("{team} said no to {otherTeam}. It's in the log. {players} stay. More when I have it.", REPORTED),
  clean("REPORTED: declined. The package between {otherTeam} and {team} is dead. {players} were in it. Back to you.", REPORTED),
  clean("No trade. {team} and {otherTeam} had a proposal open; they don't now. {players} unmoved. Filed.", REPORTED),
  clean("No sale. {team} declined {otherTeam}. {players} stay home. That's the wire.", REPORTED),
  clean("REPORTED: {team} turned down {otherTeam}; {players} stay. My read, not reporting: somebody asked for a lot. Filed.", ["REPORTED", "OPINION"]),
  clean("Proposal, declined. {team}. {otherTeam}. One proposal, one no. {players} unmoved. Stand by.", REPORTED),
  salty("{team} declined {otherTeam}. {players} stay put. The trade market: dead as hell again. Checked twice.", REPORTED),
  unfiltered("Dead deal. {team} turned down {otherTeam}. {players} unmoved. Back to a market that does shit-all. Filed.", REPORTED),
];

// Leak policy (owner, spec §18): a count and a soft read on the heat. Never a team, a manager or a figure.
const DEX_CLAIMS_IN: StockLine[] = [
  clean("REPORTED: multiple teams targeting {player} ({pos}), {count} claims in, and {heat}. Names stay on this desk. Stand by.", REPORTED),
  clean("Claims desk. {player} has {count} teams on him this period, and {heat}. Who and how much: not until it processes. Filed.", REPORTED),
  clean("Multiple teams targeting {player}. Count: {count}. Read: {heat}. That's all you get until it clears. Back to you.", REPORTED),
  clean("REPORTED: {count} pending claims on {player} ({pos}), and {heat}. No names, no numbers; that's the policy. Stand by.", REPORTED),
  clean("{player} is the name on {count} pending claims, and {heat}. Who wins is the log's business until it clears. More when I have it.", REPORTED),
  clean("Here's what I've got: {count} teams in on {player}, and {heat}. Terms sealed until processing. Filed.", REPORTED),
  clean("Waiver watch: {player} ({pos}), {count} teams targeting. Read on the money: {heat}. Not naming anyone. Stand by.", REPORTED),
  clean("REPORTED: a contested claim. {player}, {count} teams, and {heat}. Names and bids stay sealed. Back to you.", REPORTED),
  clean("Wanted by {count} teams: {player}. Same period, same target, and {heat}. Whoever wins, the log will say so. Filed.", REPORTED),
  clean("Multiple teams targeting {player} ({pos}), with {count} in the queue, and {heat}. Processing decides it, not this desk. Stand by.", REPORTED),
  clean("Claim traffic on {player}: {count} teams, and {heat}. That's the whole leak, and it's all I'm allowed. More when I have it.", REPORTED),
  clean("REPORTED: {player} has {count} claims pending, and {heat}. Nobody's name goes out before it clears. That's the wire.", REPORTED),
  clean("{player} ({pos}): {count} teams targeting him this period, and {heat}. Filed under contested. Stand by.", REPORTED),
  salty("Claims on {player}: {count} teams, and {heat}. The claims desk is alive as hell for once. Names sealed. Filed.", REPORTED),
  unfiltered("Multiple teams targeting {player}, {count} of them, and {heat}. Who? Not a fucking chance before it processes. Back to you.", REPORTED),
];

const DEX_QUIET_DESK: StockLine[] = [
  clean("{team}: no proposals in {weeksSilent} weeks. Deadline is {deadline}. The phone works. I checked. Filed.", REPORTED),
  clean("Quiet desk. {team}: nothing filed in {weeksSilent} weeks, with the deadline {deadline}. Checked twice. Phone works.", REPORTED),
  clean("REPORTED: {weeksSilent} weeks without a trade proposal from {team}. Deadline: {deadline}. That is a finding, not a hole. Stand by.", REPORTED),
  clean("Here's what I've got on {team}: nothing. {weeksSilent} weeks of it. The deadline is {deadline}. Back to you.", REPORTED),
  clean("{team}: no proposal sent in {weeksSilent} weeks. Deadline {deadline}. A ghost town with a mailbox. Filed.", REPORTED),
  clean("Trade deadline {deadline}. Silent for {weeksSilent} weeks: {team}. Checked the log twice. Phone works. Stand by.", REPORTED),
  clean("{team}. {weeksSilent} weeks. Zero proposals. Deadline {deadline}. Four facts, no adjectives. Filed.", REPORTED),
  clean("REPORTED: the quietest corner of the market is {team}: {weeksSilent} weeks without a proposal, deadline {deadline}. Back to you.", REPORTED),
  clean("Deadline watch, {deadline}. {team}: {weeksSilent} weeks and not one proposal. The phone works. I checked. Filed.", REPORTED),
  clean("{team}: nothing proposed in {weeksSilent} weeks. {deadline} is the deadline. A yard sale nobody drove to. Stand by.", REPORTED),
  clean("No proposals from {team} in {weeksSilent} weeks. Deadline is {deadline}. Inactivity is a story; this is it. More when I have it.", REPORTED),
  clean("Quiet desk, {weeksSilent} weeks running: {team}. Deadline {deadline}. Noted. Filed.", REPORTED),
  clean("REPORTED: {team} sent no proposals in {weeksSilent} weeks. Deadline {deadline}. The log is empty and the phone works. That's the wire.", REPORTED),
  salty("{team}: {weeksSilent} weeks, no proposals, deadline {deadline}. Dead as hell. Checked twice. Phone works.", REPORTED),
  unfiltered("{team}: no proposals in {weeksSilent} weeks. Deadline {deadline}. Phone works. Nobody gives a shit. That's the wire.", REPORTED),
];

// One fact per sentence: a league without FAAB loses the bid and balance sentences and nothing else.
const DEX_WEEKLY_RUNDOWN: StockLine[] = [
  clean("Week {week} rundown. {adds} adds. {drops} drops. {claims} claims processed. Top claim: {topPlayer}. Winning bid: {topBid}. FAAB leader: {faabLeader}. Balance there: {faabLeft}. That's the wire.", REPORTED),
  clean("Here's what I've got for Week {week}. Adds: {adds}. Drops: {drops}. Claims cleared: {claims}. Biggest claim: {topPlayer}. Price: {topBid}. Most FAAB left: {faabLeader}. Their balance: {faabLeft}. Back to you.", REPORTED),
  clean("Transactions desk, Week {week}. {adds} players added. {drops} dropped. {claims} claims processed. {topPlayer} was the top claim. It cost {topBid}. {faabLeader} leads the FAAB table. They sit on {faabLeft}. Filed.", REPORTED),
  clean("Week {week} on the wire: {adds} adds and {drops} drops. {claims} claims went through. {topPlayer} drew the top bid. The bid was {topBid}. {faabLeader} has the deepest pockets. {faabLeft} in that account. Stand by.", REPORTED),
  clean("REPORTED, Week {week}: {adds} adds. {drops} drops. {claims} claims. Top of the board: {topPlayer}. Top bid: {topBid}. Deepest pockets: {faabLeader}. Balance: {faabLeft}. More when I have it.", REPORTED),
  clean("The week in moves. Adds, {adds}. Drops, {drops}. Claims processed, {claims}. Top claim, {topPlayer}. Top bid, {topBid}. FAAB leader, {faabLeader}. FAAB balance there, {faabLeft}. Week {week}. Filed.", REPORTED),
  clean("Week {week}, by the numbers. {adds} adds. {drops} drops. {claims} claims cleared. Top claim: {topPlayer}. He cost {topBid}. FAAB leader: {faabLeader}. Their balance: {faabLeft}. Back to you.", REPORTED),
  clean("Rundown, Week {week}. Adds {adds}. Drops {drops}. Claims processed {claims}. Top claim {topPlayer}. Winning bid {topBid}. FAAB leader {faabLeader}. Left there: {faabLeft}. That's the wire.", REPORTED),
  clean("Week {week} log. {adds} in. {drops} out. {claims} claims processed. {topPlayer} went at the top of the week. Price: {topBid}. {faabLeader} leads FAAB. {faabLeft} left. Checked twice. Filed.", REPORTED),
  clean("Wednesday desk, Week {week}. {adds} adds, {drops} drops, {claims} claims. Top claim: {topPlayer}. Bid: {topBid}. FAAB leader: {faabLeader}. Balance: {faabLeft}. Stand by.", REPORTED),
  clean("Moves this week: {adds} adds, {drops} drops. Claims processed: {claims}. Priciest claim: {topPlayer}. Price: {topBid}. Richest desk: {faabLeader}. Balance: {faabLeft}. Week {week}. Back to you.", REPORTED),
  clean("Week {week} is filed. {adds} adds. {drops} drops. {claims} claims. Claim of the week: {topPlayer}. It went for {topBid}. FAAB leader: {faabLeader}. {faabLeft} still there. More when I have it.", REPORTED),
  clean("REPORTED: Week {week} transactions. Adds {adds}. Drops {drops}. Claims {claims}. Top claim {topPlayer}. Top bid {topBid}. FAAB leader {faabLeader}. Balance {faabLeft}. That's the wire.", REPORTED),
  salty("Week {week} rundown. {adds} adds. {drops} drops. {claims} claims processed. Top claim: {topPlayer}. Bid: {topBid}. FAAB leader: {faabLeader}. Balance: {faabLeft}. Hell of a log. Filed.", REPORTED),
  unfiltered("Week {week}: {adds} adds, {drops} drops, {claims} claims. Top claim: {topPlayer}. Bid: {topBid}. FAAB leader: {faabLeader}. Balance: {faabLeft}. Every line real, no shit. Filed.", REPORTED),
];

const DEX_STREAMING_CHURN: StockLine[] = [
  clean("{team} is on {unit} number {count} in five weeks. {player} this time. Filed.", REPORTED),
  clean("REPORTED: {team} added {player}. That's the {streak}. Streaming, by the log's count. Stand by.", REPORTED),
  clean("Streaming desk. {team}: {unit} add number {count} in five weeks. Latest: {player}. Checked twice. Back to you.", REPORTED),
  clean("{team} picked up {player}, making {count} different {unit} adds in five weeks. The {unit} slot has a turnstile. Filed.", REPORTED),
  clean("REPORTED: {player} is {team}'s {unit} this week. The {streak}. More when I have it.", REPORTED),
  clean("Here's what I've got: {team}, {unit}, {count} adds in five weeks. This week's name is {player}. Stand by.", REPORTED),
  clean("{team} keeps the {unit} slot warm for whoever's next. {player} now; {count} names in five weeks. Filed.", REPORTED),
  clean("Churn report. {team}: {count} {unit} adds in five weeks, {player} the latest. Every one of them in the log. Back to you.", REPORTED),
  clean("{player} to {team}. The {streak}. Noted. Filed.", REPORTED),
  clean("REPORTED: {team} added a {unit} again. {player}, number {count} in five weeks. The log counts; I read it. Stand by.", REPORTED),
  clean("{team}: {count} {unit} adds in five weeks. This one is {player}. Streaming, by the log's count. That's the wire.", REPORTED),
  clean("Weekly {unit} for {team}: {player}. Number {count} in five weeks. Somebody has a schedule taped to the fridge. Filed.", REPORTED),
  clean("{team} is on {unit} number {count} in five weeks: {player}. Checked twice. Back to you.", REPORTED),
  salty("{team} added {player}. {unit} number {count} in five weeks. More turnover than the trade market, which, hell, isn't hard. Filed.", REPORTED),
  unfiltered("{team}: {unit} number {count} in five weeks. {player} this time. Shit, that's a turnstile. Filed.", REPORTED),
];

// Factual, at most a dry tag. Spec §16: starting a tagged player is never called mismanagement here.
const DEX_LINEUP_LOCK: StockLine[] = [
  clean("{team} kicked off with {player} ({status}) in the lineup. Filed.", REPORTED),
  clean("REPORTED: at kickoff, {player} was in {team}'s lineup, tagged {status}. That's the log. Stand by.", REPORTED),
  clean("Lineup locked. {team}: {player}, {status}, starting. Noted. Back to you.", REPORTED),
  clean("{player} ({status}) started for {team} at kickoff. Filed. More when I have it.", REPORTED),
  clean("REPORTED: {team} locked in {player} with the {status} tag on him. Kickoff came; the lineup stayed. Filed.", REPORTED),
  clean("Kickoff. {team} has {player} in the lineup; ESPN has him {status}. Both true. Stand by.", REPORTED),
  clean("{manager} kicked off with {player} ({status}) in the starting lineup. The log says so; I say so. Filed.", REPORTED),
  clean("Lock report: {team}, {player}, {status}, starting. Four facts. That's the wire.", REPORTED),
  clean("REPORTED: {player} carried the {status} tag into kickoff as a starter for {team}. Filed. Back to you.", REPORTED),
  clean("At the lock, {team} had {player} starting. Tag on him: {status}. Read once, flat. Stand by.", REPORTED),
  clean("{team} started {player}. Status at kickoff: {status}. That is the whole hit. Filed.", REPORTED),
  clean("Locked and logged: {player} ({status}) in {team}'s starting lineup at kickoff. More when I have it.", REPORTED),
  clean("{manager} of {team}: {player} started, tagged {status}. Why is not my desk. Filed.", REPORTED),
  salty("{team} kicked off with {player} ({status}) in the lineup. Hell of a tag to carry into a start. Filed.", REPORTED),
  unfiltered("Kickoff: {player}, {status}, starting for {team}. The log doesn't grade and neither do I. Shit happens at the lock. Filed.", REPORTED),
];

// rumor_check, confirm branch: a proposal exists. Every line carries {players}; terms stay under review.
const DEX_RUMOR_CONFIRM: StockLine[] = [
  clean("STATED by {manager}. There is a proposal in the system involving {players}. Terms under review. Stand by.", STATED_REPORTED),
  clean("{manager} put it on the wire; the log backs it. A proposal involving {players} is pending. Terms under review. Filed.", STATED_REPORTED),
  clean("STATED by {manager}, checked by this desk: yes. A proposal involving {players} is in the system. Terms under review. Back to you.", STATED_REPORTED),
  clean("Rumor check: a proposal involving {players} is in the system. STATED by {manager}; REPORTED by the log. Terms under review. Stand by.", STATED_REPORTED),
  clean("{manager} said it on the wire, and the log agrees: {players} are in a pending proposal. Terms under review. Filed.", STATED_REPORTED),
  clean("REPORTED: a proposal involving {players} is pending, and {manager} said as much on the wire. Terms under review. Back to you.", STATED_REPORTED),
  clean("Checked the system for {manager}: there is a proposal involving {players}. Terms under review. Not done until it's done. Stand by.", STATED_REPORTED),
  clean("Rumor check, {players}: real. A proposal is in the system, as {manager} said. Terms under review. More when I have it.", STATED_REPORTED),
  clean("Proposal pending involving {players}, as {manager} said on the record. Terms under review. Filed.", STATED_REPORTED),
  clean("REPORTED: {players} are named in a live proposal, which is what {manager} said. Terms under review. That's the wire.", STATED_REPORTED),
  clean("There is a proposal in the system involving {players}. {manager} had it right. Terms under review. Stand by.", STATED_REPORTED),
  clean("Rumor check: {players}, pending proposal, in the system. {manager} said it; the log confirms it. Terms under review. Back to you.", STATED_REPORTED),
  salty("A proposal involving {players} is in the system, just like {manager} said. Hell, somebody's honest. Terms under review. Filed.", STATED_REPORTED),
  unfiltered("{players}: pending proposal, in the system, exactly as {manager} put it. No shit. Terms under review. Stand by.", STATED_REPORTED),
];

// rumor_check, deny branch: nothing in the system. No line carries {players}.
const DEX_RUMOR_DENY: StockLine[] = [
  clean("STATED by {manager}. Nothing in the system on {player}. Yet. Stand by.", STATED_REPORTED),
  clean("Rumor check on {player}: the log has nothing. {manager} said it; the system hasn't. Filed.", STATED_REPORTED),
  clean("{manager} put {player}'s name on the wire. I checked the system twice. No proposal. Not yet. Back to you.", STATED_REPORTED),
  clean("STATED by {manager}: talk about {player}. REPORTED: no proposal in the system. Talk is free; proposals get logged. Stand by.", STATED_REPORTED),
  clean("Nothing pending on {player}. {manager} may know something the log doesn't; the log is what I print. Filed.", STATED_REPORTED),
  clean("Checked for {manager}: no proposal involving {player} in the system. If that changes, I'll have it. Stand by.", STATED_REPORTED),
  clean("Rumor check: {player}. Result: nothing filed, nothing pending. {manager} said it on the wire; the log says nothing back. More when I have it.", STATED_REPORTED),
  clean("STATED by {manager}. This desk: no proposal on {player}. Yet. The word 'yet' is doing honest work. Back to you.", STATED_REPORTED),
  clean("{player} rumor, per {manager}. Log: empty. That is not a denial; that is an empty log. Filed.", STATED_REPORTED),
  clean("No proposal in the system on {player}. {manager} said the word; the paperwork hasn't. Stand by.", STATED_REPORTED),
  clean("Rumor check, {player}: nothing in the system. {manager} is on the record; the log is not. Yet. That's the wire.", STATED_REPORTED),
  clean("{manager} says {player}. The system says nothing. When it says something, so will I. Filed.", STATED_REPORTED),
  salty("Nothing in the system on {player}, whatever {manager} heard. Rumor is hell on a desk that only prints the log. Stand by.", STATED_REPORTED),
  unfiltered("{manager} says {player}. The system says nothing. Rumors don't file paperwork, and this desk doesn't print shit that didn't. Yet. Filed.", STATED_REPORTED),
];

const DEX_RUMOR_CHECK: StockLine[] = [...DEX_RUMOR_CONFIRM, ...DEX_RUMOR_DENY];

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

// matchup_live (spec §19): {team} leads right now. A lead, never a result — the clock is running.
const CURTIS_MATCHUP_LIVE: StockLine[] = [
  clean("{team} has the lead on {opponentTeam}, {score} to {opponentScore}. Let's go to the board.", LIVE),
  clean("Good evening. Live board: {team} {score}, {opponentTeam} {opponentScore}. Margin, {margin}. Stay with us.", LIVE),
  clean("For those keeping score at home, and it is still being kept: {team} {score}, {opponentTeam} {opponentScore}. Not a final.", LIVE),
  clean("{team} leads {opponentTeam} by {margin}. The board is live, and so is everybody's phone. We'll leave that there.", LIVE),
  clean("Live from the desk: {team} {score}, {opponentTeam} {opponentScore}. Week {week}, still in progress. Nina is watching the bench math.", LIVE),
  clean("The board has moved. {team} now leads {opponentTeam}, {score} to {opponentScore}. Do with that what you will.", LIVE),
  clean("{team} on top of {opponentTeam}, {score} to {opponentScore}, with football still being played. That is an update, not a result.", LIVE),
  clean("In a development this desk will read once, flat: {team} {score}, {opponentTeam} {opponentScore}. Live. Stay with us.", LIVE),
  clean("Scoreboard, live: {team} ahead of {opponentTeam} by {margin}. Reggie is standing. Reggie is always standing.", LIVE),
  clean("{team} {score}. {opponentTeam} {opponentScore}. Margin {margin}. Players still on the field. We'll have more on that after the break.", LIVE),
  clean("Update from the board: {team} leads {opponentTeam}, {score} to {opponentScore}. Week {week} is not done with either of them.", LIVE),
  clean("{team} has pulled ahead of {opponentTeam}. Score {score} to {opponentScore}. Dex is working the phones on who is still to play.", LIVE),
  clean("Live look-in, Week {week}: {team} {score}, {opponentTeam} {opponentScore}. That's the weather. Now the board.", LIVE),
  clean("The desk can confirm a lead, not a result: {team} over {opponentTeam}, {score} to {opponentScore}. Stay with us.", LIVE),
  clean("{team} by {margin} over {opponentTeam}, and the clock is still running. Read once, flat. This is FFSN.", LIVE),
  clean("Top of the hour: {team} leads {opponentTeam}, {score} to {opponentScore}. Walt has a metaphor ready. Walt is on hold.", LIVE),
  clean("{team} {score}, {opponentTeam} {opponentScore}, live. The margin is {margin}. The board does not editorialise; neither do I.", LIVE),
  clean("The lead belongs to {team}: {score} to {opponentScore} over {opponentTeam}. Belongs, present tense. Stay with us.", LIVE),
  salty("{team} leads {opponentTeam}, {score} to {opponentScore}, and it is not over. Well, hell. Let's go to the board.", LIVE),
  unfiltered("{team} {score}, {opponentTeam} {opponentScore}. Live, not final, and somebody on this set already said bullshit. We'll be right back.", LIVE),
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

// roster_note (Nina), bench branch: a hoard at one position.
const NINA_ROSTER_BENCH: StockLine[] = [
  clean("Class. {team} has {benchCount} {position}s on the bench. That is not depth, that is a hoard."),
  clean("Pop quiz: how many {position}s does one bench need? {team} answered {benchCount}. Wrong, but confidently. That's the segment."),
  clean("Circle this column: bench {position}s. {team}: {benchCount}. Everyone look at the board. That is a shelf, not a bench."),
  clean("{team} is carrying {benchCount} {position}s on the bench. Sample size: one roster. I'm holding it loosely. I am also still right."),
  clean("Everyone look at {team}'s bench. {benchCount} {position}s. A lineup starts a few of those. A bench stores the rest. This is storage."),
  clean("{benchCount} {position}s on {team}'s bench. Was it a plan? Show your work. The column says collection, not plan."),
  clean("Roster note. {team}, {position}, {benchCount} on the bench. Depth is a number with a purpose. This number has a hobby. That's the segment."),
  clean("Class. {team} rosters {benchCount} bench {position}s. One roster, one column, one raised eyebrow. Circle it."),
  clean("Partial credit for {team}'s depth at {position}. None for the {benchCount} of it sitting down. Grade posted."),
  clean("{team}: {benchCount} {position}s, none of them starting. The story says insurance. The column says {benchCount}. I trust the column."),
  clean("Show your work, {team}: {benchCount} {position}s on the bench. That is a position group, not a bench slot. That's the segment."),
  clean("Everyone look at the board. Bench {position}s, {team}: {benchCount}. Reggie would call that a squad. I call it a column that needs trimming."),
  salty("{team} has {benchCount} {position}s on the bench. Hell of a collection. A collection is not depth. That's the segment."),
  unfiltered("{benchCount} {position}s on {team}'s bench. That is, and I am using the technical term, a fucking hoard. Moving on."),
];

// roster_note (Nina), IR branch: an Active player parked in an IR slot for two weeks or more.
const NINA_ROSTER_IR: StockLine[] = [
  clean("Class. {team} has {player} parked in an IR slot while ESPN lists him {status}. Circle that column. The slot is for injuries."),
  clean("Pop quiz: what does IR stand for? {team} has {player} in that slot, status {status}. Show your work. That's the segment."),
  clean("{player} is {status} and sitting in {team}'s IR slot. Weeks, plural. That is a column with a clerical error in it."),
  clean("Roster note, {team}: {player} in the IR slot, listed {status}. The slot has a name. The name is a hint. That's the segment."),
  clean("Everyone look at {team}'s IR slot. {player}. Status: {status}. One of those words is wrong, and it isn't the status."),
];

const NINA_ROSTER_NOTE: StockLine[] = [...NINA_ROSTER_BENCH, ...NINA_ROSTER_IR];

const NINA_FAAB_WATCH: StockLine[] = [
  clean("Class. {team} has {faabLeft} of FAAB left with {weeksLeft} weeks to play. Two numbers, one caveat: the caveat is the second number. That's the segment."),
  clean("Circle this column: FAAB remaining. {team}, {faabLeft}. Weeks remaining: {weeksLeft}. Neither of those numbers goes up."),
  clean("{team}: {faabLeft} left, {weeksLeft} weeks left. Pop quiz: which runs out first? Show your work. That's the segment."),
  clean("FAAB watch. {team} is down to {faabLeft} with {weeksLeft} weeks on the schedule. Caveat: free agents are still free. That's the segment."),
  clean("Everyone look at the board. {team}, FAAB: {faabLeft}. Weeks: {weeksLeft}. The budget was for a season. The season is still going."),
  clean("{faabLeft}. That is {team}'s FAAB balance, and {weeksLeft} weeks remain. I am not projecting anything; I am reading a column. That's the segment."),
  clean("Class, a budgeting lesson. {team}: {faabLeft} in the account, {weeksLeft} weeks to go. Caveat: the account does not refill. Circle it."),
  clean("FAAB remaining, {team}: {faabLeft}. Weeks remaining: {weeksLeft}. Was it worth it? I'll grade that in {weeksLeft} weeks. Show your work until then."),
  clean("{team} has {faabLeft} left for {weeksLeft} weeks. The story says aggressive. The column says {faabLeft}. Only one of them has a dollar sign."),
  clean("Pop quiz: {faabLeft} divided by {weeksLeft} weeks. {team} will be doing that math every waiver run. I did it on the board. That's the segment."),
  clean("Roster note from the numbers desk: {team} is at {faabLeft} of FAAB with {weeksLeft} weeks left. One caveat: it only matters if someone gets hurt. Someone gets hurt. That's the segment."),
  clean("{team}: {faabLeft} FAAB, {weeksLeft} weeks. Hold it loosely; a budget is not a result. I am holding it loosely. I am also still right."),
  clean("Circle the FAAB column. {team}, {faabLeft}, with {weeksLeft} weeks to go. Not supported: \"we'll be fine.\" The column doesn't do fine. That's the segment."),
  salty("{team} has {faabLeft} of FAAB and {weeksLeft} weeks left. Hell of a column. Circle it, then hold it loosely."),
  unfiltered("{faabLeft} of FAAB, {weeksLeft} weeks to go. {team}. That is, and I am using the technical term, a fucking budget problem. Moving on."),
];

// monday_needs (spec §19): {team} trails by {points} with {players} still to play. The gap and the
// names. Never a grade on the lineup that got them here (§16).
const NINA_MONDAY_NEEDS: StockLine[] = [
  clean("Class. {team} needs {points} from {players} on Monday night. Show your work.", LIVE),
  clean("Monday math. {team} trails {opponentTeam} by {points}. Left to play: {players}. Circle that column.", LIVE),
  clean("Pop quiz: can {players} produce {points}? {team} needs the answer by Monday night. That's the segment.", LIVE),
  clean("{team}: down {points} to {opponentTeam}, with {players} still to play. Two numbers, one caveat. The caveat is Monday.", LIVE),
  clean("Everyone look at the board. {team} needs {points}. The only names left on it: {players}. That's the segment.", LIVE),
  clean("Week {week}, Monday night. {team} needs {points} from {players}. Sample size: one game. I'm holding it loosely.", LIVE),
  clean("Circle this column: {points}. That is the gap between {team} and {opponentTeam}, and {players} are the only ones who can close it.", LIVE),
  clean("{team} still has {players} to play and needs {points} out of them. Not supported: \"it's over.\" Also not supported: \"it's fine.\"", LIVE),
  clean("The deficit is {points}. The Monday players are {players}. {team} does the rest of the math tomorrow. That's the segment.", LIVE),
  clean("Class, a Monday problem. {team} needs {points}. {players} on the board. Show your work; the board will.", LIVE),
  clean("{team} trails {opponentTeam} by {points}. Monday night: {players}. I am not projecting; I am reading a column.", LIVE),
  clean("Homework for Monday. {team}, down {points}. Left to play: {players}. Grade posted Tuesday morning.", LIVE),
  clean("Numbers desk, Sunday night: {team} needs {points} from {players}. One game left. Hold it loosely; that number does not.", LIVE),
  clean("{points}. That is what {team} needs on Monday night, and {players} are the ones who have to find it. Circle it.", LIVE),
  salty("{team} needs {points} from {players} on Monday night. Hell of a column to sleep on. That's the segment.", LIVE),
  unfiltered("{team}, down {points} to {opponentTeam}, with {players} left. That is, and I am using the technical term, a fucking Monday. Moving on.", LIVE),
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
    // Dex Desk (spec §18)
    lineup_move: DEX_LINEUP_MOVE,
    late_swap: DEX_LATE_SWAP,
    reads_the_wire: DEX_READS_THE_WIRE,
    trade_proposal: DEX_TRADE_PROPOSAL,
    trade_declined: DEX_TRADE_DECLINED,
    claims_in: DEX_CLAIMS_IN,
    quiet_desk: DEX_QUIET_DESK,
    weekly_rundown: DEX_WEEKLY_RUNDOWN,
    streaming_churn: DEX_STREAMING_CHURN,
    lineup_lock: DEX_LINEUP_LOCK,
    rumor_check: DEX_RUMOR_CHECK,
  },
  "curtis-vaughn": {
    week_final: CURTIS_WEEK_FINAL,
    game_of_week: CURTIS_GAME_OF_WEEK,
    streak: CURTIS_STREAK,
    article_published: CURTIS_ARTICLE,
    // Live game engine (spec §19)
    matchup_live: CURTIS_MATCHUP_LIVE,
  },
  "nina-sharpe": {
    bench_points: NINA_BENCH,
    claim_settled: NINA_CLAIM,
    article_published: NINA_ARTICLE,
    // Dex Desk (spec §18), Nina's two
    roster_note: NINA_ROSTER_NOTE,
    faab_watch: NINA_FAAB_WATCH,
    // Live game engine (spec §19)
    monday_needs: NINA_MONDAY_NEEDS,
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
    adp: "18.4",
    adpRank: "RB7",
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
    // Dex Desk (spec §18)
    slot: "FLEX",
    benched: "Chase Brown",
    minutes: "40",
    hoursAgo: "two hours",
    otherTeam: "Sable Ridge Sentinels",
    players: "Joe Burrow and Chase Brown",
    count: "three",
    heat: "the bidding looks high",
    weeksSilent: "6",
    deadline: "Tuesday, November 10",
    adds: "14",
    drops: "12",
    claims: "9",
    topPlayer: "Jake Browning",
    topBid: "$14",
    faabLeader: "Moisty Loins",
    faabLeft: "$61",
    weeksLeft: "7",
    unit: "D/ST",
    position: "WR",
    benchCount: "6",
    pct: "12%",
    direction: "dropped",
  };
  switch (kind) {
    case "low_score":
      return { ...base, team: "Moisty Loins", score: "61.4", margin: "48.2" };
    case "streak":
      return { ...base, streak: "W4" };
    case "claim_settled":
      return { ...base, writer: "Nina Sharpe", outcome: "hit" };
    case "reads_the_wire":
      return { ...base, status: "Questionable" };
    case "quiet_desk":
      return { ...base, team: "Kittle Me This, Moisty Loins and Sable Ridge Sentinels" };
    case "streaming_churn":
      return { ...base, player: "Bengals D/ST", pos: "D/ST", count: "four", streak: "fourth D/ST in five weeks" };
    case "roster_note":
      return { ...base, status: "Active" };
    case "faab_watch":
      return { ...base, faabLeft: "$7" };
    // Live game engine (spec §19)
    case "matchup_live":
      return { ...base, score: "98.4", opponentScore: "71.0", margin: "27.4" };
    case "monday_needs":
      return { ...base, points: "22.6", players: "Joe Burrow and Chase Brown" };
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

/** Kinds that never post a stock line: manager-authored posts, and Sam's question (a model call, spec §18). */
export const NO_STOCK_LINE_KINDS: ReadonlySet<string> = new Set(["manager_post", "manager_reply", "writer_reply", "sam_question"]);

function hasSlot(slots: WireSlots, token: SlotToken): boolean {
  return (slots[token] ?? "").trim().length > 0;
}

/** rumor_check's two libraries (spec §18): a proposal exists (confirm) or the system has nothing (deny). */
export type RumorBranch = "confirm" | "deny";
export const RUMOR_LINES: Record<RumorBranch, ReadonlyArray<StockLine>> = { confirm: DEX_RUMOR_CONFIRM, deny: DEX_RUMOR_DENY };

/** The branch the slots imply: `{players}` is passed only when a proposal exists. */
export function rumorBranchFor(slots: WireSlots): RumorBranch {
  return hasSlot(slots, "players") ? "confirm" : "deny";
}

/**
 * The lines a persona × kind draws from for these slots. Two kinds hold two libraries that must not
 * mix — a deny line would fill perfectly in the confirm case and state the opposite of the log — so
 * the slots choose: rumor_check by `{players}`, roster_note by `{benchCount}` (bench hoard) versus the
 * IR branch (an Active player parked on IR).
 */
function linePool(persona: WirePersona, kind: LeagueEventKind, slots: WireSlots): ReadonlyArray<StockLine> | undefined {
  if (persona === "dex-alvarez" && kind === "rumor_check") return RUMOR_LINES[rumorBranchFor(slots)];
  if (persona === "nina-sharpe" && kind === "roster_note") return hasSlot(slots, "benchCount") ? NINA_ROSTER_BENCH : NINA_ROSTER_IR;
  return STOCK_LINES[persona][kind];
}

/**
 * The shared picker: candidates allowed at `rating` are walked in fnv1a(seed) order so the same
 * seed always yields the same line and neighbouring seeds differ. A line that fills completely is
 * preferred; failing that, one whose lead sentence resolves (so a post never opens on a leftover
 * fragment like "Cleared. Filed.").
 */
function pickFrom(
  lines: ReadonlyArray<StockLine>,
  persona: WirePersona,
  slots: WireSlots,
  seed: string,
  rating: LanguageRating
): { text: string; tags: WireTag[] } | null {
  const candidates = lines.filter(line => lineAllowed(line, persona, rating, seed));
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

/**
 * A filled stock line for `persona` × `kind`, or `null` when the persona or kind is unknown, the
 * kind never posts a stock line (NO_STOCK_LINE_KINDS), no line is allowed at `rating`, or no
 * candidate fills with these slots. See {@link linePool} for the two kinds whose slots pick a branch.
 */
export function pickStockLine(
  persona: string,
  kind: LeagueEventKind,
  slots: WireSlots,
  seed: string,
  rating: LanguageRating
): { text: string; tags: WireTag[] } | null {
  if (NO_STOCK_LINE_KINDS.has(kind)) return null;
  if (!(persona in STOCK_LINES)) return null;
  const slug = persona as WirePersona;
  const lines = linePool(slug, kind, slots);
  if (!lines || lines.length === 0) return null;
  return pickFrom(lines, slug, slots, seed, rating);
}

/**
 * rumor_check with the branch chosen by the caller rather than inferred from `{players}`. The
 * confirm branch needs `{players}`: without them a confirm line would degrade to "STATED by X.
 * Terms under review." — a post that states nothing — so it returns null instead.
 */
export function pickRumorLine(branch: RumorBranch, slots: WireSlots, seed: string, rating: LanguageRating): { text: string; tags: WireTag[] } | null {
  if (branch === "confirm" && !hasSlot(slots, "players")) return null;
  return pickFrom(RUMOR_LINES[branch], "dex-alvarez", slots, seed, rating);
}
