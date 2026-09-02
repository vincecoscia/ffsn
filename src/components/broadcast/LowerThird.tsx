import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface LowerThirdProps {
  name: ReactNode;
  role?: ReactNode;
  /** Avatar slot, e.g. `<PersonaAvatar persona={p} size={56} variant="bust" />`. Sized 56px (14px in `compact`). */
  avatar?: ReactNode;
  /** Label in the red strip below the plate, e.g. "Weekly recap". Omitted in `compact` mode. */
  tag?: ReactNode;
  /** Secondary text in the red strip, e.g. a pull quote or kicker. */
  note?: ReactNode;
  /** Single-row variant (40px avatar / 18px name, no tag/note strip) for use in lists. */
  compact?: boolean;
  className?: string;
}

/**
 * The broadcast byline graphic: a red bar + an off-white plate holding the
 * avatar, name and role, then (unless `compact`) a red strip carrying a
 * tag and an optional note.
 */
export function LowerThird({ name, role, avatar, tag, note, compact, className }: LowerThirdProps) {
  if (compact) {
    return (
      <div className={cn("inline-flex items-stretch", className)}>
        <div className="w-1.5 flex-none bg-bc-red" aria-hidden="true" />
        <div className="flex items-center gap-3 bg-bc-plate px-3.5 py-1.5 text-bc-plate-fg">
          {avatar && (
            <span className="inline-flex size-10 flex-none items-center justify-center overflow-hidden">
              {avatar}
            </span>
          )}
          <div className="flex flex-col gap-0.5">
            <span className="font-display text-[16px] leading-none font-extrabold tracking-[0.01em] uppercase">
              {name}
            </span>
            {role && <span className="bc-label-sm text-[11px] text-bc-plate-fg/60">{role}</span>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-stretch">
        <div className="w-2 flex-none bg-bc-red" aria-hidden="true" />
        <div className="flex flex-1 items-center gap-3.5 bg-bc-plate px-4 py-2 text-bc-plate-fg">
          {avatar && (
            <span className="inline-flex size-14 flex-none items-center justify-center overflow-hidden">
              {avatar}
            </span>
          )}
          <div className="flex flex-col gap-0.5">
            <span className="font-display text-[21px] leading-none font-extrabold tracking-[0.01em] uppercase sm:text-[22px]">
              {name}
            </span>
            {role && <span className="bc-label-sm text-bc-plate-fg/60">{role}</span>}
          </div>
        </div>
      </div>
      {(tag || note) && (
        <div className="bc-label-sm flex h-7 items-center gap-3 bg-bc-red pr-4 pl-5 text-white">
          {tag && <span>{tag}</span>}
          {tag && note && <span className="h-3.5 w-px flex-none bg-white/35" aria-hidden="true" />}
          {note && <span className="font-semibold tracking-[0.1em] text-white/80">{note}</span>}
        </div>
      )}
    </div>
  );
}
