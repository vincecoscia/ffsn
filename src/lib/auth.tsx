"use client";

// Clerk-compatibility shim backed by Better Auth.
//
// The app previously imported these symbols from "@clerk/nextjs". To keep the
// Clerk -> Better Auth migration mechanical, this module re-exports the same
// names with the same shapes, backed by the Better Auth session. Callsites only
// had their import path swapped from "@clerk/nextjs" to "@/lib/auth".
//
// New code should prefer `authClient` / `useSession` from "@/lib/auth-client"
// directly; this shim exists to bound the migration blast radius.

import Link from "next/link";
import { type ReactNode } from "react";
import { authClient } from "./auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut } from "lucide-react";

type ClerkishUser = {
  id: string;
  primaryEmailAddress: { emailAddress: string } | null;
  emailAddresses: { emailAddress: string }[];
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | undefined;
};

function toClerkishUser(u: {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}): ClerkishUser {
  const name = u.name ?? "";
  const [firstName, ...rest] = name.split(" ");
  return {
    id: u.id,
    primaryEmailAddress: u.email ? { emailAddress: u.email } : null,
    emailAddresses: u.email ? [{ emailAddress: u.email }] : [],
    fullName: u.name ?? null,
    firstName: firstName || null,
    lastName: rest.join(" ") || null,
    imageUrl: u.image ?? undefined,
  };
}

/** Clerk-compatible useUser(). */
export function useUser() {
  const { data: session, isPending } = authClient.useSession();
  const raw = session?.user;
  return {
    user: raw ? toClerkishUser(raw) : null,
    isLoaded: !isPending,
    isSignedIn: !!raw,
  };
}

/** Clerk-compatible useAuth(). */
export function useAuth() {
  const { data: session, isPending } = authClient.useSession();
  return {
    userId: session?.user?.id ?? null,
    isLoaded: !isPending,
    isSignedIn: !!session?.user,
    signOut: () => authClient.signOut(),
  };
}

export function SignedIn({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  return isLoaded && isSignedIn ? <>{children}</> : null;
}

export function SignedOut({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  return isLoaded && !isSignedIn ? <>{children}</> : null;
}

export function SignInButton({ children }: { children?: ReactNode }) {
  return <Link href="/sign-in">{children ?? "Sign in"}</Link>;
}

export function SignUpButton({ children }: { children?: ReactNode }) {
  return <Link href="/sign-up">{children ?? "Sign up"}</Link>;
}

/** Clerk-compatible UserButton: avatar + sign-out menu. */
export function UserButton() {
  const { user } = useUser();
  if (!user) return null;
  const initial =
    user.firstName?.[0] ?? user.primaryEmailAddress?.emailAddress?.[0] ?? "U";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="outline-none">
        <Avatar className="h-8 w-8 cursor-pointer">
          {user.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
          <AvatarFallback>{initial.toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Account"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            authClient.signOut({
              fetchOptions: {
                onSuccess: () => {
                  window.location.href = "/sign-in";
                },
              },
            })
          }
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
