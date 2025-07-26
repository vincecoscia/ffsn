"use client";

import { useUser } from "@clerk/nextjs";
import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect, useState, useRef } from "react";

/**
 * Hook that ensures user is synced between Clerk and Convex
 */
export function useAuthSync() {
  const { user: clerkUser, isLoaded: clerkLoaded } = useUser();
  const { isLoading: convexLoading, isAuthenticated: convexAuthenticated } = useConvexAuth();
  const currentUser = useQuery(api.users.getCurrentUser);
  const createOrUpdateUser = useMutation(api.users.createOrUpdateUser);
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const creationAttemptedRef = useRef(false);

  useEffect(() => {
    // Wait for all auth systems to be ready
    if (!clerkLoaded || convexLoading) return;
    
    // If Clerk user exists but Convex isn't authenticated yet, wait
    if (clerkUser && !convexAuthenticated) return;
    
    // Wait for currentUser query to resolve
    if (currentUser === undefined) return;

    // Only sync if we have a Clerk user, no Convex user, and haven't attempted creation
    if (clerkUser && currentUser === null && !isCreatingUser && !creationAttemptedRef.current) {
      console.log("User authenticated in Clerk but not found in Convex. Creating user...");
      setIsCreatingUser(true);
      creationAttemptedRef.current = true;
      
      createOrUpdateUser({
        email: clerkUser.primaryEmailAddress?.emailAddress,
        name: clerkUser.fullName || `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || undefined,
      })
        .then(() => {
          console.log("User created successfully in Convex");
          setIsCreatingUser(false);
        })
        .catch((error) => {
          console.error("Error creating user in Convex:", error);
          setIsCreatingUser(false);
          // Reset the ref on error to allow retry
          creationAttemptedRef.current = false;
        });
    }
    
    // Reset creation attempt when user changes
    if (!clerkUser && creationAttemptedRef.current) {
      creationAttemptedRef.current = false;
    }
  }, [clerkUser, clerkLoaded, convexLoading, convexAuthenticated, currentUser, createOrUpdateUser, isCreatingUser]);


  return {
    clerkUser,
    convexUser: currentUser,
    isLoaded: clerkLoaded && !convexLoading && (currentUser !== undefined || !clerkUser) && !isCreatingUser,
    isCreatingUser,
  };
}