"use client";

import { useAuthSync } from "@/hooks/use-auth-sync";

/**
 * Component that handles authentication synchronization between Clerk and Convex
 * Should be included in the root layout to ensure users are properly synced
 */
export function AuthSync({ children }: { children: React.ReactNode }) {
  useAuthSync();
  return <>{children}</>;
}