import { describe, expect, it } from "vitest";
import { cleanTeamArticleViolations } from "../src/lib/ai/content-generation-service";

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
