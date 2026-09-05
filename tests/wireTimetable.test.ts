import { describe, expect, it } from "vitest";
import { extractTimetable, isMultiWeekTimetable, isSeasonEndingTimetable } from "../src/lib/ai/wire/timetable";

describe("extractTimetable", () => {
  it("returns a range verbatim, en dash and all", () => {
    expect(extractTimetable("Burrow is expected to miss 6–8 weeks with a toe injury.")).toBe("6–8 weeks");
    expect(extractTimetable("He is out 6-8 weeks.")).toBe("6-8 weeks");
    expect(extractTimetable("Sidelined 4 to 6 weeks, the team said.")).toBe("4 to 6 weeks");
  });

  it("prefers the range over a bare count inside it", () => {
    expect(extractTimetable("out 6-8 weeks")).not.toBe("8 weeks");
    expect(extractTimetable("out 6-8 weeks")).toBe("6-8 weeks");
  });

  it("returns a bare count", () => {
    expect(extractTimetable("He will miss 3 weeks.")).toBe("3 weeks");
    expect(extractTimetable("Expected back in 1 week.")).toBe("1 week");
  });

  it("returns the season phrases", () => {
    expect(extractTimetable("He is out for the rest of the season.")).toBe("rest of the season");
    expect(extractTimetable("Done for the remainder of the season.")).toBe("remainder of the season");
    expect(extractTimetable("A season-ending ACL tear.")).toBe("season-ending");
    expect(extractTimetable("The injury is season ending.")).toBe("season ending");
    expect(extractTimetable("He is out for the year.")).toBe("out for the year");
    expect(extractTimetable("Out for the season, per the team.")).toBe("Out for the season");
  });

  it("returns week-to-week, day-to-day, multiple weeks and indefinitely", () => {
    expect(extractTimetable("Ossai is week-to-week due to a plantar fascia injury.")).toBe("week-to-week");
    expect(extractTimetable("Rodriguez (undisclosed) is considered day-to-day.")).toBe("day-to-day");
    expect(extractTimetable("He could miss multiple weeks.")).toBe("multiple weeks");
    expect(extractTimetable("Out indefinitely.")).toBe("indefinitely");
  });

  it("walks the patterns in priority order rather than text order", () => {
    // "day-to-day" comes first in the text, but the bare-count pattern is tried before it.
    expect(extractTimetable("He is day-to-day and could miss 2 weeks.")).toBe("2 weeks");
  });

  it("never normalises what it found", () => {
    expect(extractTimetable("Listed Week-To-Week.")).toBe("Week-To-Week");
    expect(extractTimetable("  6 – 8 weeks  ")).toBe("6 – 8 weeks");
  });

  it("is undefined for text with no timetable, and for no text", () => {
    expect(extractTimetable(undefined)).toBeUndefined();
    expect(extractTimetable("")).toBeUndefined();
    expect(extractTimetable("Brissett is listed with the first-team offense on the depth chart.")).toBeUndefined();
    expect(extractTimetable("Ready for Week 1 after a strong weekend.")).toBeUndefined();
    expect(extractTimetable("He must miss at least four games.")).toBeUndefined();
  });
});

describe("isMultiWeekTimetable", () => {
  it("is true for ranges, counts of two or more, and the season phrases", () => {
    expect(isMultiWeekTimetable("6-8 weeks")).toBe(true);
    expect(isMultiWeekTimetable("2 weeks")).toBe(true);
    expect(isMultiWeekTimetable("multiple weeks")).toBe(true);
    expect(isMultiWeekTimetable("season-ending")).toBe(true);
    expect(isMultiWeekTimetable("out for the year")).toBe(true);
  });
  it("is false for a single week, day-to-day, week-to-week, indefinitely and nothing", () => {
    expect(isMultiWeekTimetable("1 week")).toBe(false);
    expect(isMultiWeekTimetable("day-to-day")).toBe(false);
    expect(isMultiWeekTimetable("week-to-week")).toBe(false);
    expect(isMultiWeekTimetable("indefinitely")).toBe(false);
    expect(isMultiWeekTimetable(undefined)).toBe(false);
  });
});

describe("isSeasonEndingTimetable", () => {
  it("recognises only the season-over phrases", () => {
    expect(isSeasonEndingTimetable("season-ending")).toBe(true);
    expect(isSeasonEndingTimetable("rest of the season")).toBe(true);
    expect(isSeasonEndingTimetable("out for the season")).toBe(true);
    expect(isSeasonEndingTimetable("6-8 weeks")).toBe(false);
    expect(isSeasonEndingTimetable(undefined)).toBe(false);
  });
});
