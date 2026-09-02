import { PersonaAvatar } from "./PersonaAvatar";
import { cn } from "@/lib/utils";

export interface WriterPlateProps {
  /** The writer's display name, e.g. `Rick "Two Beers" O'Sullivan`. Also used to match the `PersonaAvatar` illustration. */
  persona: string;
  /** Lineup position, e.g. `1` (rendered as "01") or a pre-formatted string. */
  index: number | string;
  tagline: string;
  /** Beats, joined with " · ", e.g. `["Mock drafts", "Draft grades"]`. */
  beat: string[];
  /** Role label in the red strip, e.g. "The Draft Disaster". */
  role: string;
  className?: string;
}

function formatIndex(index: number | string) {
  return typeof index === "number" ? String(index).padStart(2, "0") : index;
}

/**
 * The on-air-talent lineup card: a 300px portrait with a faint index number,
 * a name plate + red role strip, an italic tagline, and a "Writes" beat line.
 */
export function WriterPlate({ persona, index, tagline, beat, role, className }: WriterPlateProps) {
  return (
    <div className={cn("flex flex-col border border-bc-hairline bg-bc-panel", className)}>
      <div className="bc-scan relative h-[240px] flex-none overflow-hidden bg-bc-panel-2 lg:h-[260px]">
        <span
          className="bc-outline-num absolute top-1.5 left-3 text-[76px] opacity-[0.12] sm:text-[84px]"
          aria-hidden="true"
        >
          {formatIndex(index)}
        </span>
        <PersonaAvatar persona={persona} variant="portrait" className="absolute inset-0" />
      </div>
      <div className="flex flex-1 flex-col gap-3.5 p-4 sm:p-5">
        <div className="flex flex-col">
          <div className="flex items-stretch">
            <div className="w-1.5 flex-none bg-bc-red" aria-hidden="true" />
            <div className="flex-1 bg-bc-plate px-3 py-1.5 font-display text-[19px] leading-[1.02] font-extrabold text-bc-plate-fg uppercase">
              {persona}
            </div>
          </div>
          <div className="bc-label-sm flex items-center bg-bc-red py-1.5 pr-3 pl-4 text-[13px] text-white">
            {role}
          </div>
        </div>
        <p className="font-display text-[17px] leading-[1.15] font-bold text-bc-ink italic">
          {tagline}
        </p>
        <div className="mt-auto flex flex-col gap-1.5 border-t border-bc-hairline pt-2.5">
          <span className="bc-label-sm text-[12px] text-bc-text-3">Writes</span>
          <span className="text-[14px] leading-relaxed text-bc-ink">{beat.join(" · ")}</span>
        </div>
      </div>
    </div>
  );
}
