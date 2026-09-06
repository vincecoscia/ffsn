import { describe, expect, it } from "vitest";
import { ARTICLE_PATH_RE, extractArticleId, stripArticlePaths } from "../src/lib/ai/wire/articleLink";

const REALISTIC_ID = "j579z79ajyrppk0z263tf4dbt18dxq00";

describe("ARTICLE_PATH_RE", () => {
  it("matches a realistic article id", () => {
    expect(ARTICLE_PATH_RE.test(`/articles/${REALISTIC_ID}`)).toBe(true);
  });
});

describe("extractArticleId", () => {
  it("finds the id in the first /articles/<id> match", () => {
    const text = `NEW PIECE. "Ten Teams, Seven Seasons". /articles/${REALISTIC_ID}. I have the receipts and I have ALL DAY. Read it.`;
    expect(extractArticleId(text)).toBe(REALISTIC_ID);
  });

  it("returns undefined when no path is present", () => {
    expect(extractArticleId("NEW PIECE. \"Title\". Read it; that's the whole assignment.")).toBeUndefined();
  });

  it("uses a fresh match each call rather than a stateful lastIndex", () => {
    const text = `See /articles/${REALISTIC_ID} for details.`;
    expect(extractArticleId(text)).toBe(REALISTIC_ID);
    // Calling again with the same text must return the same result, not undefined from a
    // leftover lastIndex on a shared global regex.
    expect(extractArticleId(text)).toBe(REALISTIC_ID);
  });
});

describe("stripArticlePaths", () => {
  it("removes the 'Link: ' wrapper (case-insensitive) and its trailing period", () => {
    const text = `{writer} filed. Title: "{title}". Link: /articles/${REALISTIC_ID}. That's the wire.`;
    expect(stripArticlePaths(text)).toBe('{writer} filed. Title: "{title}". That\'s the wire.');

    const lower = `{writer} filed. Title: "{title}". link: /articles/${REALISTIC_ID}. That's the wire.`;
    expect(stripArticlePaths(lower)).toBe('{writer} filed. Title: "{title}". That\'s the wire.');
  });

  it("collapses a bare colon wrapper (no 'Link' word) into a single terminating period", () => {
    const text = `it's here: /articles/${REALISTIC_ID}. read it slowly`;
    expect(stripArticlePaths(text)).toBe("it's here. read it slowly");
  });

  it("removes a bare path mid-sentence via the catch-all rule (the owner's own worked case)", () => {
    const text = `Filed: "T", by Dex. /articles/${REALISTIC_ID}. Stand by.`;
    expect(stripArticlePaths(text)).toBe('Filed: "T", by Dex. Stand by.');
  });

  it("is a no-op (aside from whitespace collapsing/trimming) when there is no path", () => {
    expect(stripArticlePaths("No path here at all.")).toBe("No path here at all.");
    expect(stripArticlePaths("  Extra   spaces   collapse.  ")).toBe("Extra spaces collapse.");
  });

  it("removes the path when it is the very last thing in the string, trailing period and all", () => {
    const text = `Read it now. /articles/${REALISTIC_ID}.`;
    expect(stripArticlePaths(text)).toBe("Read it now.");
  });
});
