/**
 * ESPN connection health gate (owner directive, Sept 2026): "with no valid
 * private token we should pause all content generation and file a backlog of
 * content that needs to be generated."
 *
 * Pure helpers only - no `internal`/`api` value imports here. Both
 * `contentScheduling.ts` and `aiContent.ts` import from this module; a value
 * import between those two convex/*.ts files (either direction) can make the
 * generated `api` type recursive (TS7022/7023), which is why this logic lives
 * in `convex/lib` instead of being exported from one and imported by the
 * other.
 */

/**
 * True only for a private league whose stored ESPN cookies were rejected on
 * the last probe. A public league is never blocked - it has no cookies to
 * reject - and a private league with `credentialStatus` "valid" or "unknown"
 * (never probed yet) is not blocked either; only a confirmed "invalid" pauses
 * automation.
 */
export function espnConnectionBlocked(
  league:
    | { espnData?: { isPrivate?: boolean; credentialStatus?: string } | null }
    | null
    | undefined,
): boolean {
  const espnData = league?.espnData;
  if (!espnData) return false;
  return espnData.isPrivate === true && espnData.credentialStatus === "invalid";
}

/**
 * Content types that do not read live ESPN league data, so a rejected
 * connection never blocks them (spec section 9.1 / the ESPN connection gate
 * above). Canonical home for this set - `contentScheduling.ts` imports it
 * rather than defining its own copy, so the scheduler gate and manual
 * generation gate (`aiContent.ts`) can never drift apart.
 */
export const FRESHNESS_EXEMPT_CONTENT = new Set([
  "season_welcome",
  "mock_draft",
  "custom_roast",
  "commissioner_corner",
]);
