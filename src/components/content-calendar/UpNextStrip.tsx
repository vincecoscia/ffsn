import { Panel, SectionHeader, PersonaAvatar, contentTypeLabel, personaName } from "@/components/broadcast";
import { formatPrintTime } from "@/components/content-schedule/scheduleTime";
import { CalendarStatusChip } from "./CalendarStatusChip";
import type { CalendarEntry } from "./types";

export interface UpNextStripProps {
  /** Already filtered to future, dated entries and sorted by `at` — pass at most 3. */
  entries: CalendarEntry[];
  timeZone: string;
  className?: string;
}

/** The "this week / next up" strip: the next few stories the desk will print, so a manager
 * sees at a glance what's already coming before they spend credits on it themselves. */
export function UpNextStrip({ entries, timeZone, className }: UpNextStripProps) {
  if (entries.length === 0) return null;

  return (
    <Panel padding="md" className={className}>
      <SectionHeader kicker="On deck" title="Next up" />
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {entries.map((entry) => {
          const writer = personaName(entry.persona);
          return (
            <div
              key={entry.key}
              className="flex flex-col gap-2.5 border border-bc-hairline bg-bc-ground p-4"
            >
              <div className="flex items-center gap-2.5">
                <PersonaAvatar
                  persona={writer}
                  size={28}
                  className="flex-none border border-bc-border-strong"
                />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-semibold text-bc-ink">
                    {contentTypeLabel(entry.contentType)}
                  </span>
                  <span className="truncate text-[12px] text-bc-text-3">{writer}</span>
                </div>
              </div>
              <span className="bc-num text-[13px] text-bc-ink">
                {entry.at != null ? formatPrintTime(entry.at, timeZone) : "—"}
              </span>
              <CalendarStatusChip status={entry.status} className="self-start" />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
