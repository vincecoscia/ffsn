"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PropsWithChildren } from "react";
import { DashboardHeader } from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { LayoutDashboard, Menu, Settings, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Your leagues", href: "/dashboard", icon: LayoutDashboard, exact: true },
  { label: "Credits", href: "/dashboard/credits", icon: Zap, exact: false },
  { label: "Settings", href: "/dashboard/settings/notifications", icon: Settings, exact: false },
];

export default function DashboardLayout({ children }: PropsWithChildren) {
  const pathname = usePathname();

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);

  return (
    <div className="min-h-screen bg-bc-ground">
      <DashboardHeader />

      <div className="flex h-12 items-center justify-between border-b border-bc-hairline bg-bc-ground px-4 sm:px-6 lg:px-12">
        <nav className="hidden items-center gap-1 md:flex" aria-label="Dashboard">
          {NAV_ITEMS.map(({ label, href, exact }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href, exact) ? "page" : undefined}
              className={cn(
                "inline-flex h-12 items-center border-b-[3px] px-3 font-display text-[15px] font-semibold tracking-[0.08em] uppercase",
                isActive(href, exact)
                  ? "border-bc-red text-bc-ink"
                  : "border-transparent text-bc-text-2 hover:text-bc-ink"
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        <span className="bc-label-sm text-bc-text-3 md:hidden">Dashboard</span>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon-sm" className="md:hidden" aria-label="Open menu">
              <Menu className="size-4" strokeWidth={1.8} />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="w-[280px] gap-0 border-bc-hairline bg-bc-ground p-0"
          >
            <SheetHeader className="border-b border-bc-hairline p-5">
              <SheetTitle className="bc-label text-bc-ink">Dashboard</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col p-3" aria-label="Dashboard mobile">
              {NAV_ITEMS.map(({ label, href, icon: Icon, exact }) => (
                <SheetClose asChild key={href}>
                  <Link
                    href={href}
                    aria-current={isActive(href, exact) ? "page" : undefined}
                    className={cn(
                      "flex h-12 items-center gap-3 px-3 font-display text-lg font-semibold tracking-[0.06em] uppercase",
                      isActive(href, exact)
                        ? "bg-bc-panel-2 text-bc-ink"
                        : "text-bc-text-2 hover:bg-bc-panel-2 hover:text-bc-ink"
                    )}
                  >
                    <Icon className="size-4" strokeWidth={1.8} />
                    {label}
                  </Link>
                </SheetClose>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      </div>

      {children}
    </div>
  );
}
