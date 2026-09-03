"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Panel, SectionHeader } from "@/components/broadcast";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface SettingsSectionProps {
  /** Anchor id the status board (and any other in-page link) scrolls to. */
  id: string;
  /**
   * Omit for a "bare" section — a plain anchor wrapper around a child that
   * already renders its own `Panel` + `SectionHeader` (e.g. `WeeklyContentCard`,
   * `EspnConnectionCard`, `LeaguePassCard`). Pass it to get the standard
   * `Panel` + `SectionHeader` chrome for section content that doesn't already
   * have its own card.
   */
  title?: ReactNode;
  kicker?: ReactNode;
  description?: ReactNode;
  /**
   * Right-side header slot. Only meaningful with `title`. Collapsible
   * sections render this inside the trigger `<button>` — keep it to
   * non-interactive content (text, chips) there, since a nested `<button>`
   * inside a `<button>` is invalid HTML.
   */
  actions?: ReactNode;
  /** Wrap the section in a Radix Collapsible. Only meaningful with `title`. */
  collapsible?: boolean;
  /** Starting open state for a collapsible section. Default `true`. */
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The settings page's section wrapper: gives every section a stable scroll
 * anchor (`id` + `tabIndex={-1}` + `scroll-mt` so a fixed header doesn't
 * cover the target), and — when `title` is given — the shared `Panel` +
 * `SectionHeader` chrome, optionally collapsible.
 *
 * A collapsed section's children are not rendered (Radix `CollapsibleContent`
 * unmounts them), so any queries inside only run once the section is opened.
 */
export function SettingsSection({
  id,
  title,
  kicker,
  description,
  actions,
  collapsible = false,
  defaultOpen = true,
  className,
  children,
}: SettingsSectionProps) {
  if (!title) {
    return (
      <div id={id} tabIndex={-1} className={cn("scroll-mt-24 flex flex-col gap-4 outline-none", className)}>
        {children}
      </div>
    );
  }

  if (!collapsible) {
    return (
      <Panel padding="md" id={id} tabIndex={-1} className={cn("scroll-mt-24 outline-none", className)}>
        <SectionHeader title={title} kicker={kicker} actions={actions} />
        {description && (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-bc-text-2">{description}</p>
        )}
        <div className="mt-6 flex flex-col gap-6">{children}</div>
      </Panel>
    );
  }

  return (
    <Panel padding="md" id={id} tabIndex={-1} className={cn("scroll-mt-24 outline-none", className)}>
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger
          className="group flex w-full items-center justify-between gap-4 border-b-2 border-bc-hairline pb-3 text-left"
        >
          <div className="flex min-w-0 max-w-full shrink-0 flex-col gap-1.5">
            {kicker && <span className="bc-label-sm text-bc-text-3">{kicker}</span>}
            <span className="bc-h-title max-w-full">
              <span className="min-w-0 truncate">{title}</span>
            </span>
          </div>
          <div className="ml-auto flex flex-none items-center gap-3">
            {actions}
            <ChevronDown
              className="size-5 flex-none text-bc-text-3 transition-transform duration-200 group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {description && (
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-bc-text-2">{description}</p>
          )}
          <div className="mt-6 flex flex-col gap-6">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </Panel>
  );
}
