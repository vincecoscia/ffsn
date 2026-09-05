import { describe, expect, it } from "vitest";
import {
  buildEspnMatchIndex,
  matchPlayerToEspnId,
  normalizePlayerName,
  normalizePosition,
  parseCsvRecords,
  parseCsvRows,
  resolveEspnId,
} from "../convex/lib/intelMapping";

describe("parseCsvRows", () => {
  it("parses a simple comma-separated file", () => {
    expect(parseCsvRows("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a comma inside a quoted field", () => {
    expect(parseCsvRows('a,"b,c",d\n')).toEqual([["a", "b,c", "d"]]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsvRows('a,"say ""hi""",c\n')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsvRows("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles a bare LF as well as CRLF in the same file", () => {
    expect(parseCsvRows("a,b\r\nc,d\ne,f\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("does not manufacture a phantom trailing row from a trailing newline", () => {
    expect(parseCsvRows("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("still returns the last row when the file has no trailing newline", () => {
    expect(parseCsvRows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves a comma-bearing URL like nflverse's headshot column", () => {
    const csv = 'id,headshot\n1,"https://static.www.nfl.com/image/private/f_auto,q_auto/league/abc"\n';
    expect(parseCsvRows(csv)).toEqual([
      ["id", "headshot"],
      ["1", "https://static.www.nfl.com/image/private/f_auto,q_auto/league/abc"],
    ]);
  });
});

describe("parseCsvRecords", () => {
  it("zips header row into keyed records", () => {
    const csv = "gsis_id,full_name,report_status\n00-1,Player One,Questionable\n00-2,Player Two,\n";
    expect(parseCsvRecords(csv)).toEqual([
      { gsis_id: "00-1", full_name: "Player One", report_status: "Questionable" },
      { gsis_id: "00-2", full_name: "Player Two", report_status: "" },
    ]);
  });

  it("skips stray blank lines", () => {
    const csv = "a,b\n1,2\n\n3,4\n";
    expect(parseCsvRecords(csv)).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("returns an empty array for an empty file", () => {
    expect(parseCsvRecords("")).toEqual([]);
  });
});

describe("normalizePlayerName", () => {
  it("lower-cases and collapses whitespace", () => {
    expect(normalizePlayerName("Justin Jefferson")).toBe("justin jefferson");
  });

  it("drops a Jr. suffix", () => {
    expect(normalizePlayerName("Michael Pittman Jr.")).toBe(normalizePlayerName("Michael Pittman"));
  });

  it("drops a bare II/III suffix", () => {
    expect(normalizePlayerName("Melvin Gordon III")).toBe(normalizePlayerName("Melvin Gordon"));
    expect(normalizePlayerName("Odell Beckham II")).toBe(normalizePlayerName("Odell Beckham"));
  });

  it("removes punctuation entirely rather than turning it into a space", () => {
    // Sleeper/ESPN sometimes drop the apostrophe/period that FFC includes.
    expect(normalizePlayerName("Ja'Marr Chase")).toBe(normalizePlayerName("Jamarr Chase"));
    expect(normalizePlayerName("D.K. Metcalf")).toBe(normalizePlayerName("DK Metcalf"));
  });

  it("treats a hyphen as a word boundary", () => {
    expect(normalizePlayerName("Jaxon Smith-Njigba")).toBe(normalizePlayerName("Jaxon Smith Njigba"));
  });

  it("strips accents/diacritics", () => {
    expect(normalizePlayerName("Eddy Piñeiro")).toBe(normalizePlayerName("Eddy Pineiro"));
  });
});

describe("normalizePosition", () => {
  it("maps FFC's PK to K", () => {
    expect(normalizePosition("PK")).toBe("K");
  });

  it("maps every defense spelling to DEF", () => {
    expect(normalizePosition("D/ST")).toBe("DEF");
    expect(normalizePosition("DST")).toBe("DEF");
    expect(normalizePosition("dst")).toBe("DEF");
    expect(normalizePosition("DEF")).toBe("DEF");
  });

  it("passes other positions through, upper-cased", () => {
    expect(normalizePosition("rb")).toBe("RB");
    expect(normalizePosition("WR")).toBe("WR");
  });
});

describe("buildEspnMatchIndex / matchPlayerToEspnId", () => {
  it("matches a unique name + position", () => {
    const index = buildEspnMatchIndex([{ espnId: "1", fullName: "Justin Jefferson", position: "WR", team: "MIN" }]);
    expect(matchPlayerToEspnId(index, { name: "Justin Jefferson", position: "WR" })).toBe("1");
  });

  it("matches a team defense by team abbreviation, ignoring the very different naming conventions", () => {
    const index = buildEspnMatchIndex([
      { espnId: "-16026", fullName: "Seahawks D/ST", position: "D/ST", team: "SEA" },
      { espnId: "-16008", fullName: "Lions D/ST", position: "D/ST", team: "DET" },
    ]);
    expect(matchPlayerToEspnId(index, { name: "Seattle Defense", position: "DEF", team: "SEA" })).toBe("-16026");
    expect(matchPlayerToEspnId(index, { name: "Detroit Defense", position: "DEF", team: "DET" })).toBe("-16008");
  });

  it("returns null for a defense candidate with no team given", () => {
    const index = buildEspnMatchIndex([{ espnId: "-16026", fullName: "Seahawks D/ST", position: "D/ST", team: "SEA" }]);
    expect(matchPlayerToEspnId(index, { name: "Seattle Defense", position: "DEF" })).toBeNull();
  });

  it("matches despite a Jr./III suffix difference between sources", () => {
    const index = buildEspnMatchIndex([{ espnId: "2", fullName: "Michael Pittman", position: "WR", team: "IND" }]);
    expect(matchPlayerToEspnId(index, { name: "Michael Pittman Jr.", position: "WR", team: "IND" })).toBe("2");
  });

  it("matches despite an accent difference between sources", () => {
    const index = buildEspnMatchIndex([{ espnId: "3", fullName: "Eddy Pineiro", position: "K", team: "SF" }]);
    expect(matchPlayerToEspnId(index, { name: "Eddy Piñeiro", position: "PK", team: "SF" })).toBe("3");
  });

  it("disambiguates two same-named players at the same position by team", () => {
    const index = buildEspnMatchIndex([
      { espnId: "10", fullName: "Josh Allen", position: "QB", team: "BUF" },
      { espnId: "11", fullName: "Josh Allen", position: "LB", team: "JAX" }, // different position, no collision
      { espnId: "12", fullName: "Michael Thomas", position: "WR", team: "NO" },
      { espnId: "13", fullName: "Michael Thomas", position: "WR", team: "HOU" },
    ]);

    // No team given: ambiguous between two WRs named Michael Thomas.
    expect(matchPlayerToEspnId(index, { name: "Michael Thomas", position: "WR" })).toBeNull();
    // Team given: resolves to the right one.
    expect(matchPlayerToEspnId(index, { name: "Michael Thomas", position: "WR", team: "NO" })).toBe("12");
    expect(matchPlayerToEspnId(index, { name: "Michael Thomas", position: "WR", team: "HOU" })).toBe("13");
    // A team that matches neither candidate is also unmatched, not a guess.
    expect(matchPlayerToEspnId(index, { name: "Michael Thomas", position: "WR", team: "SEA" })).toBeNull();
  });

  it("returns null when there is no candidate at all", () => {
    const index = buildEspnMatchIndex([{ espnId: "1", fullName: "Justin Jefferson", position: "WR", team: "MIN" }]);
    expect(matchPlayerToEspnId(index, { name: "Nobody Here", position: "WR" })).toBeNull();
  });
});

describe("resolveEspnId", () => {
  const index = buildEspnMatchIndex([
    { espnId: "4362628", fullName: "Ja'Marr Chase", position: "WR", team: "CIN" },
    { espnId: "1", fullName: "Josh Allen", position: "QB", team: "BUF" },
    { espnId: "2", fullName: "Josh Allen", position: "QB", team: "JAX" },
    { espnId: "3", fullName: "Lions D/ST", position: "D/ST", team: "DET" },
  ]);

  it("keeps the feed's own espn id when it has one", () => {
    expect(resolveEspnId(3117251, { name: "Christian McCaffrey", position: "RB", team: "SF" }, index)).toEqual({ espnId: "3117251", via: "id" });
    expect(resolveEspnId(" 3117251 ", { name: "x", position: "RB" }, index)?.espnId).toBe("3117251");
  });

  it("falls back to name + position, with the team as the tiebreak, and refuses an ambiguous match", () => {
    expect(resolveEspnId(null, { name: "Ja'Marr Chase", position: "WR", team: "CIN" }, index)).toEqual({ espnId: "4362628", via: "name" });
    expect(resolveEspnId(undefined, { name: "Josh Allen", position: "QB", team: "BUF" }, index)).toEqual({ espnId: "1", via: "name" });
    expect(resolveEspnId(undefined, { name: "Josh Allen", position: "QB" }, index)).toBeNull();
    expect(resolveEspnId("", { name: "Nobody Here", position: "WR", team: "CIN" }, index)).toBeNull();
    expect(resolveEspnId(null, { name: "", position: "WR" }, index)).toBeNull();
  });
});
