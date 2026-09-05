import Link from "next/link";

import { Chip, PersonaAvatar, contentTypeLabel, personaName } from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { describeEntryTiming } from "./calendarFormat";
import { CalendarStatusChip } from "./CalendarStatusChip";
import type { CalendarEntry } from "./types";

export interface EntryRowProps {
  entry: CalendarEntry;
  timeZone: string;
  className?: string;
}

/** One story on the calendar: print time, story + writer, and its status — the same row
 * shape for a week's entries and the "Also this season" undated list. */
export function EntryRow({ entry, timeZone, className }: EntryRowProps) {
  const timing = describeEntryTiming(entry, timeZone);
  const writer = personaName(entry.persona);

  return (
    <li className={`flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4 ${className ?? ""}`}>
      <div className="flex flex-none flex-col sm:w-[176px]">
        <span className="bc-num text-[14px] text-bc-ink">{timing.primary}</span>
        {timing.secondary && (
          <span className="text-[12px] leading-snug text-bc-text-3">{timing.secondary}</span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PersonaAvatar persona={writer} size={32} className="flex-none border border-bc-border-strong" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold text-bc-ink">
            {contentTypeLabel(entry.contentType)}
          </span>
          <span className="truncate text-[13px] text-bc-text-3">{writer}</span>
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2 sm:justify-end">
        {entry.interviews && <Chip variant="signal">Interviews</Chip>}
        {entry.status === "published" && entry.articleId && (
          <Button
            asChild
            variant="link"
            size="sm"
            className="h-6 px-0 font-sans text-[13px] normal-case tracking-normal"
          >
            <Link href={`/articles/${entry.articleId}`}>Read it</Link>
          </Button>
        )}
        <CalendarStatusChip status={entry.status} />
      </div>
    </li>
  );
}
