"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Chip } from "@/components/broadcast";
import { formatWeekRange } from "./calendarFormat";
import { EntryRow } from "./EntryRow";
import type { CalendarWeek } from "./types";

export interface WeekSectionProps {
  week: CalendarWeek;
  timeZone: string;
  isCurrent: boolean;
  /** Past weeks collapse by default; current and future weeks open. */
  defaultOpen: boolean;
}

/** One NFL week of the season: a collapsible header (range, phase, "current" marker) over
 * its entries, sorted by print time. */
export function WeekSection({ week, timeZone, isCurrent, defaultOpen }: WeekSectionProps) {
  // `defaultOpen` only seeds the initial state — once the manager toggles a week, that
  // stays put across re-renders instead of snapping back (a plain `open={defaultOpen}`
  // with no `onToggle` would fight the browser's own toggle on the next unrelated render).
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group border border-bc-hairline bg-bc-panel"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="bc-h-title text-[18px] sm:text-[20px]">
            Week {week.week} <span className="text-bc-text-3">&middot;</span>{" "}
            {formatWeekRange(week.start, week.end, timeZone)}
          </span>
          {week.phase === "playoffs" && <Chip variant="signal">Playoffs</Chip>}
          {week.phase === "championship" && <Chip variant="default">Championship</Chip>}
          {isCurrent && (
            <Chip variant="signal" live>
              Current week
            </Chip>
          )}
        </div>
        <ChevronDown
          className="size-4 flex-none text-bc-text-3 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-bc-hairline px-4 py-1 sm:px-5">
        {week.entries.length === 0 ? (
          <p className="py-3 text-[14px] text-bc-text-3">Nothing scheduled.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-bc-hairline">
            {week.entries.map((entry) => (
              <EntryRow key={entry.key} entry={entry} timeZone={timeZone} />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
