// The Wire — timetable extraction (spec §8.3).
//
// A timetable is never a medical guess: it is a phrase ESPN itself wrote, returned verbatim so the
// card can carry it and the take can only repeat it. Pure; no imports.

/**
 * The phrases that count as a timetable, in priority order. A range ("6-8 weeks") is tried before
 * a bare count so "8 weeks" is never lifted out of "6-8 weeks". Every pattern is anchored on word
 * boundaries so "Week 1" and "weekend" do not match.
 */
const TIMETABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b\d+\s*(?:-|–|to)\s*\d+\s*weeks?\b/i,
  /\b\d+\s*weeks?\b/i,
  /\b(?:rest|remainder) of the season\b/i,
  /\bseason[- ]ending\b/i,
  /\bout for the (?:year|season)\b/i,
  /\bweek[- ]to[- ]week\b/i,
  /\bday[- ]to[- ]day\b/i,
  /\bmultiple weeks\b/i,
  /\bindefinitely\b/i,
];

/**
 * The first timetable phrase in `text`, exactly as written (trimmed, never normalised — an en dash
 * stays an en dash), or `undefined` when the text names none. Patterns are tried in
 * {@link TIMETABLE_PATTERNS} order and the first pattern that matches wins.
 */
export function extractTimetable(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const pattern of TIMETABLE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return undefined;
}

/** Whether a timetable phrase means more than one week out (the §7 "multi-week" bonus). */
export function isMultiWeekTimetable(timetable: string | undefined): boolean {
  if (!timetable) return false;
  if (/\b\d+\s*(?:-|–|to)\s*\d+\s*weeks?\b/i.test(timetable)) return true;
  const single = timetable.match(/\b(\d+)\s*weeks?\b/i);
  if (single) return Number(single[1]) >= 2;
  return /\b(?:multiple weeks|(?:rest|remainder) of the season|season[- ]ending|out for the (?:year|season))\b/i.test(
    timetable
  );
}

/** Whether a timetable phrase means the season is over for the player (the §7 OUT-tier base). */
export function isSeasonEndingTimetable(timetable: string | undefined): boolean {
  if (!timetable) return false;
  return /\b(?:season[- ]ending|out for the (?:year|season)|(?:rest|remainder) of the season)\b/i.test(timetable);
}
