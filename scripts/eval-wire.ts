/**
 * Wire eval harness (spec §11).
 *
 *   npm run eval:wire                                   # offline, no API key, no network
 *   npm run eval:wire -- --persona dex-alvarez          # offline; stock-line samples for one persona
 *   npm run eval:wire -- --limit 20                     # print more cards
 *   npm run eval:wire -- --live --persona dex-alvarez --limit 3
 *
 * The runner is `vite-node` (already a dependency via vitest) for the same reason as
 * eval-articles.ts: `src/lib/ai/*` imports types as values, which type stripping cannot erase.
 *
 * OFFLINE MODE (default) builds fact cards from the captured ESPN fixtures in tests/fixtures/wire
 * with the same parsing rules the Convex pollers use (src/lib/ai/wire/espn.ts: athlete id from
 * links[].href; an unknown previous status treats a non-Active entry as a change from Active and an
 * Active one as a note), validates every card, and prints interest, the plain card rendering, the
 * default overlay variants filled with sample slots, and one stock line per persona/kind. Any card
 * that fails to validate or render, or any variant that fails to fill, is a failure (exit 1).
 *
 * LIVE MODE (`--live`, needs ANTHROPIC_API_KEY — read from .env.local when the environment lacks
 * it) sends the top N cards to `generateWireTakes` as one persona and prints the raw takes, the
 * flags and the cost. Costs money (well under a cent for three cards); never part of `npm test`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderCard, validateFactCard } from "../src/lib/ai/wire/card";
import { injuryEntryToCard, newsArticleToCard, parseEspnInjuriesPayload, parseEspnNewsPayload } from "../src/lib/ai/wire/espn";
import { defaultVariants, fillVariant } from "../src/lib/ai/wire/fill";
import { scoreInterest } from "../src/lib/ai/wire/interest";
import { pickStockLine, sampleSlotsFor, stockLineCounts } from "../src/lib/ai/wire/stock-lines";
import { generateWireTakes, prepareWireTakeRequest, resolveWireRoute, type WireTakeInput } from "../src/lib/ai/wire/take";
import {
  CARD_MIN_INTEREST,
  MAX_POST_CHARS,
  TAKE_MIN_INTEREST,
  WIRE_PERSONA_FOR_KIND,
  type WireFactCard,
  type WirePersona,
} from "../src/lib/ai/wire/types";
import { verifyTake } from "../src/lib/ai/wire/verify";

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

interface Options {
  live: boolean;
  persona?: string;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { live: false, limit: 12 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      return next;
    };
    switch (arg) {
      case "--live":
        options.live = true;
        break;
      case "--persona":
        options.persona = value();
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value()) || 1);
        break;
      case "--help":
      case "-h":
        console.log(`Usage: npm run eval:wire [-- --live] [--persona <slug>] [--limit N]

  --live               Generate real takes for the top N cards (requires ANTHROPIC_API_KEY). Costs money.
  --persona <slug>     Offline: only this persona's stock lines. Live: the persona that writes the takes.
  --limit N            Cards to print offline (default 12) / cards to send live (default 3).`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const failures: string[] = [];

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/** Loads ANTHROPIC_API_KEY (and nothing else) from .env.local when the environment lacks it. */
function loadApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const raw = match[1].trim();
    const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (unquoted) {
      process.env.ANTHROPIC_API_KEY = unquoted;
      return unquoted;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Fixtures → cards                                                            */
/* -------------------------------------------------------------------------- */

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/wire");

function loadFixture(name: string): unknown {
  const file = path.join(FIXTURE_DIR, name);
  if (!existsSync(file)) {
    failures.push(`fixture missing: ${file}`);
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

interface EvalCard {
  label: string;
  card: WireFactCard;
  interest: number;
}

function buildCards(): EvalCard[] {
  const fetchedAt = Date.now();
  const out: EvalCard[] = [];

  const injuries = loadFixture("espn-injuries-sample.json");
  if (injuries !== undefined) {
    const entries = parseEspnInjuriesPayload(injuries);
    if (entries.length === 0) failures.push("injuries fixture parsed to zero entries");
    for (const { teamName, entry } of entries) {
      const raw = injuryEntryToCard(entry, { fetchedAt });
      try {
        const card = validateFactCard(raw);
        out.push({ label: `${teamName} · ${entry.athlete.name}`, card, interest: scoreInterest(card) });
      } catch (error) {
        failures.push(`injury card ${entry.id} (${entry.athlete.name}) failed validation: ${(error as Error).message}`);
      }
    }
  }

  const news = loadFixture("espn-news-sample.json");
  if (news !== undefined) {
    const articles = parseEspnNewsPayload(news);
    if (articles.length === 0) failures.push("news fixture parsed to zero articles");
    for (const article of articles) {
      const raw = newsArticleToCard(article, { fetchedAt });
      if (!raw) continue;
      try {
        const card = validateFactCard(raw);
        out.push({ label: `news · ${article.headline.slice(0, 50)}`, card, interest: scoreInterest(card) });
      } catch (error) {
        failures.push(`news card ${article.id} failed validation: ${(error as Error).message}`);
      }
    }
  }

  return out.sort((a, b) => b.interest - a.interest || a.label.localeCompare(b.label));
}

function tierFor(interest: number): string {
  if (interest >= TAKE_MIN_INTEREST) return "take";
  if (interest >= CARD_MIN_INTEREST) return "card";
  return "stored";
}

function slotsForCard(card: WireFactCard) {
  const player = card.players[0];
  return {
    ...sampleSlotsFor(card.kind),
    player: player.name,
    pos: player.position ?? "",
    nflTeam: player.nflTeam ?? card.nflTeam ?? "",
    status: card.statusTo ?? "",
    timetable: card.timetable ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* Offline                                                                     */
/* -------------------------------------------------------------------------- */

function runOffline(options: Options, cards: EvalCard[]): void {
  console.log(`The Wire — offline eval\n`);
  console.log(`${cards.length} cards from fixtures (route: ${JSON.stringify(resolveWireRoute())})`);

  const byKind = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const { card, interest } of cards) {
    byKind.set(card.kind, (byKind.get(card.kind) ?? 0) + 1);
    byTier.set(tierFor(interest), (byTier.get(tierFor(interest)) ?? 0) + 1);
  }
  console.log(`  by kind: ${[...byKind].map(([kind, n]) => `${kind} ${n}`).join(" · ")}`);
  console.log(`  by tier: ${[...byTier].map(([tier, n]) => `${tier} ${n}`).join(" · ")}\n`);

  for (const { card } of cards) {
    const render = renderCard(card);
    if (render.text.length > MAX_POST_CHARS) failures.push(`render over ${MAX_POST_CHARS}: ${render.text}`);
    if (render.text.includes("{")) failures.push(`render carries a brace: ${render.text}`);
    const variants = defaultVariants(card);
    for (const [name, template] of Object.entries(variants)) {
      const filled = fillVariant(template, slotsForCard(card));
      if (!filled.ok) failures.push(`${card.kind}/${name} did not fill for ${card.players[0].name}: unresolved ${filled.unresolved.join(",")}`);
    }
  }

  console.log(`Top ${Math.min(options.limit, cards.length)} cards by interest\n`);
  for (const { label, card, interest } of cards.slice(0, options.limit)) {
    const render = renderCard(card);
    const persona = WIRE_PERSONA_FOR_KIND[card.kind];
    console.log(`— ${label}`);
    console.log(`  kind ${card.kind} · interest ${interest} (${tierFor(interest)}) · persona ${persona}${card.timetable ? ` · timetable "${card.timetable}"` : ""}`);
    console.log(`  card [${render.tags.join(",")}] ${render.text}`);
    const variants = defaultVariants(card);
    for (const [name, template] of Object.entries(variants)) {
      const filled = fillVariant(template, slotsForCard(card));
      console.log(`  ${name.padEnd(9)} ${filled.ok ? filled.text : `(unfilled: ${filled.unresolved.join(",")})`}`);
    }
    console.log();
  }

  console.log("Stock lines\n");
  const counts = stockLineCounts().filter(row => !options.persona || row.persona === options.persona);
  for (const row of counts) {
    const slots = sampleSlotsFor(row.kind);
    const cleanPick = pickStockLine(row.persona, row.kind, slots, `eval:${row.persona}:${row.kind}:1`, "clean");
    if (!cleanPick) failures.push(`no clean stock line for ${row.persona}/${row.kind}`);
    let ratedPick: { text: string } | null = null;
    for (let seq = 0; seq < 60 && !ratedPick; seq++) {
      const pick = pickStockLine(row.persona, row.kind, slots, `eval:${row.persona}:${row.kind}:rated:${seq}`, "unfiltered");
      if (pick && pick.text !== cleanPick?.text && /\b(?:hell|damn|shit|fuck|bullshit|horseshit|shitty|ass)\b/i.test(pick.text)) ratedPick = pick;
    }
    console.log(`${row.persona.padEnd(14)} ${row.kind.padEnd(18)} ${String(row.total).padStart(2)} lines (${row.clean} clean, ${row.salty} salty, ${row.unfiltered} unfiltered)`);
    if (cleanPick) console.log(`  clean      [${cleanPick.tags.join(",")}] ${cleanPick.text}`);
    if (ratedPick) console.log(`  rated      ${ratedPick.text}`);
  }
  console.log();
}

/* -------------------------------------------------------------------------- */
/* Live                                                                        */
/* -------------------------------------------------------------------------- */

async function runLive(options: Options, cards: EvalCard[]): Promise<void> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    failures.push("--live needs ANTHROPIC_API_KEY in the environment or .env.local");
    return;
  }
  const limit = options.limit === 12 ? 3 : options.limit;
  const persona = (options.persona ?? "dex-alvarez") as WirePersona;
  const eligible = cards.filter(({ card }) => WIRE_PERSONA_FOR_KIND[card.kind] === persona || options.persona !== undefined);
  const chosen = (eligible.length > 0 ? eligible : cards).slice(0, limit);
  const inputs: WireTakeInput[] = chosen.map(({ card }, index) => ({ postId: `eval-${index + 1}`, card }));

  const prepared = prepareWireTakeRequest(inputs, persona);
  const systemChars = Array.isArray(prepared.params.system) ? prepared.params.system.map(block => block.text).join("").length : String(prepared.params.system ?? "").length;
  const userChars = typeof prepared.params.messages[0].content === "string" ? prepared.params.messages[0].content.length : 0;
  console.log(`The Wire — live eval · ${inputs.length} card(s) as ${persona} · ${prepared.route.model}/${prepared.route.effort} · system ${systemChars} chars · user ${userChars} chars · max_tokens ${prepared.params.max_tokens}\n`);

  const started = Date.now();
  const batch = await generateWireTakes(inputs, persona, apiKey);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  for (const result of batch.results) {
    const input = inputs.find(candidate => candidate.postId === result.postId);
    const label = chosen[inputs.indexOf(input!)]?.label ?? result.postId;
    console.log(`— ${result.postId} · ${label}`);
    if (input) console.log(`  card      ${renderCard(input.card).text}`);
    if (result.take) {
      console.log(`  global    [${result.take.tags.join(",")}] ${result.take.global}`);
      if (result.take.owner) console.log(`  owner     ${result.take.owner}`);
      if (result.take.opponent) console.log(`  opponent  ${result.take.opponent}`);
      if (result.take.freeAgent) console.log(`  freeAgent ${result.take.freeAgent}`);
      if (input) {
        const filled = Object.entries({ owner: result.take.owner, opponent: result.take.opponent, freeAgent: result.take.freeAgent })
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([name, template]) => {
            const fill = fillVariant(template, slotsForCard(input.card));
            return `${name}=${fill.ok ? `"${fill.text}"` : `unfilled(${fill.unresolved.join(",")})`}`;
          });
        if (filled.length > 0) console.log(`  filled    ${filled.join(" · ")}`);
        const recheck = verifyTake(result.take.global, input.card);
        if (!recheck.ok) failures.push(`${result.postId}: verifyTake disagrees after the fact: ${recheck.violations.join("; ")}`);
      }
    } else {
      console.log("  take      (none — fell back to the card)");
    }
    console.log(`  flags     ${result.flags.length > 0 ? result.flags.join(" | ") : "none"}`);
    console.log();
  }
  console.log(`cost $${batch.costUsd.toFixed(5)} · model ${batch.model} · effort ${batch.effort} · ${elapsed}s`);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cards = buildCards();
  if (options.live) await runLive(options, cards);
  else runOffline(options, cards);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach(failure => console.error(`  - ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log("\nAll wire eval checks passed.");
}

await main();
