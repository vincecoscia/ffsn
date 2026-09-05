/**
 * Does a manager's reply amount to "no comment"?
 *
 * Used by `commentConversations.processUserResponse` so a bare decline is recorded as a
 * decline instead of becoming a response row. Before this, a reply like "no comment" that
 * the analysis scored off-topic slipped past the decline path, the request completed, and
 * the writer's fallback to the raw reply could quote the manager saying "no comment".
 *
 * Deliberately conservative: short replies only, matched against a fixed phrase list. A
 * long reply that ends in "no further comment" is an answer, not a decline, and is handled
 * by the quotable-segment check in `generateAIFollowUp`.
 */
const DECLINE_PHRASES = [
  "no comment",
  "no comments",
  "pass",
  "i pass",
  "hard pass",
  "i'll pass",
  "not today",
  "no thanks",
  "no thank you",
  "nothing to say",
  "nothing to add",
  "i'd rather not",
  "i would rather not",
  "rather not",
  "decline",
  "i decline",
  "not commenting",
  "no interest",
  "not interested",
  "leave me out",
  "leave me out of it",
  "rather not get into it",
  "not looking to get into it",
  "not going to comment",
  "won't be commenting",
  "no comment today",
  "nope",
];

/**
 * A polite decline runs longer than "no comment" ("Appreciate you reaching out, Sam, but
 * I'd rather not get into it today"), so the test is per sentence: every sentence is either
 * a decline phrase or a short pleasantry. An answer that happens to end "No comment on Mel
 * though" has a real sentence in front of it and is not a decline.
 */
const MAX_DECLINE_WORDS = 24;
const MAX_PLEASANTRY_WORDS = 6;

function normalize(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasDeclinePhrase(sentence: string): boolean {
  return DECLINE_PHRASES.some(
    (phrase) => sentence === phrase || sentence.startsWith(`${phrase} `) || sentence.endsWith(` ${phrase}`) || sentence.includes(` ${phrase} `)
  );
}

export function looksLikeDecline(text: string): boolean {
  const whole = normalize(text);
  if (whole.length === 0 || whole.split(" ").length > MAX_DECLINE_WORDS) return false;
  const sentences = text
    .split(/[.!?]+/)
    .map(normalize)
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return false;
  const declining = sentences.filter(hasDeclinePhrase);
  if (declining.length === 0) return false;
  return sentences.every((s) => hasDeclinePhrase(s) || s.split(" ").length <= MAX_PLEASANTRY_WORDS);
}
