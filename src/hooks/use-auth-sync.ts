"use client";

import { useUser } from "@clerk/nextjs";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect, useState } from "react";

/**
 * Hook that ensures user is synced between Clerk and Convex
 */
export function useAuthSync() {
  const { user: clerkUser, isLoaded } = useUser();
  const currentUser = useQuery(api.users.getCurrentUser);
  const createOrUpdateUser = useMutation(api.users.createOrUpdateUser);
  const [isCreatingUser, setIsCreatingUser] = useState(false);

  useEffect(() => {
    // Wait for both Clerk and Convex user to be loaded
    if (!isLoaded || currentUser === undefined) return;

    // Only sync user data between Clerk and Convex - no redirects
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
        })
        .catch((error) => {
          console.error("Error creating user in Convex:", error);
          setIsCreatingUser(false);
        });
    }
  }, [clerkUser, isLoaded, currentUser, createOrUpdateUser, isCreatingUser]);


  return {
    clerkUser,
    convexUser: currentUser,
    isLoaded: isLoaded && currentUser !== undefined && !isCreatingUser,
    isCreatingUser,
  };
}