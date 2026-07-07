import { betterAuth } from "better-auth";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { components, internal } from "./_generated/api";
import { query } from "./_generated/server";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

// SITE_URL must be set in your Convex environment (e.g. http://localhost:3000 in
// dev, https://ffsn.ai in prod). Better Auth uses it as the OAuth/callback base.
const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";

// The Better Auth <-> Convex bridge. Its own user/session/account tables live in
// the component namespace (see convex/convex.config.ts). App data (leagues,
// teams, credits) stays in convex/schema.ts and is linked to the auth identity
// via users.clerkId === ctx.auth.getUserIdentity().subject (see convex/users.ts).
export const authComponent = createClient<DataModel>(components.betterAuth, {
  verbose: false,
});

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    // Allow linking a social account to an existing email/password account.
    account: {
      accountLinking: {
        enabled: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      // Flip to true once you have wired a verification email + template. Kept
      // false so the migration works before that is set up.
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) => {
        await requireActionCtx(ctx).runAction(internal.betterAuthEmail.sendAuthEmail, {
          to: user.email,
          subject: "Reset your FFSN password",
          text: `Reset your FFSN password with this link:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        });
      },
    },
    // Social providers are only enabled when their credentials are present, so
    // the app runs fine before you add them. Set the *_CLIENT_ID / *_CLIENT_SECRET
    // env vars in your Convex + hosting dashboards to turn each one on.
    socialProviders: {
      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
    },
    plugins: [convex({ authConfig })],
  });

// Reactive helper used by the client AuthBoundary (optional).
export const { getAuthUser } = authComponent.clientApi();

// The Better Auth user for the current request, or undefined when signed out.
export const getCurrentAuthUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.safeGetAuthUser(ctx);
  },
});
