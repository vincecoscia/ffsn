"use client";

import { useState } from "react";

import { DateTimePicker } from "@/components/ui/date-time-picker";
import { cn } from "@/lib/utils";

/** Nothing can be scheduled inside this window — managers need time to answer. */
export const MIN_LEAD_MS = 15 * 60 * 1000;

type PresetId = "in_2h" | "in_6h" | "tonight" | "tomorrow" | "custom";

interface Preset {
  id: Exclude<PresetId, "custom">;
  label: string;
  /** Resolved against `now`, so the buttons stay honest as the clock moves. */
  resolve: (now: Date) => Date;
}

function at(now: Date, dayOffset: number, hours: number, minutes = 0): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

const PRESETS: Preset[] = [
  { id: "in_2h", label: "In 2 hours", resolve: (now) => new Date(now.getTime() + 2 * 60 * 60 * 1000) },
  { id: "in_6h", label: "In 6 hours", resolve: (now) => new Date(now.getTime() + 6 * 60 * 60 * 1000) },
  { id: "tonight", label: "Tonight 7:00pm", resolve: (now) => at(now, 0, 19) },
  { id: "tomorrow", label: "Tomorrow 9:00am", resolve: (now) => at(now, 1, 9) },
];

/** The preset that ships selected when comment requests are switched on (spec §8.2). */
export const DEFAULT_PRESET: Exclude<PresetId, "custom"> = "in_6h";

/** The default deadline as a concrete time: six hours from now. */
export function defaultPrintDeadline(now: Date = new Date()): Date {
  return PRESETS.find((preset) => preset.id === DEFAULT_PRESET)!.resolve(now);
}

/** "Today at 4:30 PM" / "Thu, Sep 4 at 9:00 AM" — the resolved deadline, in the reader's zone. */
export function formatPrintDeadline(value: Date): string {
  const now = new Date();
  const sameDay =
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate();
  const time = value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    value.getFullYear() === tomorrow.getFullYear() &&
    value.getMonth() === tomorrow.getMonth() &&
    value.getDate() === tomorrow.getDate();
  if (isTomorrow) return `Tomorrow at ${time}`;
  return `${value.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

export interface PrintDeadlineFieldProps {
  value?: Date;
  onChange: (value: Date | undefined) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * "We go to print at" (spec §8.2): four one-tap deadlines and a Custom escape hatch
 * that reveals the existing `DateTimePicker`. The value is always a concrete `Date`,
 * so the form and the mutation keep the same contract they had with the picker; a
 * preset that has already passed (or falls inside the 15-minute minimum) is offered
 * but not selectable.
 */
export function PrintDeadlineField({
  value,
  onChange,
  disabled = false,
  className,
}: PrintDeadlineFieldProps) {
  const [isCustom, setIsCustom] = useState(false);

  // Resolved on every render: the buttons show what each preset means right now, and
  // the click handler re-resolves so the saved deadline is measured from the click.
  const now = new Date();
  const resolved = PRESETS.map((preset) => ({ ...preset, when: preset.resolve(now) }));
  const earliest = now.getTime() + MIN_LEAD_MS;

  // A preset is "selected" when the current value is the time it resolves to, to the
  // minute — the relative presets drift by seconds between render and click.
  const sameMinute = (a: Date, b: Date) =>
    Math.abs(a.getTime() - b.getTime()) < 60 * 1000;
  const activePreset = isCustom
    ? null
    : resolved.find((preset) => value && sameMinute(preset.when, value))?.id ?? null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div role="radiogroup" aria-label="We go to print at" className="flex flex-wrap gap-2">
        {resolved.map((preset) => {
          const tooSoon = preset.when.getTime() < earliest;
          const selected = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || tooSoon}
              title={tooSoon ? "That time has already passed" : formatPrintDeadline(preset.when)}
              onClick={() => {
                setIsCustom(false);
                onChange(preset.resolve(new Date()));
              }}
              className={cn(
                "border px-3.5 py-2 text-[14px] font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-bc-red/30",
                selected
                  ? "border-bc-red bg-bc-red text-white"
                  : "border-bc-hairline bg-bc-panel-2 text-bc-ink hover:border-bc-border-strong",
                (disabled || tooSoon) && "cursor-not-allowed opacity-50 hover:border-bc-hairline",
              )}
            >
              {preset.label}
            </button>
          );
        })}

        <button
          type="button"
          role="radio"
          aria-checked={isCustom}
          disabled={disabled}
          onClick={() => setIsCustom(true)}
          className={cn(
            "border px-3.5 py-2 text-[14px] font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-bc-red/30",
            isCustom
              ? "border-bc-red bg-bc-red text-white"
              : "border-bc-hairline bg-bc-panel-2 text-bc-ink hover:border-bc-border-strong",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          Custom
        </button>
      </div>

      {isCustom && (
        <DateTimePicker
          value={value}
          onChange={onChange}
          placeholder="Pick the deadline"
          disabled={disabled}
          minDate={new Date(earliest)}
        />
      )}
    </div>
  );
}
