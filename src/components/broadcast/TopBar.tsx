import type { ReactNode } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";

import { BrandLogo } from "./BrandLogo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface TopBarNavItem {
  label: string;
  href: string;
  /** Marks the link as the current page (red 3px underline). */
  active?: boolean;
}

export interface TopBarProps {
  /** Left title block, next to the logo divider. Plain strings get default condensed styling; pass a pre-styled node for anything custom. */
  title?: ReactNode;
  /** Small muted line under the title. */
  subtitle?: ReactNode;
  /** Where the logo links to. Pass `null` for a non-link mark. */
  logoHref?: string | null;
  logoSize?: "sm" | "md" | "lg";
  /** Optional center nav. Renders inline on desktop (md+) and collapses into a Sheet with a hamburger on mobile. */
  nav?: TopBarNavItem[];
  /** Right-side slot: buttons, avatar, theme toggle, notifications, etc. */
  children?: ReactNode;
  /** Sheet header label used when `title` isn't a plain string. */
  mobileNavLabel?: string;
  /** Classes for the divider + title block, e.g. `hidden md:flex` to drop a decorative title on phones. */
  titleClassName?: string;
  /** Extra controls rendered at the bottom of the mobile nav Sheet (sign-in, theme toggle…). */
  mobileExtra?: ReactNode;
  className?: string;
}

/**
 * The 76px Broadcast header bar. Left = logo + divider + title/subtitle,
 * center = optional nav (collapses to a Sheet on mobile), right = a free
 * `children` slot.
 */
export function TopBar({
  title,
  subtitle,
  logoHref = "/",
  logoSize = "lg",
  nav,
  children,
  mobileNavLabel = "Menu",
  titleClassName,
  mobileExtra,
  className,
}: TopBarProps) {
  return (
    <div
      className={cn(
        "flex h-[64px] items-center justify-between gap-4 border-b sm:h-[70px] border-bc-hairline bg-bc-ground px-4 sm:px-6 lg:px-12",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-5">
        <BrandLogo size={logoSize} href={logoHref} />
        {(title || subtitle) && (
          <div className={cn("flex min-w-0 items-center gap-3 sm:gap-5", titleClassName)}>
            <div
              className="hidden h-8 w-px flex-none bg-bc-hairline sm:block"
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-col justify-center gap-0.5">
              {title && (
                <div className="truncate font-display text-[17px] leading-tight font-bold tracking-wide text-bc-ink uppercase sm:text-[20px]">
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="bc-label-sm truncate text-bc-text-3">{subtitle}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {nav && nav.length > 0 && (
        <nav className="hidden flex-none items-center gap-1 md:flex" aria-label="Primary">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "inline-flex h-10 items-center border-b-[3px] px-2.5 font-display text-[15px] font-semibold tracking-[0.08em] uppercase",
                item.active
                  ? "border-bc-red text-bc-ink"
                  : "border-transparent text-bc-text-2 hover:text-bc-ink"
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}

      <div className="flex flex-none items-center justify-end gap-2 sm:gap-3">
        {children}
        {nav && nav.length > 0 && (
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="md:hidden"
                aria-label="Open menu"
              >
                <Menu className="size-5" strokeWidth={1.8} />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-[300px] gap-0 border-bc-hairline bg-bc-ground p-0 sm:w-[340px]"
            >
              <SheetHeader className="border-b border-bc-hairline p-5">
                <SheetTitle className="bc-label text-bc-ink">
                  {typeof title === "string" ? title : mobileNavLabel}
                </SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col p-3" aria-label="Mobile">
                {nav.map((item) => (
                  <SheetClose asChild key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={item.active ? "page" : undefined}
                      className={cn(
                        "flex h-11 items-center px-3 font-display text-[17px] font-semibold tracking-[0.06em] uppercase",
                        item.active
                          ? "bg-bc-panel-2 text-bc-ink"
                          : "text-bc-text-2 hover:bg-bc-panel-2 hover:text-bc-ink"
                      )}
                    >
                      {item.label}
                    </Link>
                  </SheetClose>
                ))}
              </nav>
              {mobileExtra && (
                <div className="mt-auto flex flex-col gap-2 border-t border-bc-hairline p-3">
                  {mobileExtra}
                </div>
              )}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </div>
  );
}
