"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { UserButton } from "@clerk/nextjs";

import { TopBar } from "./TopBar";
import { Ticker, type TickerItem } from "./Ticker";
import { ThemeToggle } from "./ThemeToggle";
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

export interface AppHeaderNavItem {
  label: string;
  href: string;
  /** Require an exact pathname match instead of a `startsWith` prefix match. */
  exact?: boolean;
}

export interface AppHeaderProps {
  leagueName: string;
  leagueMeta?: ReactNode;
  /** Where the league name links to (the league's home page). */
  homeHref: string;
  nav: AppHeaderNavItem[];
  /** Right side of row 2, e.g. week chips. Hidden on mobile along with the nav row. */
  context?: ReactNode;
  ticker?: TickerItem[];
  tickerLabel?: string;
  /** Slot for the existing `NotificationDropdown`, or any bell/menu component. */
  notifications?: ReactNode;
  className?: string;
}

/**
 * The three-row league shell header: TopBar (logo + league name + right-side
 * controls), a 48px primary nav row with active-path detection, and an
 * optional Ticker. On mobile the nav row hides and its items move into a
 * Sheet triggered from the row-1 hamburger.
 */
export function AppHeader({
  leagueName,
  leagueMeta,
  homeHref,
  nav,
  context,
  ticker,
  tickerLabel,
  notifications,
  className,
}: AppHeaderProps) {
  const pathname = usePathname();

  const isActive = (item: AppHeaderNavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <div className={cn("flex flex-col", className)}>
      <TopBar
        title={
          <Link href={homeHref} className="hover:text-bc-red-text">
            {leagueName}
          </Link>
        }
        subtitle={leagueMeta}
        mobileNavLabel={leagueName}
      >
        {notifications}
        <ThemeToggle className="hidden sm:inline-flex" />
        <Sheet>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="md:hidden"
              aria-label="Open league menu"
            >
              <Menu className="size-5" strokeWidth={1.8} />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="w-[300px] gap-0 border-bc-hairline bg-bc-ground p-0 sm:w-[340px]"
          >
            <SheetHeader className="border-b border-bc-hairline p-5">
              <SheetTitle className="font-display text-[17px] font-bold tracking-wide text-bc-ink uppercase">
                {leagueName}
              </SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col p-3" aria-label="League">
              {nav.map((item) => {
                const active = isActive(item);
                return (
                  <SheetClose asChild key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-11 items-center px-3 font-display text-[17px] font-semibold tracking-[0.06em] uppercase",
                        active
                          ? "bg-bc-panel-2 text-bc-ink"
                          : "text-bc-text-2 hover:bg-bc-panel-2 hover:text-bc-ink"
                      )}
                    >
                      {item.label}
                    </Link>
                  </SheetClose>
                );
              })}
            </nav>
            <div className="mt-auto flex items-center justify-between border-t border-bc-hairline p-4">
              <span className="bc-label-sm text-bc-text-3">Theme</span>
              <ThemeToggle />
            </div>
          </SheetContent>
        </Sheet>
        <UserButton />
      </TopBar>

      <div className="hidden h-11 items-center justify-between gap-4 border-b border-bc-hairline bg-bc-ground px-4 sm:px-6 md:flex lg:px-12">
        <nav className="flex h-11 items-center gap-0.5" aria-label="League">
          {nav.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 items-center border-b-[3px] px-2 font-display text-[14px] font-semibold tracking-[0.08em] uppercase lg:px-2.5 xl:text-[15px]",
                  active
                    ? "border-bc-red text-bc-ink"
                    : "border-transparent text-bc-text-2 hover:text-bc-ink"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        {context && <div className="flex flex-none items-center gap-2.5">{context}</div>}
      </div>

      {ticker && ticker.length > 0 && <Ticker items={ticker} label={tickerLabel} />}
    </div>
  );
}
