"use client";

import { useUser } from "@clerk/nextjs";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useRef } from "react";

/**
 * Hook that ensures user is synced between Clerk and Convex
 * and handles proper onboarding redirect flow
 */
export function useAuthSync() {
  const { user: clerkUser, isLoaded } = useUser();
  const currentUser = useQuery(api.users.getCurrentUser);
  const userLeagues = useQuery(api.leagues.getByUser);
  const createOrUpdateUser = useMutation(api.users.createOrUpdateUser);
  const router = useRouter();
  const pathname = usePathname();
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  
  // Use ref to prevent multiple redirects
  const hasRedirected = useRef(false);

  useEffect(() => {
    // Wait for both Clerk, Convex user, and leagues to be loaded
    if (!isLoaded || currentUser === undefined || userLeagues === undefined) return;

    // Don't redirect if we're already on the setup page
    if (pathname === "/setup") return;

    // Prevent multiple executions in Strict Mode
    if (hasRedirected.current) return;

    // Handle invite page separately - just ensure user exists in Convex
    if (pathname.startsWith('/invite/')) {
      if (clerkUser && currentUser === null && !isCreatingUser) {
        console.log("Creating user for invite flow...");
        setIsCreatingUser(true);
        
        createOrUpdateUser({
          email: clerkUser.primaryEmailAddress?.emailAddress,
          name: clerkUser.fullName || `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || undefined,
        })
          .then(() => {
            console.log("User created for invite flow");
            setIsCreatingUser(false);
          })
          .catch((error) => {
            console.error("Error creating user for invite flow:", error);
            setIsCreatingUser(false);
          });
      }
      return;
    }

    // Normal auth flow - if user is authenticated in Clerk but doesn't exist in Convex
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
          hasRedirected.current = true;
          // After user creation, redirect to setup for onboarding
          router.push("/setup");
        })
        .catch((error) => {
          console.error("Error creating user in Convex:", error);
          setIsCreatingUser(false);
        });
    }
    // If user exists but hasn't completed onboarding AND has no leagues
    else if (clerkUser && currentUser && !currentUser.hasCompletedOnboarding && Array.isArray(userLeagues) && userLeagues.length === 0) {
      console.log("User exists but needs to complete onboarding and has no leagues");
      hasRedirected.current = true;
      router.push("/setup");
    }
  }, [clerkUser, isLoaded, currentUser, userLeagues, createOrUpdateUser, router, pathname, isCreatingUser]);

  // Reset redirect flag when pathname changes (for navigation between different routes)
  useEffect(() => {
    hasRedirected.current = false;
  }, [pathname]);

  return {
    clerkUser,
    convexUser: currentUser,
    isLoaded: isLoaded && currentUser !== undefined && userLeagues !== undefined && !isCreatingUser,
    isCreatingUser,
    needsOnboarding: currentUser && !currentUser.hasCompletedOnboarding && userLeagues?.length === 0,
  };
}