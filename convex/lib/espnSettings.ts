/**
 * Parses ESPN's `settings` blob (the object at `leagueData.settings` from any
 * `view=mSettings` fetch) into a typed, tolerant shape the rest of the app can
 * rely on instead of re-deriving field names from memory at every call site.
 *
 * Ships an audit finding: the previous ad hoc extraction in `convex/espn.ts`
 * read `scheduleSettings.regularSeasonMatchupPeriods` and
 * `scheduleSettings.playoffWeekCount`, neither of which ESPN emits (verified
 * against production data - every stored season showed the hard-coded
 * defaults, 14/3/standard). The real fields are `matchupPeriodCount`,
 * `playoffMatchupPeriodLength` x rounds, and `scoringItems[statId=53].points`
 * for PPR-ness. See `tests/espnSettings.test.ts` for a real ESPN response
 * (`tests/fixtures/espn-settings-public-2025.json`) exercised end to end.
 *
 * This module is intentionally pure - no imports from `./_generated/api` or
 * any other `convex/*.ts` module that itself references `internal`/`api` (see
 * the same rule documented in `./espnClient.ts`). Every `convex/*.ts` module
 * imports this one as a plain value; if it pulled in `internal` transitively,
 * the generated `api` type would become recursive (TS7022/7023).
 */

import { v, type Infer } from "convex/values";

// ---------------------------------------------------------------------------
// Validators (also the schema for `leagues.mirrorSeasonSettings`'s `settings`
// arg - see `convex/leagues.ts`). Keeping the validator and the parser in the
// same file means the parser's output can never silently drift out of sync
// with the type callers of `mirrorSeasonSettings` are required to send.
// ---------------------------------------------------------------------------

/** One ESPN division (`scheduleSettings.divisions[]`). `size` isn't always present. */
export const divisionValidator = v.object({
  id: v.number(),
  name: v.string(),
  size: v.optional(v.number()),
});

/** How waiver claims are resolved in this league. */
export const waiverTypeValidator = v.union(
  v.literal("faab"),
  v.literal("waivers"),
  v.literal("free_agency")
);

/** The subset of ESPN's `draftSettings` worth surfacing outside a raw blob. */
export const draftSettingsValidator = v.object({
  date: v.optional(v.number()),
  type: v.optional(v.string()),
  timePerSelection: v.optional(v.number()),
  keeperCount: v.optional(v.number()),
  orderType: v.optional(v.string()),
});

/**
 * `scoringSettings.scoringItems[].points` for `statId` 53 (receptions):
 * 1 -> full PPR, 0.5 -> half PPR, 0/absent -> standard, any other positive
 * value (0.25, 0.75, ...) -> a custom reception bonus that doesn't fit the
 * three standard buckets. `receptionPoints` on the parsed object always
 * carries the raw number regardless of which bucket it lands in.
 */
export const scoringTypeValidator = v.union(
  v.literal("ppr"),
  v.literal("half_ppr"),
  v.literal("standard"),
  v.literal("custom")
);

export const parsedLeagueSettingsValidator = v.object({
  name: v.optional(v.string()),
  size: v.optional(v.number()),
  scoringType: scoringTypeValidator,
  /** Raw ESPN enum, e.g. "H2H_POINTS" | "H2H_CATEGORY" | "ROTO". */
  scoringSystem: v.optional(v.string()),
  receptionPoints: v.optional(v.number()),
  regularSeasonMatchupPeriods: v.optional(v.number()),
  playoffTeamCount: v.optional(v.number()),
  /** Weeks per playoff round (1 or 2). */
  playoffMatchupPeriodLength: v.optional(v.number()),
  /** ceil(log2(playoffTeamCount)); undefined when `playoffTeamCount` is unknown. */
  playoffRounds: v.optional(v.number()),
  /** Raw ESPN enum, e.g. "H2H_RECORD" | "TOTAL_POINTS_SCORED" | "DIVISION_WINNERS". */
  playoffSeedingRule: v.optional(v.string()),
  playoffReseed: v.optional(v.boolean()),
  divisions: v.optional(v.array(divisionValidator)),
  /** Matchup period (as its string key) -> the NFL scoring periods it spans, ascending. */
  matchupPeriods: v.optional(v.record(v.string(), v.array(v.number()))),
  /** Human slot name (QB, RB, FLEX, D/ST, BENCH, IR, ...) -> roster-slot count. */
  lineupSlots: v.optional(v.record(v.string(), v.number())),
  /** True when the OP slot is used, or there are 2+ dedicated QB slots. */
  isSuperflex: v.optional(v.boolean()),
  /** True when any individual-defensive-player slot (DT/DE/LB/DL/CB/S/DB/DP/EDR) has a nonzero count. */
  hasIdp: v.optional(v.boolean()),
  waiverType: v.optional(waiverTypeValidator),
  faabBudget: v.optional(v.number()),
  waiverHours: v.optional(v.number()),
  /** Epoch ms. */
  tradeDeadline: v.optional(v.number()),
  vetoVotesRequired: v.optional(v.number()),
  draft: v.optional(draftSettingsValidator),
});

export type ParsedLeagueSettings = Infer<typeof parsedLeagueSettingsValidator>;

// ---------------------------------------------------------------------------
// The `leagues.settings` mirror subset (see `convex/leagues.ts`'s
// `mirrorSeasonSettings`). `scoringType`, `regularSeasonMatchupPeriods`, and
// `playoffTeamCount` are deliberately excluded from this list even though
// `mirrorSeasonSettings` refreshes them too: those three fields already
// existed on `leagues.settings` before this module (with types the setup
// wizard's `leagues.create` call still relies on), so they need no schema
// addition - only the fields below are new columns `convex/schema.ts` adds.
// ---------------------------------------------------------------------------

export const MIRRORED_LEAGUE_SETTINGS_KEYS = [
  "scoringType",
  "scoringSystem",
  "receptionPoints",
  "regularSeasonMatchupPeriods",
  "playoffTeamCount",
  "playoffMatchupPeriodLength",
  "playoffRounds",
  "playoffSeedingRule",
  "playoffReseed",
  "divisions",
  "matchupPeriods",
  "lineupSlots",
  "isSuperflex",
  "hasIdp",
  "waiverType",
  "faabBudget",
  "waiverHours",
  "tradeDeadline",
] as const satisfies readonly (keyof ParsedLeagueSettings)[];

export type MirroredLeagueSettingsKey = (typeof MIRRORED_LEAGUE_SETTINGS_KEYS)[number];

/**
 * Picks the `leagues.settings`-mirrorable subset of a parsed settings object,
 * dropping any key whose value is `undefined` (so a `mirrorSeasonSettings`
 * caller's spread-over-existing-settings never resets a field ESPN simply
 * didn't include in one particular sync).
 */
export function pickMirroredLeagueSettings(
  parsed: ParsedLeagueSettings
): Partial<Pick<ParsedLeagueSettings, MirroredLeagueSettingsKey>> {
  const picked: Partial<Pick<ParsedLeagueSettings, MirroredLeagueSettingsKey>> = {};
  for (const key of MIRRORED_LEAGUE_SETTINGS_KEYS) {
    // `scoringType` always resolves to a bucket (defaulting to "standard")
    // even when `settings` was empty or malformed - it's the one
    // `ParsedLeagueSettings` field that's never itself `undefined`. Only
    // trust it enough to mirror when the raw ESPN scoring enum
    // (`scoringSystem`, i.e. `scoringSettings.scoringType` actually being
    // present) backs it up, so a partial/failed parse can never silently
    // downgrade a league's stored scoring type to "standard".
    if (key === "scoringType" && parsed.scoringSystem === undefined) continue;
    const value = parsed[key];
    if (value !== undefined) {
      (picked as Record<string, unknown>)[key] = value;
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Slot id -> human name. Ids and names per the audit's field list, plus `1`
// (TQB - "Team QB", a single quarterback-only slot some leagues use instead
// of a plain QB slot; not in the audit's list but genuinely emitted by ESPN -
// see `tests/fixtures/espn-settings-public-2025.json`). An id ESPN adds later
// falls back to `SLOT_<id>` rather than being dropped.
// ---------------------------------------------------------------------------
const SLOT_ID_NAMES: Record<number, string> = {
  0: "QB",
  1: "TQB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP",
  16: "D/ST",
  17: "K",
  18: "P",
  19: "HC",
  20: "BENCH",
  21: "IR",
  23: "FLEX",
  24: "EDR",
};

/** Individual-defensive-player slot names (by the human name `SLOT_ID_NAMES` maps to). */
const IDP_SLOT_NAMES = new Set(["DT", "DE", "LB", "DL", "CB", "S", "DB", "DP", "EDR"]);

// ---------------------------------------------------------------------------
// Tolerant readers - `settings` is `unknown` because it round-trips through
// `JSON.parse` on a third party's response with no contract of its own.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Parses ESPN's `settings` blob into `ParsedLeagueSettings`. Tolerant of a
 * missing/malformed `settings` value and of any missing nested section -
 * every field besides `scoringType` (which always resolves to one of the
 * four buckets, defaulting to `"standard"`) is optional on the result.
 */
export function parseEspnLeagueSettings(settings: unknown): ParsedLeagueSettings {
  const root = isRecord(settings) ? settings : {};

  const scoringSettings = isRecord(root.scoringSettings) ? root.scoringSettings : {};
  const scheduleSettings = isRecord(root.scheduleSettings) ? root.scheduleSettings : {};
  const rosterSettings = isRecord(root.rosterSettings) ? root.rosterSettings : {};
  const acquisitionSettings = isRecord(root.acquisitionSettings) ? root.acquisitionSettings : {};
  const tradeSettings = isRecord(root.tradeSettings) ? root.tradeSettings : {};
  const draftSettingsRaw = isRecord(root.draftSettings) ? root.draftSettings : {};

  // --- Scoring --------------------------------------------------------------
  const scoringSystem = asString(scoringSettings.scoringType);
  const scoringItems = Array.isArray(scoringSettings.scoringItems)
    ? scoringSettings.scoringItems
    : [];
  const receptionItem = scoringItems.find(
    (item): item is Record<string, unknown> => isRecord(item) && asNumber(item.statId) === 53
  );
  const receptionPoints = receptionItem ? asNumber(receptionItem.points) : undefined;
  const scoringType: ParsedLeagueSettings["scoringType"] =
    receptionPoints === 1
      ? "ppr"
      : receptionPoints === 0.5
        ? "half_ppr"
        : receptionPoints === undefined || receptionPoints === 0
          ? "standard"
          : "custom";

  // --- Schedule / playoffs ----------------------------------------------------
  const regularSeasonMatchupPeriods = asNumber(scheduleSettings.matchupPeriodCount);
  const playoffTeamCount = asNumber(scheduleSettings.playoffTeamCount);
  const playoffMatchupPeriodLength = asNumber(scheduleSettings.playoffMatchupPeriodLength);
  const playoffRounds =
    playoffTeamCount !== undefined && playoffTeamCount > 0
      ? Math.ceil(Math.log2(playoffTeamCount))
      : undefined;
  const playoffSeedingRule = asString(scheduleSettings.playoffSeedingRule);
  const playoffReseed = asBoolean(scheduleSettings.playoffReseed);

  const rawDivisions = Array.isArray(scheduleSettings.divisions) ? scheduleSettings.divisions : [];
  const divisionEntries = rawDivisions
    .filter(isRecord)
    .map((d) => {
      const id = asNumber(d.id);
      const name = asString(d.name);
      if (id === undefined || name === undefined) return undefined;
      const size = asNumber(d.size);
      return size !== undefined ? { id, name, size } : { id, name };
    })
    .filter((d): d is { id: number; name: string; size?: number } => d !== undefined);
  const divisions = divisionEntries.length > 0 ? divisionEntries : undefined;

  const rawMatchupPeriods = isRecord(scheduleSettings.matchupPeriods)
    ? scheduleSettings.matchupPeriods
    : undefined;
  const matchupPeriodEntries = rawMatchupPeriods
    ? Object.entries(rawMatchupPeriods)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([period, weeks]): [string, number[]] => [
          period,
          // ESPN doesn't guarantee scoring periods within a matchup period are
          // sorted (a real two-week playoff round came back as `[16, 15]`).
          weeks.filter((w): w is number => typeof w === "number").sort((a, b) => a - b),
        ])
    : [];
  const matchupPeriods =
    matchupPeriodEntries.length > 0 ? Object.fromEntries(matchupPeriodEntries) : undefined;

  // --- Roster ------------------------------------------------------------------
  const lineupSlotCounts = isRecord(rosterSettings.lineupSlotCounts)
    ? rosterSettings.lineupSlotCounts
    : {};
  const lineupSlotEntries = Object.entries(lineupSlotCounts)
    .map(([slotId, count]): readonly [string, number] | undefined => {
      const numericCount = asNumber(count);
      if (numericCount === undefined) return undefined;
      const name = SLOT_ID_NAMES[Number(slotId)] ?? `SLOT_${slotId}`;
      return [name, numericCount] as const;
    })
    .filter((entry): entry is readonly [string, number] => entry !== undefined);
  const lineupSlots = lineupSlotEntries.length > 0 ? Object.fromEntries(lineupSlotEntries) : undefined;

  const opCount = lineupSlots?.OP ?? 0;
  const qbCount = lineupSlots?.QB ?? 0;
  const isSuperflex = lineupSlots ? opCount > 0 || qbCount >= 2 : undefined;

  const hasIdp = lineupSlots
    ? Object.entries(lineupSlots).some(([name, count]) => IDP_SLOT_NAMES.has(name) && count > 0)
    : undefined;

  // --- Waivers / acquisitions -------------------------------------------------
  const acquisitionType = asString(acquisitionSettings.acquisitionType);
  const isUsingAcquisitionBudget = asBoolean(acquisitionSettings.isUsingAcquisitionBudget);
  let waiverType: ParsedLeagueSettings["waiverType"];
  if (acquisitionType === "FREEAGENCY") {
    waiverType = "free_agency";
  } else if (isUsingAcquisitionBudget === true) {
    waiverType = "faab";
  } else if (acquisitionType?.startsWith("WAIVERS")) {
    waiverType = "waivers";
  }
  const faabBudget = asNumber(acquisitionSettings.acquisitionBudget);
  const waiverHours = asNumber(acquisitionSettings.waiverHours);

  // --- Trade -------------------------------------------------------------------
  const tradeDeadline = asNumber(tradeSettings.deadlineDate);
  const vetoVotesRequired = asNumber(tradeSettings.vetoVotesRequired);

  // --- Draft -------------------------------------------------------------------
  const hasDraftSettings = Object.keys(draftSettingsRaw).length > 0;
  const draft = hasDraftSettings
    ? {
        date: asNumber(draftSettingsRaw.date),
        type: asString(draftSettingsRaw.type),
        timePerSelection: asNumber(draftSettingsRaw.timePerSelection),
        keeperCount: asNumber(draftSettingsRaw.keeperCount),
        orderType: asString(draftSettingsRaw.orderType),
      }
    : undefined;

  return {
    name: asString(root.name),
    size: asNumber(root.size),
    scoringType,
    scoringSystem,
    receptionPoints,
    regularSeasonMatchupPeriods,
    playoffTeamCount,
    playoffMatchupPeriodLength,
    playoffRounds,
    playoffSeedingRule,
    playoffReseed,
    divisions,
    matchupPeriods,
    lineupSlots,
    isSuperflex,
    hasIdp,
    waiverType,
    faabBudget,
    waiverHours,
    tradeDeadline,
    vetoVotesRequired,
    draft,
  };
}

/** The matchup period (as a number) that a given NFL scoring `week` falls in. */
export function weekToMatchupPeriod(
  matchupPeriods: Record<string, number[]> | undefined,
  week: number
): number | undefined {
  if (!matchupPeriods) return undefined;
  for (const [period, weeks] of Object.entries(matchupPeriods)) {
    if (weeks.includes(week)) {
      const periodNum = Number(period);
      return Number.isFinite(periodNum) ? periodNum : undefined;
    }
  }
  return undefined;
}

/** The NFL scoring weeks (ascending) a given matchup `period` spans. */
export function matchupPeriodWeeks(
  matchupPeriods: Record<string, number[]> | undefined,
  period: number
): number[] | undefined {
  return matchupPeriods?.[String(period)];
}

/**
 * The last NFL scoring week of the fantasy championship
 * (`regularSeasonMatchupPeriods + playoffMatchupPeriodLength x playoffRounds`).
 * Undefined when any input is unknown - never guess at a value used to gate
 * "is the season over" logic.
 */
export function fantasyChampionshipWeek(parsed: ParsedLeagueSettings): number | undefined {
  const { regularSeasonMatchupPeriods, playoffMatchupPeriodLength, playoffRounds } = parsed;
  if (
    regularSeasonMatchupPeriods === undefined ||
    playoffMatchupPeriodLength === undefined ||
    playoffRounds === undefined
  ) {
    return undefined;
  }
  return regularSeasonMatchupPeriods + playoffMatchupPeriodLength * playoffRounds;
}

/** A display label for `parsed.scoringType`. */
export function scoringLabel(parsed: ParsedLeagueSettings): "PPR" | "Half-PPR" | "Standard" | "Custom" {
  switch (parsed.scoringType) {
    case "ppr":
      return "PPR";
    case "half_ppr":
      return "Half-PPR";
    case "custom":
      return "Custom";
    default:
      return "Standard";
  }
}
