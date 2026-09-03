import { describe, expect, it } from "vitest";

import { personaPrompts } from "../src/lib/ai/persona-prompts";
import { contentTemplates } from "../src/lib/ai/content-templates";
import {
  writerRoster,
  defaultPersonaFor,
  personasForContentType,
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
