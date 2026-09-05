import { describe, expect, it } from "vitest";
import { findRegisterLeaks } from "../src/lib/ai/fact-verifier";
import { countProfanity, STRONG_PROFANITY } from "../src/lib/ai/language";
import { personaPrompts, reservedDeskHasTheirOne } from "../src/lib/ai/persona-prompts";
import { fillVariant, templateTokens } from "../src/lib/ai/wire/fill";
import { pickStockLine, sampleSlotsFor, STOCK_LINES, stockLineCounts } from "../src/lib/ai/wire/stock-lines";
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
