import Link from "next/link";
import { Plus } from "lucide-react";
import { UserButton } from "@clerk/nextjs";

import { TopBar } from "./TopBar";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "@/components/ui/button";

export interface DashboardHeaderProps {
  /** Where "New league" links to. Defaults to `/setup`. */
  newLeagueHref?: string;
  className?: string;
}

/** Header for the dashboard shell: title, a "New league" action, theme toggle and user menu. */
export function DashboardHeader({ newLeagueHref = "/setup", className }: DashboardHeaderProps) {
  return (
    <TopBar
      title="Your leagues"
      subtitle="Fantasy Football Sports Network"
      className={className}
    >
      <Button asChild size="sm" className="hidden sm:inline-flex">
        <Link href={newLeagueHref}>
          <Plus className="size-4" strokeWidth={2} />
          New league
        </Link>
      </Button>
      <Button asChild size="icon-sm" className="sm:hidden" aria-label="New league">
        <Link href={newLeagueHref}>
          <Plus className="size-4" strokeWidth={2} />
        </Link>
      </Button>
      <ThemeToggle />
      <UserButton />
    </TopBar>
  );
}
