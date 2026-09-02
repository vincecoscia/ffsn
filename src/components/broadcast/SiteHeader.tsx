"use client";

import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

import { TopBar, type TopBarNavItem } from "./TopBar";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "@/components/ui/button";

const DEFAULT_NAV: TopBarNavItem[] = [
  { label: "Features", href: "#features" },
  { label: "Writers", href: "#writers" },
  { label: "Pricing", href: "#pricing" },
];

export interface SiteHeaderProps {
  nav?: TopBarNavItem[];
  className?: string;
}

/**
 * Marketing header for the public site. Composes `TopBar` with the
 * Features/Writers/Pricing anchor nav and Clerk-aware auth actions.
 */
export function SiteHeader({ nav = DEFAULT_NAV, className }: SiteHeaderProps) {
  return (
    <TopBar
      title={
        <span className="bc-label leading-snug tracking-[0.18em] text-bc-text-3">
          Fantasy Football
          <br />
          <span className="mt-1 inline-block">Sports Network</span>
        </span>
      }
      titleClassName="hidden md:flex"
      nav={nav}
      mobileNavLabel="FFSN"
      className={className}
      mobileExtra={
        <>
          <SignedOut>
            <SignInButton mode="modal">
              <Button type="button" variant="outline" className="w-full">
                Sign in
              </Button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <Button asChild variant="outline" className="w-full">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          </SignedIn>
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="bc-label-sm text-bc-text-3">Theme</span>
            <ThemeToggle />
          </div>
        </>
      }
    >
      <SignedOut>
        <SignInButton mode="modal">
          <Button type="button" variant="outline" size="sm" className="hidden sm:inline-flex">
            Sign in
          </Button>
        </SignInButton>
        <SignUpButton mode="modal">
          <Button type="button" variant="glow" size="sm">
            Get started
          </Button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
          <Link href="/dashboard">Dashboard</Link>
        </Button>
        <UserButton />
      </SignedIn>
      <ThemeToggle className="hidden sm:inline-flex" />
    </TopBar>
  );
}
