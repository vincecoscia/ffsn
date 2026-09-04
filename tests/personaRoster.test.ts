import { describe, expect, it } from "vitest";

import { personaPrompts } from "../src/lib/ai/persona-prompts";
import { contentTemplates } from "../src/lib/ai/content-templates";
import {
  writerRoster,
  defaultPersonaFor,
  personasForContentType,
  deskPicksFor,
  isDeskPick,
  isSignatureColumn,
  SIGNATURE_COLUMNS,
  isSelectableContentType,
  contentTypeLabel,
} from "@/components/broadcast/personaRoster";
import { ACTIVE_WRITERS } from "../convex/relationships";
import { DEFAULT_SCHEDULES, resolveTargetWeek } from "../convex/contentScheduling";

/**
 * Reggie Banks, "The Results Desk" (spec §3 addition): a seventh writer sitting right
 * after Mel Diaper in the roster, and his weekly column "The Bank Statement"
 * (`bank_statement`). The single most valuable assertion here is that the hard-coded
 * Convex `ACTIVE_WRITERS` list matches `writerRoster` exactly — see the header comment
 * on `convex/relationships.ts` for why that list is duplicated instead of imported.
 */

const EXPECTED_ROSTER_ORDER = [
  "curtis-vaughn",
  "sam-ortega",
  "nina-sharpe",
  "dex-alvarez",
  "mel-diaper",
  "reggie-banks",
  "walt-brennan",
];

describe("Reggie Banks — persona", () => {
  it("exists in personaPrompts as a selectable, non-interviewing writer", () => {
    const reggie = personaPrompts["reggie-banks"];
    expect(reggie).toBeDefined();
    expect(reggie.isWriter).toBe(true);
    expect(reggie.isInterviewer).toBe(false);
    expect(reggie.role).toBe("The Results Desk");
  });

  it("has no digit in any exampleOutputs line (placeholder rule)", () => {
    const reggie = personaPrompts["reggie-banks"];
    for (const line of reggie.exampleOutputs) {
      expect(line).not.toMatch(/\d/);
    }
  });
});

describe("writer roster order", () => {
  it("sits right after Mel Diaper, before Walt Brennan", () => {
    expect(writerRoster.map((w) => w.slug)).toEqual(EXPECTED_ROSTER_ORDER);
  });

  it("matches the hard-coded convex/relationships ACTIVE_WRITERS list exactly", () => {
    expect([...ACTIVE_WRITERS]).toEqual(EXPECTED_ROSTER_ORDER);
    expect([...ACTIVE_WRITERS]).toEqual(writerRoster.map((w) => w.slug));
  });
});

describe("The Bank Statement — content type", () => {
  it("defaults to Reggie Banks and is offered on the emergency hot takes desk", () => {
    expect(defaultPersonaFor("bank_statement")).toBe("reggie-banks");
    expect(
      personasForContentType("emergency_hot_takes").map((w) => w.slug)
    ).toContain("reggie-banks");
  });

  it("has a template with the five specified sections and is selectable", () => {
    const template = contentTemplates.bank_statement;
    expect(template).toBeDefined();
    expect(template.sections.map((s) => s.name)).toEqual([
      "opening_bell",
      "deposits",
      "overdrawn",
      "the_homework",
      "team_comments",
    ]);
    expect(isSelectableContentType("bank_statement")).toBe(true);
  });

  it('labels as "The Bank Statement"', () => {
    expect(contentTypeLabel("bank_statement")).toBe("The Bank Statement");
  });

  it("is created disabled on a weekly Tuesday 12:00 schedule, and reads off the prior week", () => {
    const schedule = DEFAULT_SCHEDULES.bank_statement;
    expect(schedule).toBeDefined();
    expect(schedule.enabled).toBe(false);
    expect(schedule.schedule).toEqual({
      type: "weekly",
      dayOfWeek: 2,
      hour: 12,
      minute: 0,
    });
    expect(resolveTargetWeek("bank_statement", 5)).toBe(4);
  });
});

/**
 * Every writer is selectable for every on-demand article (owner directive, 2026-09-04), with
 * the desk's mapped writers offered first. The two signature columns are the exception: they
 * are one writer's named column, so the picker keeps them with their owner.
 */
describe("writer picker — every writer for every type", () => {
  const rosterSlugs = writerRoster.map((w) => w.slug);

  it("offers the whole roster for an ordinary type, desk picks first, nobody twice", () => {
    for (const type of ["weekly_recap", "custom_roast", "mock_draft", "season_welcome", "waiver_wire_report"]) {
      const offered = personasForContentType(type).map((w) => w.slug);
      expect(new Set(offered).size).toBe(offered.length);
      expect([...offered].sort()).toEqual([...rosterSlugs].sort());
      const picks = deskPicksFor(type).map((w) => w.slug);
      expect(picks.length).toBeGreaterThan(0);
      expect(offered.slice(0, picks.length)).toEqual(picks);
      expect(offered[0]).toBe(defaultPersonaFor(type));
    }
  });

  it("keeps the rest of the roster in roster order after the desk picks", () => {
    const offered = personasForContentType("rivalry_week_special").map((w) => w.slug);
    const picks = deskPicksFor("rivalry_week_special").map((w) => w.slug);
    const rest = offered.slice(picks.length);
    expect(rest).toEqual(rosterSlugs.filter((slug) => !picks.includes(slug)));
  });

  it("keeps the two signature columns with their owners only", () => {
    expect([...SIGNATURE_COLUMNS].sort()).toEqual(["bank_statement", "trade_rumor_mill"]);
    expect(personasForContentType("bank_statement").map((w) => w.slug)).toEqual(["reggie-banks"]);
    expect(personasForContentType("trade_rumor_mill").map((w) => w.slug)).toEqual(["dex-alvarez"]);
    expect(isSignatureColumn("bank_statement")).toBe(true);
    expect(isSignatureColumn("weekly_recap")).toBe(false);
  });

  it("marks only the desk's mapped writers as desk picks", () => {
    expect(isDeskPick("power_rankings", "nina-sharpe")).toBe(true);
    expect(isDeskPick("power_rankings", "curtis-vaughn")).toBe(true);
    expect(isDeskPick("power_rankings", "mel-diaper")).toBe(false);
    expect(deskPicksFor("not_a_type")).toEqual([]);
    expect(personasForContentType("not_a_type").map((w) => w.slug)).toEqual(rosterSlugs);
  });

  it("offers a writer only if they are still on air", () => {
    for (const type of Object.keys(contentTemplates)) {
      for (const writer of personasForContentType(type)) {
        expect(personaPrompts[writer.slug]?.isWriter).toBe(true);
      }
    }
  });
});
