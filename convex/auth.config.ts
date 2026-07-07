import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";

// Convex validates incoming JWTs against this provider. Better Auth issues the
// tokens (its subject becomes ctx.auth.getUserIdentity().subject), replacing the
// previous Clerk provider config.
export default {
  providers: [getAuthConfigProvider()],
};
