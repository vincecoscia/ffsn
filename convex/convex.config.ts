import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

// Registers the Better Auth component. Its tables (user, session, account,
// verification, jwks, ...) live in the component's own namespace and are created
// when you run `npx convex dev` — they are NOT part of convex/schema.ts.
const app = defineApp();
app.use(betterAuth);

export default app;
