/**
 * Print how a fixture resolves into a FACTS block: team ids, standings resolution, matchup sides,
 * upcoming slate, quotes and the `missing` list. Use it before a live run to see what the writer
 * will actually be handed.
 *
 *   npx vite-node scripts/inspect-facts.ts <fixture.json> [contentType]
 */
import { readFileSync } from "node:fs";
import { buildFactsBlock } from "../src/lib/ai/facts";

const [, , path, contentType = "weekly_recap"] = process.argv;
if (!path) throw new Error("usage: inspect-facts.ts <fixture.json> [contentType]");
const fixture = JSON.parse(readFileSync(path, "utf8"));
const facts = buildFactsBlock({ ...fixture, contentType });

console.log(`FACTS for ${fixture.name} / ${contentType}`);
console.log(`teams (${facts.teams.length}):`, facts.teams.map(t => `${t.id}=${t.name} [${t.record}]${t.manager ? " " + t.manager : ""}`).join(" | "));
console.log(`standings (${facts.standings.length}):`, facts.standings.map(s => `${s.rank}. ${s.teamId} ${s.record}${s.pointsFor ? " " + s.pointsFor : ""}`).join(" | "));
console.log(`matchups (${facts.matchups.length}):`, facts.matchups.map(m => `${m.id} ${m.home.teamId} ${m.home.score} v ${m.away.teamId} ${m.away.score} players=${m.players.length}`).join(" | "));
console.log(`upcoming (${facts.upcoming.length}):`, facts.upcoming.map(u => `${u.id} ${u.home.teamId}(${u.home.record ?? "?"}) v ${u.away.teamId}(${u.away.record ?? "?"}) proj ${u.home.projected ?? "?"}-${u.away.projected ?? "?"}`).join(" | "));
console.log(`quotes (${facts.quotes.length}):`, facts.quotes.map(q => `${q.id} ${q.speaker}/${q.teamId}`).join(" | "));
console.log(`nonRespondents:`, facts.nonRespondents.map(n => `${n.speaker}/${n.teamId} ${n.status}`).join(" | "));
console.log(`draftPicks: ${facts.draftPicks?.length ?? 0} | transactions: ${facts.transactions.length} | trades: ${facts.trades.length}`);
console.log(`unresolved team refs (T?):`, JSON.stringify(facts).split('"T?"').length - 1);
console.log(`missing:`, facts.missing);
