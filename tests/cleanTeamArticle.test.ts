import { describe, expect, it } from "vitest";
import { cleanTeamArticleViolations, languageArticleViolations } from "../src/lib/ai/content-generation-service";

const article = {
  sections: [
    { name: "THE BOARD", content: "The Gravel Pit Grinders' draft was horseshit. The Sable Ridge Sentinels are 0-7.", wordCount: 0 },
    { name: "THE CRIMES", content: "Ruth Tanaka benched a 24-point receiver and that is bullshit. Fine. Next item.", wordCount: 0 },
  ],
};
const cleanTeams = [{ name: "Sable Ridge Sentinels", manager: "Ruth Tanaka" }];
const allTeams = ["Sable Ridge Sentinels", "Gravel Pit Grinders"];

describe("cleanTeamArticleViolations — the manager opt-down in the article path", () => {
  it("emits one strip per offending sentence, naming the section and the team", () => {
    const found = cleanTeamArticleViolations(article, cleanTeams, allTeams);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "clean_team_language", severity: "strip", section: "THE CRIMES" });
    expect(found[0].detail).toContain('"Ruth Tanaka benched a 24-point receiver and that is bullshit."');
    expect(found[0].detail).toContain("Sable Ridge Sentinels");
  });

  it("emits nothing with no opted-down teams, or when the profanity is about another team", () => {
    expect(cleanTeamArticleViolations(article, [], allTeams)).toEqual([]);
    expect(cleanTeamArticleViolations(article, [{ name: "Gravel Pit Grinders", manager: "Dana Whitlock" }], allTeams)).toHaveLength(1);
  });
});

describe("languageArticleViolations — the rating and the writer's effective allowance, enforced in articles", () => {
  const teams = ["Sable Ridge Sentinels", "Damn Good Dynasty"];
  const body = {
    sections: [
      { name: "A", content: "The Sentinels lost. That lineup is horseshit. The Damn Good Dynasty won.", wordCount: 0 },
      { name: "B", content: "Hell of a week. What a damn game. Fine.", wordCount: 0 },
    ],
  };

  it("at clean strips every sentence with a tracked word, team names exempt", () => {
    const found = languageArticleViolations(body, { rating: "clean", allowance: 0, teamNames: teams });
    expect(found.map((v) => v.detail.match(/"([^"]+)"/)![1])).toEqual([
      "That lineup is horseshit.",
      "Hell of a week.",
      "What a damn game.",
    ]);
    expect(found.every((v) => v.kind === "language_over_rating" && v.severity === "strip")).toBe(true);
  });

  it("at salty strips the strong word, then mild words past the allowance, in reading order", () => {
    const found = languageArticleViolations(body, { rating: "salty", allowance: 1, teamNames: teams });
    expect(found.map((v) => v.detail.match(/"([^"]+)"/)![1])).toEqual(["That lineup is horseshit.", "What a damn game."]);
    expect(found[0].detail).toContain("outside the league's salty rating");
    expect(found[1].detail).toContain("past this writer's allowance of 1");
  });

  it("at unfiltered strips nothing inside the allowance, and everything past it — including a gated-off reserved writer's allowance of 0", () => {
    expect(languageArticleViolations(body, { rating: "unfiltered", allowance: 3, teamNames: teams })).toEqual([]);
    expect(languageArticleViolations(body, { rating: "unfiltered", allowance: 2, teamNames: teams }).map((v) => v.section)).toEqual(["B"]);
    expect(languageArticleViolations(body, { rating: "unfiltered", allowance: 0, teamNames: teams })).toHaveLength(3);
  });
});
