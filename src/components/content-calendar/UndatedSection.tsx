import { Panel, SectionHeader } from "@/components/broadcast";
import { EntryRow } from "./EntryRow";
import type { CalendarEntry } from "./types";

export interface UndatedSectionProps {
  entries: CalendarEntry[];
  timeZone: string;
  className?: string;
}

/** "Also this season": event-driven stories (a trade lands, the draft happens) and
 * pre-season pieces that don't belong to any single NFL week. */
export function UndatedSection({ entries, timeZone, className }: UndatedSectionProps) {
  if (entries.length === 0) return null;

  return (
    <Panel padding="md" className={className}>
      <SectionHeader kicker="Not tied to a week" title="Also this season" />
      <ul className="mt-5 flex flex-col divide-y divide-bc-hairline">
        {entries.map((entry) => (
          <EntryRow key={entry.key} entry={entry} timeZone={timeZone} />
        ))}
      </ul>
    </Panel>
  );
}
