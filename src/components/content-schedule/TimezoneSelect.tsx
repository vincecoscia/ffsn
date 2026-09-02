"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  supportedTimeZones,
  timeZoneCity,
  timeZoneRegion,
} from "./timezones";
import { timeZoneOffsetLabel } from "./scheduleTime";

/** Rows rendered at once; a longer match list asks for another keystroke instead. */
const MAX_VISIBLE = 80;

export interface TimezoneSelectProps {
  /** IANA zone id. Empty string renders the placeholder (e.g. while detecting). */
  value: string;
  onChange: (timeZone: string) => void;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Labels the trigger for screen readers when there is no visible <Label>. */
  "aria-label"?: string;
}

/**
 * Searchable timezone combobox over every zone the runtime knows
 * (`Intl.supportedValuesOf("timeZone")`, curated fallback list otherwise). Built on
 * Popover + a filtered listbox rather than a native select so ~400 zones stay findable
 * by typing "denver" or "gmt".
 */
export function TimezoneSelect({
  value,
  onChange,
  id,
  disabled,
  placeholder = "Select a timezone",
  className,
  "aria-label": ariaLabel,
}: TimezoneSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;

  const zones = useMemo(() => supportedTimeZones(), []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return zones;
    return zones.filter((zone) => {
      const haystack = `${zone} ${timeZoneCity(zone)} ${timeZoneOffsetLabel(zone)}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [query, zones]);

  const visible = matches.slice(0, MAX_VISIBLE);

  // Open on the current zone so the list starts where the commissioner left it, and drop
  // the search text on close so the next open is a clean list.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      const index = zones.indexOf(value);
      setActiveIndex(index >= 0 ? index : 0);
    } else {
      setQuery("");
      setActiveIndex(0);
    }
  };

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const commit = (zone: string) => {
    onChange(zone);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const zone = visible[activeIndex];
      if (zone) commit(zone);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 border border-bc-border-strong bg-bc-panel-2 px-3 text-left text-[15px] text-bc-ink outline-none transition-[color,box-shadow,border-color]",
            "hover:border-bc-text-3 focus-visible:border-bc-red focus-visible:ring-[3px] focus-visible:ring-bc-red/30",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          {value ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{timeZoneCity(value)}</span>
              <span className="bc-num flex-none text-[13px] text-bc-text-3">
                {timeZoneOffsetLabel(value)}
              </span>
            </span>
          ) : (
            <span className="truncate text-bc-text-3">{placeholder}</span>
          )}
          <ChevronDown className="size-4 flex-none text-bc-text-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-72 rounded-none border-bc-border-strong p-0"
      >
        <div className="flex items-center gap-2 border-b border-bc-hairline px-3 py-2">
          <Search className="size-4 flex-none text-bc-text-3" aria-hidden="true" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search city or GMT offset"
            aria-label="Search timezones"
            aria-controls={listboxId}
            className="h-8 border-0 bg-transparent px-0 text-[14px] focus-visible:border-0 focus-visible:ring-0"
          />
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Timezones"
          className="max-h-64 overflow-y-auto py-1"
        >
          {visible.length === 0 && (
            <p className="px-3 py-6 text-center text-[14px] text-bc-text-3">
              No timezone matches &ldquo;{query}&rdquo;.
            </p>
          )}

          {visible.map((zone, index) => {
            const selected = zone === value;
            const region = timeZoneRegion(zone);
            return (
              <button
                key={zone}
                type="button"
                role="option"
                aria-selected={selected}
                data-index={index}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(zone)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-[14px] text-bc-ink",
                  index === activeIndex && "bg-bc-panel",
                  selected && "text-bc-red-text",
                )}
              >
                <Check
                  className={cn("size-4 flex-none", selected ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{timeZoneCity(zone)}</span>
                  {region && (
                    <span className="block truncate text-[12px] text-bc-text-3">{region}</span>
                  )}
                </span>
                <span className="bc-num flex-none text-[12px] text-bc-text-3">
                  {timeZoneOffsetLabel(zone)}
                </span>
              </button>
            );
          })}

          {matches.length > visible.length && (
            <p className="px-3 py-2 text-[12px] text-bc-text-3">
              {matches.length - visible.length} more &mdash; keep typing to narrow it down.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default TimezoneSelect;
