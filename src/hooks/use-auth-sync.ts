"use client";

import { useUser } from "@clerk/nextjs";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Hook that ensures user is synced between Clerk and Convex
 * and handles proper onboarding redirect flow
 */
export function useAuthSync() {
  const { user: clerkUser, isLoaded } = useUser();
  const currentUser = useQuery(api.users.getCurrentUser);
  const createOrUpdateUser = useMutation(api.users.createOrUpdateUser);
  const router = useRouter();
  const pathname = usePathname();
  const [isCreatingUser, setIsCreatingUser] = useState(false);

  useEffect(() => {
    // Wait for both Clerk and Convex to be loaded
    if (!isLoaded || currentUser === undefined) return;

    // Don't redirect if we're already on the setup page
    if (pathname === "/setup") return;

    // If user is authenticated in Clerk but doesn't exist in Convex
    if (clerkUser && currentUser === null && !isCreatingUser) {
      console.log("User authenticated in Clerk but not found in Convex. Creating user...");
      setIsCreatingUser(true);
      
      createOrUpdateUser({
        email: clerkUser.primaryEmailAddress?.emailAddress,
        name: clerkUser.fullName || `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || undefined,
      })
        .then(() => {
          console.log("User created successfully in Convex");
          setIsCreatingUser(false);
          // After user creation, redirect to setup for onboarding
          router.push("/setup");
        })
        .catch((error) => {
          console.error("Error creating user in Convex:", error);
          setIsCreatingUser(false);
        });
    }
    // If user exists but hasn't completed onboarding
    else if (clerkUser && currentUser && !currentUser.hasCompletedOnboarding) {
      console.log("User exists but needs to complete onboarding");
      router.push("/setup");
    }
  }, [clerkUser, isLoaded, currentUser, createOrUpdateUser, router, pathname, isCreatingUser]);

  return {
    clerkUser,
    convexUser: currentUser,
    isLoaded: isLoaded && currentUser !== undefined && !isCreatingUser,
    isCreatingUser,
    needsOnboarding: currentUser && !currentUser.hasCompletedOnboarding,
  };
}