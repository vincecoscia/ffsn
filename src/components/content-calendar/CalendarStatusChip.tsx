import { Chip, type ChipProps } from "@/components/broadcast";
import type { CalendarEntryStatus } from "./types";

interface StatusDisplay {
  label: string;
  variant: NonNullable<ChipProps["variant"]>;
  live?: boolean;
}

/**
 * Spec: published (win/green), pending/generating/batched read as "scheduled" (signal blue,
 * generating pulses), projected reads as "on the schedule" (hairline outline), failed/
 * cancelled/backlogged in red, skipped muted.
 */
const STATUS_DISPLAY: Record<CalendarEntryStatus, StatusDisplay> = {
  projected: { label: "On the schedule", variant: "outline" },
  pending: { label: "Scheduled", variant: "signal" },
  generating: { label: "Generating", variant: "signal", live: true },
  batched: { label: "Scheduled", variant: "signal" },
  published: { label: "Published", variant: "win" },
  failed: { label: "Failed", variant: "red" },
  cancelled: { label: "Cancelled", variant: "red" },
  backlogged: { label: "Backlogged", variant: "red" },
  skipped: { label: "Skipped", variant: "muted" },
};

export function calendarStatusLabel(status: CalendarEntryStatus): string {
  return STATUS_DISPLAY[status].label;
}

export function CalendarStatusChip({
  status,
  className,
}: {
  status: CalendarEntryStatus;
  className?: string;
}) {
  const display = STATUS_DISPLAY[status];
  return (
    <Chip variant={display.variant} live={display.live} className={className}>
      {display.label}
    </Chip>
  );
}
