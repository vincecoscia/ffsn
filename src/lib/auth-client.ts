"use client";

import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

// Browser Better Auth client. It talks to the Next.js route handler at
// /api/auth/[...all], which proxies to the Better Auth routes mounted on the
// Convex deployment (see convex/http.ts). The convexClient() plugin keeps the
// Convex React client's auth token in sync with the Better Auth session.
export const authClient = createAuthClient({
  plugins: [convexClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
