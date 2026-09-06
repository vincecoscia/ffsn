"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export interface TickerItem {
  /** Muted condensed key, e.g. "Top score". */
  k: string;
  /** Value text, e.g. "Bijan Mustard". */
  v: ReactNode;
  /** Optional trailing number/stat highlighted in signal blue, e.g. "142.8". */
  n?: string;
  /** When set, the value renders as a link to this href. */
  href?: string;
}

export interface TickerProps {
  items: TickerItem[];
  /** Red label plate on the left. */
  label?: string;
  /** Scroll speed in CSS pixels per second. */
  speed?: number;
  className?: string;
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The 36px scrolling feed strip: a red label plate with a pulsing dot, then a
 * horizontally looping track of stat items separated by red diamonds.
 *
 * The item sequence is measured and repeated enough times to always cover the
 * strip, and the animation shifts by exactly one sequence width at a constant
 * speed, so the loop is seamless whether there is one item or thirty. Hover
 * pauses it; reduced-motion users get a static strip (see globals.css).
 */
export function Ticker({ items, label = "League feed", speed = 90, className }: TickerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sequenceRef = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(2);
  const [sequenceWidth, setSequenceWidth] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current;
    const sequence = sequenceRef.current;
    if (!viewport || !sequence) return;

    const measure = () => {
      const seqW = sequence.getBoundingClientRect().width;
      const viewW = viewport.getBoundingClientRect().width;
      if (seqW === 0) return;
      setSequenceWidth(seqW);
      // Enough copies to cover the strip plus one extra so the reset never shows a gap.
      setCopies(Math.max(2, Math.ceil(viewW / seqW) + 1));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(sequence);
    // Web fonts change the sequence width once they land.
    if (typeof document !== "undefined" && "fonts" in document) {
      document.fonts.ready.then(measure).catch(() => {});
    }
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  const trackStyle = sequenceWidth
    ? ({
        "--bc-ticker-shift": `${-sequenceWidth}px`,
        "--bc-ticker-duration": `${Math.max(8, sequenceWidth / speed)}s`,
      } as CSSProperties)
    : undefined;

  const renderSequence = (copy: number) => (
    <div
      key={copy}
      ref={copy === 0 ? sequenceRef : undefined}
      className="flex flex-none items-center gap-7 pr-7"
      aria-hidden={copy > 0 ? true : undefined}
    >
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-7">
          {i > 0 && <span className="bc-sep" aria-hidden="true" />}
          <span className="inline-flex items-baseline gap-2.5 whitespace-nowrap">
            <span className="bc-label-sm text-bc-text-3">{item.k}</span>
            {item.href ? (
              <Link
                href={item.href}
                tabIndex={copy > 0 ? -1 : undefined}
                className="font-display text-[15px] font-semibold tracking-[0.02em] text-bc-ink outline-none focus-visible:ring-[3px] focus-visible:ring-bc-red/50"
              >
                {item.v}
                {item.n !== undefined && <span className="ml-1.5 text-bc-signal">{item.n}</span>}
              </Link>
            ) : (
              <span className="font-display text-[15px] font-semibold tracking-[0.02em] text-bc-ink">
                {item.v}
                {item.n !== undefined && <span className="ml-1.5 text-bc-signal">{item.n}</span>}
              </span>
            )}
          </span>
        </span>
      ))}
      {/* Trailing separator so consecutive copies join like any two items. */}
      <span className="bc-sep" aria-hidden="true" />
    </div>
  );

  return (
    <div
      className={cn(
        "flex h-9 items-stretch overflow-hidden border-b border-bc-hairline bg-bc-panel",
        className
      )}
    >
      <div className="bc-label flex flex-none items-center gap-2 bg-bc-red px-4 text-white">
        <span className="bc-pulse size-[7px] flex-none rounded-full bg-white" aria-hidden="true" />
        {label}
      </div>
      <div ref={viewportRef} className="relative flex min-w-0 flex-1 items-center overflow-hidden">
        <div className="bc-ticker-track pl-6" style={trackStyle}>
          {Array.from({ length: copies }, (_, copy) => renderSequence(copy))}
        </div>
      </div>
    </div>
  );
}
