import { PersonaAvatar } from "./PersonaAvatar";
import { personaName, personaRole } from "./personaRoster";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type RelationshipTier = "feud" | "cold" | "neutral" | "warm" | "favorite";

/** One ledger entry behind the score (`relationshipEvents`). */
export interface RelationshipMeterEvent {
  delta: number;
  /** The sentence or quote that moved the score. */
  evidence: string;
  week?: number;
  type?: string;
}

export interface RelationshipMeterProps {
  /** Writer slug, e.g. `"mel-diaper"`. Name and role are resolved from the roster. */
  persona: string;
  /** Score in [-100, 100]. */
  score: number;
  tier: RelationshipTier;
  /** Ledger entries, newest first. At most `maxEvents` are shown. */
  events?: RelationshipMeterEvent[];
  /** Default 3. Pass 0 to hide the "recent" list entirely. */
  maxEvents?: number;
  /** Override the resolved display name (e.g. for a retired byline). */
  name?: string;
  className?: string;
}

const TIER_STOPS: Array<{ tier: RelationshipTier; label: string }> = [
  { tier: "feud", label: "Feud" },
  { tier: "cold", label: "Cold" },
  { tier: "neutral", label: "Neutral" },
  { tier: "warm", label: "Warm" },
  { tier: "favorite", label: "Favorite" },
];

const TIER_BADGE = {
  feud: "red",
  cold: "outline",
  neutral: "secondary",
  warm: "signal",
  favorite: "win",
} as const satisfies Record<RelationshipTier, "red" | "outline" | "secondary" | "signal" | "win">;

/** Tier label, e.g. `"favorite"` -> `"Favorite"`. */
export function relationshipTierLabel(tier: RelationshipTier): string {
  return TIER_STOPS.find((stop) => stop.tier === tier)?.label ?? tier;
}

/** Signed score with a real minus sign: `-6` -> `"−6"`, `6` -> `"+6"`. */
export function formatDelta(delta: number): string {
  const rounded = Math.round(delta);
  return rounded < 0 ? `−${Math.abs(rounded)}` : `+${rounded}`;
}

function deltaTone(delta: number): string {
  if (delta > 0) return "text-bc-win";
  if (delta < 0) return "text-bc-red-text";
  return "text-bc-text-3";
}

/**
 * The five-stop relationship meter (spec §6.5): the writer's bust and name plate,
 * the current tier, a marker at the score, and the most recent evidence lines.
 * Presentational only — pass rows straight from `relationships.getMyRelationships`
 * or `getTeamRelationships`.
 */
export function RelationshipMeter({
  persona,
  score,
  tier,
  events,
  maxEvents = 3,
  name,
  className,
}: RelationshipMeterProps) {
  const clamped = Math.max(-100, Math.min(100, score));
  const markerPercent = (clamped + 100) / 2;
  const activeIndex = TIER_STOPS.findIndex((stop) => stop.tier === tier);
  const recent = maxEvents > 0 ? (events ?? []).slice(0, maxEvents) : [];

  return (
    <div className={cn("flex flex-col gap-3 border border-bc-hairline bg-bc-panel p-3.5", className)}>
      {/* Name plate */}
      <div className="flex items-center gap-3">
        <PersonaAvatar
          persona={persona}
          size={40}
          className="flex-none border border-bc-border-strong"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[17px] leading-none font-extrabold tracking-[0.01em] text-bc-ink uppercase">
            {name ?? personaName(persona)}
          </div>
          <div className="bc-label-sm mt-1.5 truncate text-bc-text-3">{personaRole(persona)}</div>
        </div>
        <div className="flex flex-none flex-col items-end gap-1.5">
          <Badge variant={TIER_BADGE[tier]}>{relationshipTierLabel(tier)}</Badge>
          <span className={cn("bc-num text-[15px]", deltaTone(clamped))}>
            {clamped > 0 ? `+${clamped}` : clamped < 0 ? `−${Math.abs(clamped)}` : "0"}
          </span>
        </div>
      </div>

      {/* Meter */}
      <div className="flex flex-col gap-1.5">
        <div
          className="relative h-2.5 w-full"
          role="meter"
          aria-valuemin={-100}
          aria-valuemax={100}
          aria-valuenow={clamped}
          aria-valuetext={`${relationshipTierLabel(tier)}, ${clamped}`}
          aria-label={`${name ?? personaName(persona)} relationship`}
        >
          <div className="absolute inset-0 grid grid-cols-5">
            {TIER_STOPS.map((stop, index) => (
              <span
                key={stop.tier}
                className={cn(
                  "h-full border-r border-bc-panel last:border-r-0",
                  index === activeIndex ? "bg-bc-red" : "bg-bc-border-strong/45",
                )}
              />
            ))}
          </div>
          <span
            className="absolute top-[-3px] bottom-[-3px] w-[3px] -translate-x-1/2 bg-bc-ink"
            style={{ left: `${markerPercent}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="grid grid-cols-5 gap-1">
          {TIER_STOPS.map((stop, index) => (
            <span
              key={stop.tier}
              className={cn(
                "bc-label-sm truncate text-[10px] leading-none",
                index === 0 && "text-left",
                index === TIER_STOPS.length - 1 && "text-right",
                index > 0 && index < TIER_STOPS.length - 1 && "text-center",
                index === activeIndex ? "text-bc-ink" : "text-bc-text-3",
              )}
            >
              {stop.label}
            </span>
          ))}
        </div>
      </div>

      {/* Recent evidence */}
      {recent.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t border-bc-hairline pt-2.5">
          {recent.map((event, index) => (
            <li
              key={`${event.week ?? "x"}-${index}-${event.evidence.slice(0, 12)}`}
              className="flex items-start justify-between gap-3 text-[13px] leading-snug text-bc-text-2"
            >
              <span className="line-clamp-2 min-w-0 flex-1">
                {typeof event.week === "number" && (
                  <span className="bc-label-sm text-bc-text-3">Wk {event.week} &middot; </span>
                )}
                {event.evidence}
              </span>
              <span className={cn("bc-num flex-none text-[13px]", deltaTone(event.delta))}>
                {formatDelta(event.delta)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
