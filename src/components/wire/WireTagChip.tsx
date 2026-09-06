import type { ComponentProps } from "react";

import { Chip } from "@/components/broadcast";

type ChipVariant = ComponentProps<typeof Chip>["variant"];

/**
 * `tag` is a plain `string` (see `useLeagueWire.ts`'s note on why), so this switches on value
 * rather than indexing a `Record<WireTag, …>` — works identically either way, but doesn't force a
 * cast at the call site.
 */
function variantFor(tag: string): ChipVariant {
  switch (tag) {
    case "LIVE":
      return "signal";
    case "FINAL":
      return "plate";
    case "STATED":
      return "secondary";
    case "OPINION":
      return "red";
    case "UPDATE":
      return "muted";
    default:
      // REPORTED, and anything unexpected.
      return "outline";
  }
}

export interface WireTagChipProps {
  tag: string;
  className?: string;
}

/** One Wire tag (`REPORTED` / `STATED` / `OPINION` / `LIVE` / `FINAL` / `UPDATE`) as a Chip. `LIVE` pulses. */
export function WireTagChip({ tag, className }: WireTagChipProps) {
  return (
    <Chip variant={variantFor(tag)} live={tag === "LIVE"} className={className}>
      {tag}
    </Chip>
  );
}
