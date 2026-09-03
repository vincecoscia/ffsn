import type { ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export type ScoreBugMode = "final" | "projected" | "live";
export type ScoreBugStripTone = "default" | "highlight" | "muted";

export interface ScoreBugTeam {
  name: ReactNode;
  /** Owner / record line, e.g. "Priya Natarajan · 2-1". */
  sub?: ReactNode;
  /** Formatted score text, e.g. "124.6". Omit for a team-only row. */
  score?: ReactNode;
  /** Marks the row as the winner in `mode="final"` (gets the red bar + caret). */
  winner?: boolean;
  /** Optional leading slot (e.g. a `TeamTile`) rendered between the color bar and the name column. */
  leading?: ReactNode;
}

export interface ScoreBugProps {
  home: ScoreBugTeam;
  away: ScoreBugTeam;
  mode?: ScoreBugMode;
  /** Left strip text, e.g. "Week 3 · Final" or "Sun · Projected". */
  strip?: ReactNode;
  /** Right strip text, e.g. "Game of the week". */
  stripRight?: ReactNode;
  stripRightTone?: ScoreBugStripTone;
  /** Wraps the whole bug in a `Link` when given. */
  href?: string;
  className?: string;
}

const STRIP_TONE: Record<ScoreBugStripTone, string> = {
  default: "text-bc-text-3",
  highlight: "text-bc-red-text",
  muted: "text-bc-text-2",
};

function Caret({ className }: { className?: string }) {
  return (
    <svg
      width="9"
      height="11"
      viewBox="0 0 10 12"
      className={cn("flex-none", className)}
      aria-hidden="true"
    >
      <path d="M10 0v12L0 6z" fill="currentColor" />
    </svg>
  );
}

function ScoreBugRow({ team, mode }: { team: ScoreBugTeam; mode: ScoreBugMode }) {
  const isWinner = mode === "final" && !!team.winner;
  const isFinalLoser = mode === "final" && !team.winner;

  return (
    <div
      className={cn(
        "grid min-h-[42px] items-center gap-3 border-t border-bc-hairline pr-3",
        team.leading ? "grid-cols-[5px_auto_1fr_auto]" : "grid-cols-[5px_1fr_auto]"
      )}
    >
      <span className={cn("self-stretch", isWinner ? "bg-bc-red" : "bg-bc-hairline")} />
      {team.leading && <span className="flex flex-none items-center">{team.leading}</span>}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "truncate font-display text-[17px] font-bold tracking-[0.02em] uppercase",
            isFinalLoser ? "text-bc-text-2" : "text-bc-ink"
          )}
        >
          {team.name}
        </span>
        {team.sub && (
          <span className="bc-label-sm text-[11px] tracking-[0.1em] text-bc-text-3">
            {team.sub}
          </span>
        )}
      </span>
      {team.score !== undefined && (
        <span className="flex items-center gap-2">
          {isWinner && <Caret className="text-bc-red" />}
          {mode === "projected" && (
            <span className="bc-label-sm text-[10px] text-bc-text-3">Proj</span>
          )}
          <span
            className={cn(
              "bc-num",
              mode === "projected"
                ? "text-[20px] text-bc-signal"
                : cn("text-[23px] font-extrabold", isFinalLoser ? "text-bc-text-3" : "text-bc-ink")
            )}
          >
            {team.score}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * The broadcast matchup graphic: an optional strip, then two team rows with
 * a winner/loser color bar. In `mode="projected"` scores render lighter in
 * signal blue and no caret/winner marker is drawn.
 * In `mode="live"` both rows render at full final-score weight in ink with no
 * winner marker - nothing has been decided yet, so nobody is dimmed as the loser.
 */
export function ScoreBug({
  home,
  away,
  mode = "final",
  strip,
  stripRight,
  stripRightTone = "default",
  href,
  className,
}: ScoreBugProps) {
  const content = (
    <div className={cn("flex flex-col border border-bc-hairline bg-bc-ground", className)}>
      {(strip || stripRight) && (
        <div className="bc-label-sm flex h-6 items-center justify-between bg-bc-panel-2 px-3 text-bc-text-3">
          <span>{strip}</span>
          {stripRight && <span className={STRIP_TONE[stripRightTone]}>{stripRight}</span>}
        </div>
      )}
      <ScoreBugRow team={home} mode={mode} />
      <ScoreBugRow team={away} mode={mode} />
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block transition-opacity hover:opacity-90">
        {content}
      </Link>
    );
  }

  return content;
}
