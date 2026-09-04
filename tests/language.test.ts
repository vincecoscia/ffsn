import { describe, expect, it } from "vitest";
import {
  countProfanity,
  DEFAULT_LANGUAGE_RATING,
  mentionRatio,
  MILD_PROFANITY,
  PROFANITY_WORDS,
  stripExemptPhrases,
  STRONG_PROFANITY,
  cleanTeamViolations,
  removeSentences,
} from "../src/lib/ai/language";

describe("DEFAULT_LANGUAGE_RATING", () => {
  it("is clean", () => {
    expect(DEFAULT_LANGUAGE_RATING).toBe("clean");
  });
});

describe("profanity tiers", () => {
  it("keeps mild and strong separate, and PROFANITY_WORDS is their concatenation", () => {
    expect(MILD_PROFANITY).toContain("damn");
    expect(MILD_PROFANITY).not.toContain("fuck");
    expect(STRONG_PROFANITY).toContain("fuck");
    expect(STRONG_PROFANITY).not.toContain("damn");
    expect(PROFANITY_WORDS).toEqual([...MILD_PROFANITY, ...STRONG_PROFANITY]);
  });

  /**
   * Slurs must never be enumerated in this repo (see language.ts's own header comment), so this
   * checklist is kept only as a fingerprint — first two letters + exact length — never spelled out,
   * even here. A plain "first letter + length" fingerprint would false-positive on legitimate
   * strong-tier words ("fucked" is also an f/6 word), so the check uses the first TWO letters.
   */
  it("contains no word matching the slur checklist (fingerprinted, never spelled out)", () => {
    const SLUR_SIGNATURES = [
      /^ni.{4}$/i, // 6-letter slur starting "ni"
      /^ni.{3}$/i, // 5-letter variant starting "ni"
      /^fa.{4}$/i, // 6-letter slur starting "fa"
      /^ch.{3}$/i, // 5-letter slur starting "ch"
      /^sp.{2}$/i, // 4-letter slur starting "sp"
      /^ki.{2}$/i, // 4-letter slur starting "ki"
      /^go.{2}$/i, // 4-letter slur starting "go"
      /^be.{4}$/i, // 6-letter slur starting "be"
      /^tr.{4}$/i, // 6-letter slur starting "tr"
      /^dy.{2}$/i, // 4-letter slur starting "dy"
    ];
    for (const word of PROFANITY_WORDS) {
      for (const pattern of SLUR_SIGNATURES) {
        expect(pattern.test(word), `${word} matches slur signature ${pattern}`).toBe(false);
      }
    }
  });
});

describe("countProfanity", () => {
  it("counts mild and strong profanity, whole-word and case-insensitive", () => {
    const result = countProfanity("Damn, that pick sucks. He absolutely FUCKED it up and the bench is bullshit.");
    expect(result.mild).toBe(2);
    expect(result.strong).toBe(2);
    expect(result.words.slice().sort()).toEqual(["bullshit", "damn", "fucked", "sucks"]);
  });

  it("matches whole words only — a profanity word inside a longer word does not count", () => {
    const result = countProfanity("The class assignment was tough but the assistant helped.");
    expect(result.mild).toBe(0);
    expect(result.strong).toBe(0);
    expect(result.words).toEqual([]);
  });

  it("returns zero counts for clean text", () => {
    const result = countProfanity("The Sable Ridge Sentinels won a clean, well-earned victory.");
    expect(result).toEqual({ mild: 0, strong: 0, words: [] });
  });
});

describe("countProfanity — exempt phrases (team names are facts, not the writer's words)", () => {
  const text =
    "The GLORY ASSHOLE dropped their kicker again this week. Frankly, that lineup call was pure " +
    "asshole thinking.";

  it("ignores a team name containing a listed word, but still counts the same word used outside it", () => {
    const result = countProfanity(text, ["GLORY ASSHOLE"]);
    expect(result.strong).toBe(1);
    expect(result.mild).toBe(0);
    expect(result.words).toEqual(["asshole"]);
  });

  it("without the exempt phrase, the same text counts both the team-name occurrence and the standalone one", () => {
    const result = countProfanity(text);
    expect(result.strong).toBe(2);
  });

  it("an exempt phrase that never appears in the text changes nothing", () => {
    const result = countProfanity(text, ["Gravel Pit Grinders"]);
    expect(result.strong).toBe(2);
  });
});

describe("stripExemptPhrases", () => {
  it("removes a whole-phrase, case-insensitive match and leaves the rest of the text intact", () => {
    expect(stripExemptPhrases("The GLORY ASSHOLE lost again.", ["glory asshole"])).toBe("The   lost again.");
  });

  it("never eats into a larger word it merely sits inside (word-bounded, not substring)", () => {
    // "Ace" is replaced with a single space; the space that already followed it in the source is
    // untouched, so the result carries both — "Space" itself is never corrupted.
    expect(stripExemptPhrases("Ace of Space rules this league.", ["Ace"])).toBe("  of Space rules this league.");
    expect(stripExemptPhrases("Ace of Space rules this league.", ["Ace"])).not.toContain("Sp e");
  });

  it("ignores an empty or blank phrase rather than stripping every character", () => {
    expect(stripExemptPhrases("Nothing to strip here.", ["", "   "])).toBe("Nothing to strip here.");
  });
});

describe("mentionRatio — basic counts", () => {
  it("counts each team's full name and each manager's full name once per occurrence", () => {
    const teams = [
      { name: "Sable Ridge Sentinels", manager: "Ruth Tanaka" },
      { name: "Gravel Pit Grinders", manager: "Dana Whitlock" },
    ];
    const text =
      "The Sable Ridge Sentinels won again. Ruth Tanaka made the calls. " +
      "The Gravel Pit Grinders lost. Dana Whitlock will answer for it.";

    const result = mentionRatio(text, teams);

    expect(result.teamMentions).toBe(2);
    expect(result.managerMentions).toBe(2);
    expect(result.ratio).toBe(1);
  });

  it("returns a null ratio when no manager is mentioned at all", () => {
    const teams = [{ name: "Sable Ridge Sentinels", manager: "Ruth Tanaka" }];
    const text = "The Sable Ridge Sentinels won again.";

    const result = mentionRatio(text, teams);

    expect(result.teamMentions).toBe(1);
    expect(result.managerMentions).toBe(0);
    expect(result.ratio).toBeNull();
  });
});

describe("mentionRatio — short-form rule", () => {
  it("also counts a 3+ word team name's last two words as a short form, without double-counting the full name", () => {
    const teams = [{ name: "Sable Ridge Sentinels", manager: "Ruth Tanaka" }];
    const text =
      "The Sable Ridge Sentinels opened strong. By the fourth quarter, Ridge Sentinels fans were " +
      "nervous, but Ridge Sentinels held on.";

    const result = mentionRatio(text, teams);

    // One full-name occurrence ("Sable Ridge Sentinels") plus two short-form occurrences ("Ridge
    // Sentinels" on its own) — the full-name match consumes its words, so the short form is never
    // counted a second time for that same occurrence.
    expect(result.teamMentions).toBe(3);
  });

  it("does not add a short form for a team name under 3 words", () => {
    const teams = [{ name: "Ashby Avengers" }];
    const text = "The Ashby Avengers stumbled. Avengers alone never shows up as its own phrase here.";

    const result = mentionRatio(text, teams);

    // Only "Ashby Avengers" (the full 2-word name) counts; "Avengers" alone is never searched for.
    expect(result.teamMentions).toBe(1);
  });
});

describe("mentionRatio — no-double-count / ambiguous-name rule", () => {
  it("never counts a manager's first or last name alone when that word is also part of a team name", () => {
    const teams = [{ name: "Ashby Avengers", manager: "Trevor Ashby" }];
    const text =
      "The Ashby Avengers stumbled again. Trevor Ashby insists the roster is fine, but Ashby's " +
      "history says otherwise, and the Ashby Avengers need answers.";

    const result = mentionRatio(text, teams);

    // teamMentions: "Ashby Avengers" appears twice as the full team-name phrase.
    expect(result.teamMentions).toBe(2);
    // managerMentions: only the one "Trevor Ashby" full-name occurrence counts. "Ashby" alone is
    // ambiguous with the team name "Ashby Avengers" and is never searched for on its own, so the
    // two other lone "Ashby" occurrences (mid-sentence, and inside "Ashby's") are not counted.
    expect(result.managerMentions).toBe(1);
    expect(result.ratio).toBe(2);
  });

  it("still counts a manager's first name alone when it does not collide with any team name", () => {
    const teams = [{ name: "Ashby Avengers", manager: "Trevor Ashby" }];
    const text = "Trevor made the call. Trevor's confidence never wavered.";

    const result = mentionRatio(text, teams);

    expect(result.managerMentions).toBe(2);
  });
});

describe("cleanTeamViolations — the manager opt-down, enforced", () => {
  const cleanTeams = [{ name: "Sable Ridge Sentinels", manager: "Ruth Tanaka" }];
  const allTeams = ["Sable Ridge Sentinels", "Gravel Pit Grinders", "Damn Good Dynasty"];

  it("flags a sentence that names the opted-down team and carries profanity, and nothing else", () => {
    const text =
      "The Gravel Pit Grinders are 7-0, which is a damn fine record. The Sable Ridge Sentinels' lineup card is horseshit. Ruth Tanaka benched a 24-point receiver, and that is bullshit. The Ridge Sentinels are 0-7.";
    const found = cleanTeamViolations(text, cleanTeams, allTeams);
    expect(found.map((v) => v.sentence)).toEqual([
      "The Sable Ridge Sentinels' lineup card is horseshit.",
      "Ruth Tanaka benched a 24-point receiver, and that is bullshit.",
    ]);
    expect(found.every((v) => v.team === "Sable Ridge Sentinels")).toBe(true);
  });

  it("matches the short form of a 3+ word team name", () => {
    expect(cleanTeamViolations("The Ridge Sentinels' bench is a shitshow.", cleanTeams, allTeams)).toHaveLength(1);
  });

  it("ignores a clean sentence about the team, profanity about another team, and profanity inside a team name", () => {
    expect(cleanTeamViolations("The Sable Ridge Sentinels are 0-7 and that is a record.", cleanTeams, allTeams)).toEqual([]);
    expect(cleanTeamViolations("The Gravel Pit Grinders' draft was horseshit.", cleanTeams, allTeams)).toEqual([]);
    expect(cleanTeamViolations("The Sable Ridge Sentinels lost to the Damn Good Dynasty.", cleanTeams, allTeams)).toEqual([]);
  });

  it("returns nothing with no opted-down teams", () => {
    expect(cleanTeamViolations("Ruth Tanaka's card is horseshit.", [], allTeams)).toEqual([]);
  });
});

describe("removeSentences", () => {
  it("drops exactly the named sentences and re-joins the rest", () => {
    const text = "One stays. Two goes away! Three stays.";
    expect(removeSentences(text, ["Two goes away!"])).toBe("One stays. Three stays.");
    expect(removeSentences(text, [])).toBe(text);
  });
});
