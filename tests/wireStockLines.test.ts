import { describe, expect, it } from "vitest";
import { findRegisterLeaks } from "../src/lib/ai/fact-verifier";
import { countProfanity, STRONG_PROFANITY } from "../src/lib/ai/language";
import { personaPrompts, reservedDeskHasTheirOne } from "../src/lib/ai/persona-prompts";
import { fillVariant, templateTokens } from "../src/lib/ai/wire/fill";
import {
  NO_STOCK_LINE_KINDS,
  pickRumorLine,
  pickStockLine,
  RUMOR_LINES,
  rumorBranchFor,
  sampleSlotsFor,
  STOCK_LINES,
  stockLineCounts,
} from "../src/lib/ai/wire/stock-lines";
import {
  LEAGUE_EVENT_KINDS,
  MAX_POST_CHARS,
  SLOT_TOKENS,
  WIRE_TAGS,
  type LeagueEventKind,
  type StockLine,
  type WirePersona,
} from "../src/lib/ai/wire/types";

const RATINGS = ["clean", "salty", "unfiltered"] as const;

function everyLine(): Array<{ persona: WirePersona; kind: LeagueEventKind; line: StockLine; index: number }> {
  const out: Array<{ persona: WirePersona; kind: LeagueEventKind; line: StockLine; index: number }> = [];
  for (const [persona, kinds] of Object.entries(STOCK_LINES) as Array<[WirePersona, Partial<Record<LeagueEventKind, ReadonlyArray<StockLine>>>]>) {
    for (const [kind, lines] of Object.entries(kinds) as Array<[LeagueEventKind, ReadonlyArray<StockLine>]>) {
      lines.forEach((line, index) => out.push({ persona, kind, line, index }));
    }
  }
  return out;
}

describe("every stock line", () => {
  const lines = everyLine();

  it("exists (the library is not empty)", () => {
    expect(lines.length).toBeGreaterThan(150);
  });

  it("belongs to a live persona and a league kind, with a valid rating and valid tags", () => {
    for (const { persona, kind, line, index } of lines) {
      const label = `${persona}/${kind}[${index}]`;
      expect(personaPrompts[persona], label).toBeDefined();
      expect(LEAGUE_EVENT_KINDS, label).toContain(kind);
      expect(RATINGS, label).toContain(line.rating);
      for (const tag of line.tags ?? []) expect(WIRE_TAGS, label).toContain(tag);
    }
  });

  it("uses only SLOT_TOKENS and fills completely with the representative slots, under the post limit", () => {
    for (const { persona, kind, line, index } of lines) {
      const label = `${persona}/${kind}[${index}]: ${line.text}`;
      for (const token of templateTokens(line.text)) expect(SLOT_TOKENS, label).toContain(token);
      const filled = fillVariant(line.text, sampleSlotsFor(kind));
      expect(filled.ok, label).toBe(true);
      if (filled.ok) {
        expect(filled.dropped ?? [], label).toEqual([]);
        expect(filled.text.length, label).toBeLessThanOrEqual(MAX_POST_CHARS);
        expect(filled.text, label).not.toMatch(/\{[A-Za-z]+\}/);
      }
    }
  });

  it("carries no register leaks (field names, ids, timestamps, prompt jargon)", () => {
    for (const { persona, kind, line, index } of lines) {
      const blanked = line.text.replace(/\{[A-Za-z]+\}/g, "slot");
      expect(findRegisterLeaks(blanked), `${persona}/${kind}[${index}]: ${line.text}`).toEqual([]);
    }
  });

  it("respects the persona's language allowance: clean lines carry nothing, rated lines fit the ceiling", () => {
    for (const { persona, kind, line, index } of lines) {
      const label = `${persona}/${kind}[${index}]: ${line.text}`;
      const { mild, strong } = countProfanity(line.text);
      if (line.rating === "clean") {
        expect(mild + strong, label).toBe(0);
        continue;
      }
      const allowance = personaPrompts[persona].language.allowance[line.rating];
      expect(allowance, label).toBeGreaterThan(0);
      expect(mild + strong, label).toBeGreaterThan(0);
      expect(mild + strong, label).toBeLessThanOrEqual(allowance);
      if (line.rating === "salty") expect(strong, `${label} (strong word at salty)`).toBe(0);
    }
  });
});

describe("counts", () => {
  const counts = stockLineCounts();
  const count = (persona: WirePersona, kind: LeagueEventKind) => counts.find(row => row.persona === persona && row.kind === kind)?.total ?? 0;

  it("meets the P1 minimums", () => {
    for (const kind of ["waiver_processed", "add_drop", "trade"] as const) expect(count("dex-alvarez", kind), `dex/${kind}`).toBeGreaterThanOrEqual(20);
    for (const kind of ["week_final", "game_of_week", "streak"] as const) expect(count("curtis-vaughn", kind), `curtis/${kind}`).toBeGreaterThanOrEqual(20);
    expect(count("reggie-banks", "top_score")).toBeGreaterThanOrEqual(12);
    expect(count("walt-brennan", "low_score")).toBeGreaterThanOrEqual(12);
    expect(count("nina-sharpe", "bench_points")).toBeGreaterThanOrEqual(12);
    expect(count("nina-sharpe", "claim_settled")).toBeGreaterThanOrEqual(12);
    for (const persona of Object.keys(STOCK_LINES) as WirePersona[]) {
      expect(count(persona, "article_published"), `${persona}/article_published`).toBeGreaterThanOrEqual(8);
    }
  });

  it("covers all seven personas, with Mel and Sam on their byline only", () => {
    expect(Object.keys(STOCK_LINES).sort()).toEqual(
      ["curtis-vaughn", "dex-alvarez", "mel-diaper", "nina-sharpe", "reggie-banks", "sam-ortega", "walt-brennan"]
    );
    expect(Object.keys(STOCK_LINES["mel-diaper"])).toEqual(["article_published"]);
    expect(Object.keys(STOCK_LINES["sam-ortega"])).toEqual(["article_published"]);
  });
});

describe("pickStockLine", () => {
  const slots = sampleSlotsFor("waiver_processed");

  it("is deterministic for a seed and varies across seeds", () => {
    const a = pickStockLine("dex-alvarez", "waiver_processed", slots, "league1:4:waiver_processed:1", "clean");
    const b = pickStockLine("dex-alvarez", "waiver_processed", slots, "league1:4:waiver_processed:1", "clean");
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    const texts = new Set<string>();
    for (let seq = 0; seq < 12; seq++) {
      const pick = pickStockLine("dex-alvarez", "waiver_processed", slots, `league1:4:waiver_processed:${seq}`, "clean");
      expect(pick).not.toBeNull();
      if (pick) texts.add(pick.text);
    }
    expect(texts.size).toBeGreaterThan(3);
  });

  it("returns filled text with the line's tags", () => {
    const pick = pickStockLine("dex-alvarez", "waiver_processed", slots, "seed", "clean");
    expect(pick?.text).not.toMatch(/\{[A-Za-z]+\}/);
    expect(pick?.text.length ?? 0).toBeLessThanOrEqual(MAX_POST_CHARS);
    expect(pick?.tags).toEqual(["REPORTED"]);
  });

  it("is null for an unknown persona, an unknown kind, or a persona with no lines for the kind", () => {
    expect(pickStockLine("vinny-marinara", "waiver_processed", slots, "seed", "clean")).toBeNull();
    expect(pickStockLine("mel-diaper", "waiver_processed", slots, "seed", "clean")).toBeNull();
    expect(pickStockLine("dex-alvarez", "ir_move", slots, "seed", "clean")).toBeNull();
  });

  it("never returns profanity at clean, for any persona, kind or seed", () => {
    for (const { persona, kind } of stockLineCounts()) {
      for (let seq = 0; seq < 40; seq++) {
        const pick = pickStockLine(persona, kind, sampleSlotsFor(kind), `L:${seq}:${kind}`, "clean");
        expect(pick, `${persona}/${kind} seed ${seq}`).not.toBeNull();
        if (pick) expect(countProfanity(pick.text).words, `${persona}/${kind}: ${pick.text}`).toEqual([]);
      }
    }
  });

  it("never returns a strong word at salty", () => {
    for (const { persona, kind } of stockLineCounts()) {
      for (let seq = 0; seq < 40; seq++) {
        const pick = pickStockLine(persona, kind, sampleSlotsFor(kind), `L:${seq}:${kind}`, "salty");
        if (pick) expect(countProfanity(pick.text).strong, `${persona}/${kind}: ${pick.text}`).toBe(0);
      }
    }
  });

  it("lets a writer with a real floor (Reggie) swear at unfiltered on some seeds", () => {
    let strong = 0;
    for (let seq = 0; seq < 120; seq++) {
      const pick = pickStockLine("reggie-banks", "top_score", sampleSlotsFor("top_score"), `L:${seq}:top_score`, "unfiltered");
      if (pick && countProfanity(pick.text).strong > 0) strong++;
    }
    expect(strong).toBeGreaterThan(0);
  });

  it("rations the reserved desk's one to the seeds where articles would allow it", () => {
    const dex = personaPrompts["dex-alvarez"];
    for (let seq = 0; seq < 120; seq++) {
      const seed = `L:${seq}:trade`;
      const pick = pickStockLine("dex-alvarez", "trade", sampleSlotsFor("trade"), seed, "unfiltered");
      expect(pick).not.toBeNull();
      if (pick && !reservedDeskHasTheirOne(dex, "unfiltered", seed)) {
        expect(countProfanity(pick.text).words, `${seed}: ${pick.text}`).toEqual([]);
      }
    }
  });

  it("only ever returns a strong word from a line rated unfiltered", () => {
    for (const { persona, kind } of stockLineCounts()) {
      for (let seq = 0; seq < 40; seq++) {
        const pick = pickStockLine(persona, kind, sampleSlotsFor(kind), `L:${seq}:${kind}`, "unfiltered");
        if (!pick) continue;
        const hasStrong = STRONG_PROFANITY.some(word => new RegExp(`\\b${word}\\b`, "i").test(pick.text));
        if (hasStrong) {
          const source = STOCK_LINES[persona][kind]?.find(line => fillVariant(line.text, sampleSlotsFor(kind)).ok && fillVariant(line.text, sampleSlotsFor(kind)).ok && (fillVariant(line.text, sampleSlotsFor(kind)) as { text?: string }).text === pick.text);
          expect(source?.rating, `${persona}/${kind}: ${pick.text}`).toBe("unfiltered");
        }
      }
    }
  });

  it("copes with thin slots: the post still opens on the subject, never on a leftover fragment", () => {
    const thin = { team: "Kittle Me This", player: "Joe Burrow", bid: "$14" };
    for (let seq = 0; seq < 40; seq++) {
      const pick = pickStockLine("dex-alvarez", "waiver_processed", thin, `thin:${seq}`, "clean");
      expect(pick, `seed ${seq}`).not.toBeNull();
      if (pick) {
        expect(pick.text).not.toMatch(/\{[A-Za-z]+\}/);
        expect(pick.text.includes("Kittle Me This") || pick.text.includes("Joe Burrow"), pick.text).toBe(true);
      }
    }
  });

  it("is null when no line can fill at all", () => {
    expect(pickStockLine("dex-alvarez", "waiver_processed", {}, "seed", "clean")).toBeNull();
  });
});

describe("Dex Desk (spec §18)", () => {
  const counts = stockLineCounts();
  const count = (persona: WirePersona, kind: LeagueEventKind) => counts.find(row => row.persona === persona && row.kind === kind)?.total ?? 0;
  const dexKinds = [
    "lineup_move",
    "late_swap",
    "reads_the_wire",
    "trade_proposal",
    "trade_declined",
    "claims_in",
    "quiet_desk",
    "weekly_rundown",
    "streaming_churn",
    "lineup_lock",
    "rumor_check",
  ] as const;
  const picks = (persona: string, kind: LeagueEventKind, slots: Parameters<typeof pickStockLine>[2], rating: "clean" | "salty" | "unfiltered" = "clean", n = 40) => {
    const out: string[] = [];
    for (let seq = 0; seq < n; seq++) {
      const pick = pickStockLine(persona, kind, slots, `L:${seq}:${kind}`, rating);
      expect(pick, `${persona}/${kind} seed ${seq}`).not.toBeNull();
      if (pick) out.push(pick.text);
    }
    return out;
  };

  it("meets the minimums: 12 per Dex kind, 12 per rumor branch, 12 bench lines and 12 FAAB lines for Nina", () => {
    for (const kind of dexKinds) expect(count("dex-alvarez", kind), `dex/${kind}`).toBeGreaterThanOrEqual(12);
    expect(RUMOR_LINES.confirm.length).toBeGreaterThanOrEqual(12);
    expect(RUMOR_LINES.deny.length).toBeGreaterThanOrEqual(12);
    expect(count("dex-alvarez", "rumor_check")).toBe(RUMOR_LINES.confirm.length + RUMOR_LINES.deny.length);
    const bench = (STOCK_LINES["nina-sharpe"].roster_note ?? []).filter(line => templateTokens(line.text).includes("benchCount"));
    expect(bench.length).toBeGreaterThanOrEqual(12);
    expect(count("nina-sharpe", "faab_watch")).toBeGreaterThanOrEqual(12);
  });

  it("never posts a stock line for Sam's question or a manager's own post", () => {
    expect([...NO_STOCK_LINE_KINDS].sort()).toEqual(["manager_post", "manager_reply", "sam_question", "writer_reply"]);
    for (const kind of ["sam_question", "manager_post", "manager_reply", "writer_reply"] as const) {
      for (const persona of ["sam-ortega", "dex-alvarez", "curtis-vaughn"]) {
        expect(pickStockLine(persona, kind, sampleSlotsFor(kind), "seed", "unfiltered"), `${persona}/${kind}`).toBeNull();
      }
      expect(STOCK_LINES["sam-ortega"][kind]).toBeUndefined();
    }
  });

  it("claims_in obeys the leak policy: no team, manager, bid or FAAB token and never a dollar figure", () => {
    const forbidden = ["team", "ownerTeam", "opponentTeam", "otherTeam", "manager", "bid", "faab", "topBid", "faabLeader", "faabLeft", "losingBids"];
    const lines = STOCK_LINES["dex-alvarez"].claims_in ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.text, line.text).not.toContain("$");
      for (const token of templateTokens(line.text)) expect(forbidden, `${line.text} uses {${token}}`).not.toContain(token);
    }
    const slots = { player: "Joe Burrow", pos: "QB", count: "three", heat: "a bid or two in" };
    for (const text of picks("dex-alvarez", "claims_in", slots, "unfiltered")) {
      expect(text).not.toContain("$");
      expect(text).toContain("Joe Burrow");
      expect(text).toContain("three");
    }
  });

  it("lineup_move reads with and without a benched player", () => {
    const withBench = { team: "Kittle Me This", manager: "Jordan Lee", player: "Joe Burrow", slot: "FLEX", benched: "Chase Brown", week: "4" };
    const texts = picks("dex-alvarez", "lineup_move", withBench);
    expect(texts.some(text => text.includes("Chase Brown"))).toBe(true);
    const noBench = { team: "Kittle Me This", manager: "Jordan Lee", player: "Joe Burrow", slot: "FLEX" };
    for (const text of picks("dex-alvarez", "lineup_move", noBench, "unfiltered")) {
      expect(text).not.toContain("Chase Brown");
      expect(text).not.toContain("bench");
      expect(text).toContain("FLEX");
    }
  });

  it("late_swap carries the minutes; lineup_lock and late_swap never grade the decision", () => {
    const swap = { team: "Kittle Me This", manager: "Jordan Lee", player: "Joe Burrow", slot: "FLEX", benched: "Chase Brown", minutes: "40" };
    for (const text of picks("dex-alvarez", "late_swap", swap, "unfiltered")) expect(text).toContain("40");
    const cruel = /mismanag|blunder|mistake|should have|idiot|dumb|panic|stupid/i;
    for (const kind of ["lineup_lock", "late_swap", "reads_the_wire"] as const) {
      for (const line of STOCK_LINES["dex-alvarez"][kind] ?? []) expect(line.text, `${kind}: ${line.text}`).not.toMatch(cruel);
    }
    const lock = { team: "Kittle Me This", manager: "Jordan Lee", player: "Joe Burrow", status: "Out" };
    for (const text of picks("dex-alvarez", "lineup_lock", lock, "unfiltered")) expect(text).toContain("Out");
  });

  it("trade_proposal and trade_declined never deliver a verdict on the deal", () => {
    const verdict = /\b(?:fleec|steal|robbery|lopsided|fair|unfair|winner|loser|smart|dumb|bad deal|good deal)/i;
    for (const kind of ["trade_proposal", "trade_declined"] as const) {
      for (const line of STOCK_LINES["dex-alvarez"][kind] ?? []) expect(line.text, `${kind}: ${line.text}`).not.toMatch(verdict);
    }
    const proposal = { team: "Kittle Me This", otherTeam: "Sable Ridge Sentinels", players: "Joe Burrow and Chase Brown", manager: "Jordan Lee" };
    for (const text of picks("dex-alvarez", "trade_proposal", proposal, "unfiltered")) {
      expect(text).toContain("Joe Burrow and Chase Brown");
      expect(text).toMatch(/Kittle Me This|Jordan Lee/);
      expect(text).toContain("Sable Ridge Sentinels");
    }
    const declined = { team: "Kittle Me This", otherTeam: "Sable Ridge Sentinels" };
    for (const text of picks("dex-alvarez", "trade_declined", declined)) expect(text).toContain("Kittle Me This");
    const reads = (STOCK_LINES["dex-alvarez"].trade_declined ?? []).filter(line => line.text.includes("My read, not reporting"));
    expect(reads.length).toBeLessThanOrEqual(1);
    for (const line of reads) expect(line.tags).toContain("OPINION");
  });

  it("rumor_check: {players} picks the confirm library, its absence the deny library, and neither mixes", () => {
    for (const line of RUMOR_LINES.confirm) expect(templateTokens(line.text), line.text).toContain("players");
    for (const line of RUMOR_LINES.deny) expect(templateTokens(line.text), line.text).not.toContain("players");
    const confirm = { manager: "Jordan Lee", player: "Joe Burrow", players: "Joe Burrow and Chase Brown" };
    const deny = { manager: "Jordan Lee", player: "Joe Burrow" };
    expect(rumorBranchFor(confirm)).toBe("confirm");
    expect(rumorBranchFor(deny)).toBe("deny");
    expect(rumorBranchFor({ ...deny, players: "  " })).toBe("deny");
    for (const text of picks("dex-alvarez", "rumor_check", confirm, "unfiltered")) {
      expect(text).toContain("Joe Burrow and Chase Brown");
      expect(text.toLowerCase()).not.toMatch(/nothing in the system|no proposal|nothing pending|says nothing/);
    }
    for (const text of picks("dex-alvarez", "rumor_check", deny, "unfiltered")) {
      expect(text).toContain("Joe Burrow");
      expect(text).not.toContain("Chase Brown");
      expect(text.toLowerCase()).not.toMatch(/there is a proposal|is pending|pending proposal|live proposal/);
    }
    // The explicit picker ignores the slots' implication.
    const forcedDeny = pickRumorLine("deny", confirm, "seed", "clean");
    expect(forcedDeny?.text).toContain("Joe Burrow");
    expect(forcedDeny?.text).not.toContain("Chase Brown");
    expect(pickRumorLine("confirm", deny, "seed", "clean")).toBeNull();
    for (const branch of ["confirm", "deny"] as const) {
      const pick = pickRumorLine(branch, confirm, "seed", "clean");
      expect(pick?.tags).toEqual(["STATED", "REPORTED"]);
    }
  });

  it("weekly_rundown drops only the sentences a FAAB-less league cannot fill", () => {
    const thin = { week: "4", adds: "14", drops: "12", claims: "9" };
    for (const text of picks("dex-alvarez", "weekly_rundown", thin, "unfiltered")) {
      expect(text).toContain("14");
      expect(text).toContain("12");
      expect(text).toContain("9");
      expect(text).not.toContain("$");
      expect(text).not.toMatch(/FAAB/);
    }
    for (const text of picks("dex-alvarez", "weekly_rundown", sampleSlotsFor("weekly_rundown"))) {
      expect(text).toContain("Jake Browning");
      expect(text).toContain("$14");
      expect(text).toContain("Moisty Loins");
    }
  });

  it("quiet_desk reads with a single team or a joined list; streaming_churn reads with and without the streak phrase", () => {
    const list = { team: "Kittle Me This, Moisty Loins and Sable Ridge Sentinels", weeksSilent: "6", deadline: "Tuesday, November 10" };
    for (const text of picks("dex-alvarez", "quiet_desk", list, "unfiltered")) {
      expect(text).toContain("Sable Ridge Sentinels");
      expect(text).toContain("Tuesday, November 10");
    }
    const churn = { team: "Kittle Me This", unit: "K", count: "four", player: "Evan McPherson" };
    for (const text of picks("dex-alvarez", "streaming_churn", churn, "unfiltered")) expect(text).toContain("Evan McPherson");
  });

  it("roster_note: {benchCount} picks the bench hoard, its absence the IR branch; faab_watch carries both numbers", () => {
    const bench = { team: "Kittle Me This", position: "WR", benchCount: "6" };
    for (const text of picks("nina-sharpe", "roster_note", bench, "unfiltered")) {
      expect(text).toContain("6");
      expect(text).toContain("WR");
      expect(text).not.toMatch(/\bIR\b/);
    }
    const ir = { team: "Kittle Me This", player: "Joe Burrow", status: "Active" };
    for (const text of picks("nina-sharpe", "roster_note", ir, "unfiltered")) {
      expect(text).toContain("Joe Burrow");
      expect(text).toContain("Active");
      expect(text).toMatch(/\bIR\b/);
    }
    const faab = { team: "Kittle Me This", faabLeft: "$7", weeksLeft: "7" };
    for (const text of picks("nina-sharpe", "faab_watch", faab, "unfiltered")) expect(text).toContain("$7");
  });

  it("never opens a sentence with a word-valued slot (count, heat, hoursAgo, direction), which would print lowercase", () => {
    const opener = /(?:^|[.!?]["”’)]*\s+)\{(?:count|heat|hoursAgo|direction)\}/;
    for (const { persona, kind, line } of everyLine()) expect(line.text, `${persona}/${kind}: ${line.text}`).not.toMatch(opener);
  });

  it("keeps every Dex Desk line under the limit with long league names", () => {
    const long = "The Extraordinarily Long Fantasy Football Team Name Society";
    for (const kind of [...dexKinds, "roster_note", "faab_watch"] as const) {
      const persona = kind === "roster_note" || kind === "faab_watch" ? "nina-sharpe" : "dex-alvarez";
      const slots = { ...sampleSlotsFor(kind), team: long, otherTeam: long, faabLeader: long };
      for (let seq = 0; seq < 20; seq++) {
        const pick = pickStockLine(persona, kind, slots, `long:${seq}:${kind}`, "clean");
        expect(pick, `${kind} seed ${seq}`).not.toBeNull();
        expect(pick?.text.length ?? 0).toBeLessThanOrEqual(MAX_POST_CHARS);
        expect(pick?.text).not.toMatch(/\{[A-Za-z]+\}/);
      }
    }
  });
});
