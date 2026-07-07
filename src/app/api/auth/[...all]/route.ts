import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

// Proxies Better Auth requests (sign-in, sign-up, OAuth callbacks, session,
// sign-out) to the Better Auth routes mounted on the Convex deployment.
//
// Requires two env vars:
//   NEXT_PUBLIC_CONVEX_URL       -> https://<deployment>.convex.cloud
//   NEXT_PUBLIC_CONVEX_SITE_URL  -> https://<deployment>.convex.site (HTTP actions)
const { handler } = convexBetterAuthNextJs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
});

export const { GET, POST } = handler;
