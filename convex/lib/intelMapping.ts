/**
 * Pure helpers for the player-intelligence sync (`convex/intelSync.ts`):
 * a small CSV parser (nflverse ships `injuries_<season>.csv` and
 * `players.csv`, no new npm dependency) and the name/position normalizer +
 * matcher that maps a Fantasy Football Calculator ADP entry onto the ESPN
 * athlete id `playersEnhanced` and the rest of this codebase key on.
 *
 * Intentionally pure - no imports from `./_generated/api` or any other
 * `convex/*.ts` module that itself references `internal` (see the header
 * comment on `convex/lib/espnClient.ts` for why that matters: it would make
 * the generated `api` type recursive). Every call site imports this module
 * as a plain value.
 */

// --- CSV parsing -----------------------------------------------------
//
// RFC4180-ish: quoted fields, commas and newlines inside quotes, `""` as an
// escaped quote, and both CRLF and bare LF line endings (nflverse's GitHub
// release assets use CRLF; hand-written fixtures in tests use LF).

/** Parse CSV text into rows of raw string cells (header row included, if present). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyContentInRow = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    sawAnyContentInRow = false;
  };

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      sawAnyContentInRow = true;
      i++;
      continue;
    }
    if (char === ",") {
      sawAnyContentInRow = true;
      pushField();
      i++;
      continue;
    }
    if (char === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (char === "\n") {
      pushRow();
      i++;
      continue;
    }

    sawAnyContentInRow = true;
    field += char;
    i++;
  }

  // Trailing field/row when the text doesn't end with a line break.
  if (field.length > 0 || sawAnyContentInRow) {
    pushRow();
  }

  return rows;
}

/** Parse CSV text into header-keyed records. Blank lines are skipped. */
export function parseCsvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const [header, ...rest] = rows;
  const records: Array<Record<string, string>> = [];
  for (const cells of rest) {
    if (cells.length === 1 && cells[0] === "") continue; // stray blank line
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = cells[idx] ?? "";
    });
    records.push(record);
  }
  return records;
}

// --- Name / position normalization -----------------------------------

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Normalize a player's display name for cross-source matching: strips
 * accents/diacritics, lower-cases, drops periods/apostrophes entirely
 * (so "Ja'Marr" and "Jamarr" agree), turns every other non-alphanumeric run
 * (hyphens, commas, slashes) into a single space, and drops a trailing
 * generational suffix (Jr., Sr., II-V) since sources disagree on whether to
 * include one.
 */
export function normalizePlayerName(name: string): string {
  const withoutAccents = (name ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = withoutAccents
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0 && !NAME_SUFFIXES.has(t));
  return tokens.join(" ");
}

/**
 * Normalize a position abbreviation for cross-source matching. FFC uses
 * "PK" for kickers; ESPN's team-defense rows use "D/ST" while other sources
 * ("DST", "DEF") mean the same thing.
 */
export function normalizePosition(position: string): string {
  const upper = (position ?? "").trim().toUpperCase();
  if (upper === "D/ST" || upper === "DST" || upper === "DEF") return "DEF";
  if (upper === "PK") return "K";
  return upper;
}

// --- ESPN player matching ----------------------------------------------

export interface EspnPlayerRef {
  espnId: string;
  fullName: string;
  position: string;
  team?: string;
}

export interface EspnMatchIndex {
  byNamePosition: Map<string, EspnPlayerRef[]>;
  byDefenseTeam: Map<string, EspnPlayerRef>;
}

/**
 * Build a lookup index of ESPN players (typically one season's
 * `playersEnhanced` rows) for matching against another source's player list.
 * Team defenses are indexed separately by team abbreviation: ESPN names them
 * "Seahawks D/ST" while other sources use "Seattle Defense" or similar, so
 * name matching for DEF is a dead end - team is the only reliable key.
 */
export function buildEspnMatchIndex(players: EspnPlayerRef[]): EspnMatchIndex {
  const byNamePosition = new Map<string, EspnPlayerRef[]>();
  const byDefenseTeam = new Map<string, EspnPlayerRef>();

  for (const player of players) {
    const position = normalizePosition(player.position);
    if (position === "DEF") {
      if (player.team) byDefenseTeam.set(player.team.toUpperCase(), player);
      continue;
    }
    const key = `${normalizePlayerName(player.fullName)}|${position}`;
    const existing = byNamePosition.get(key);
    if (existing) existing.push(player);
    else byNamePosition.set(key, [player]);
  }

  return { byNamePosition, byDefenseTeam };
}

export interface MatchCandidate {
  name: string;
  position: string;
  team?: string;
}

/**
 * Resolve another source's player entry to an ESPN athlete id using the
 * index above. Returns `null` when there is no match, or when the name
 * matches more than one ESPN player at that position and `team` isn't
 * enough (or isn't provided) to disambiguate - callers should count these
 * as unmatched rather than guessing.
 */
export function matchPlayerToEspnId(index: EspnMatchIndex, candidate: MatchCandidate): string | null {
  const position = normalizePosition(candidate.position);

  if (position === "DEF") {
    if (!candidate.team) return null;
    return index.byDefenseTeam.get(candidate.team.toUpperCase())?.espnId ?? null;
  }

  const key = `${normalizePlayerName(candidate.name)}|${position}`;
  const matches = index.byNamePosition.get(key);
  if (!matches || matches.length === 0) return null;
  if (matches.length === 1) return matches[0].espnId;

  if (candidate.team) {
    const teamMatches = matches.filter((m) => m.team && m.team.toUpperCase() === candidate.team!.toUpperCase());
    if (teamMatches.length === 1) return teamMatches[0].espnId;
  }

  return null; // Ambiguous: same normalized name + position, no team tiebreak.
}

/**
 * The ESPN id for a feed row: the feed's own `espn_id` when it carries one, else a name +
 * position (+ team) match against this season's ESPN pool. Sleeper's players feed has an
 * `espn_id` for only ~1,470 of ~3,230 active skill players (2026-09-05: Chase, Gibbs, Nacua and
 * Jeanty all lacked one), so without the fallback half the league's stars never get an injury
 * or depth-chart line.
 */
export function resolveEspnId(
  explicitId: number | string | null | undefined,
  candidate: MatchCandidate,
  index: EspnMatchIndex,
): { espnId: string; via: "id" | "name" } | null {
  if (explicitId !== null && explicitId !== undefined && String(explicitId).trim() !== "") {
    return { espnId: String(explicitId).trim(), via: "id" };
  }
  if (!candidate.name || !candidate.position) return null;
  const matched = matchPlayerToEspnId(index, candidate);
  return matched ? { espnId: matched, via: "name" } : null;
}
