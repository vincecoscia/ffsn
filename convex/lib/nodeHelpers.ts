/**
 * Shared helpers for Convex's Node-runtime ("use node") action files.
 *
 * Plain functions with no "use node" directive of their own - both `convex/aiNode.ts` and
 * `convex/disputedNode.ts` are already "use node", so each pulls these in as a normal dependency
 * of its own bundle instead of keeping a private copy.
 */

/** Read a required environment variable, or throw with a `npx convex env set` hint. */
export function requireEnv(name: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not configured. Set it with: npx convex env set ${name} "..."`);
  }
  return value;
}

/** Strip `undefined` (not a Convex value) before a result crosses the runtime boundary. */
export function toConvexValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
