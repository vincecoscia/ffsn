"use client";

import { useCallback, useMemo } from "react";
import { useConvexAuth, useQuery, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * These are derived straight from `convex/wire.ts`'s own validators via `FunctionReturnType`,
 * rather than imported from `src/lib/ai/wire/types.ts`. That contract file types `kind`, `tags`,
 * `status`, `source.type` and an overlay's `impact.variant` as literal unions
 * (`GlobalEventKind`, `WireTag[]`, `WirePostStatus`, `WireSourceType`, `OverlayVariant`), but the
 * query validators in `convex/wire.ts` widen every one of those to `v.string()` — so the frontend
 * genuinely receives plain strings for them. Building to `FunctionReturnType` means these types
 * always match exactly what the query returns, and every wire component below compares tag/status/
 * variant values with plain `===`/`switch` (which works on `string` just as well as on a union),
 * so nothing here needed an unsafe cast.
 */
export type WireGlobalPost = FunctionReturnType<typeof api.wire.getGlobalPosts>["page"][number];
export type WireLeaguePost = FunctionReturnType<typeof api.wire.getLeaguePosts>["page"][number];
export type WireStatus = FunctionReturnType<typeof api.wire.getWireStatus>;
export type WireTickerRow = FunctionReturnType<typeof api.wire.getRecentForTicker>[number];

/**
 * Social-layer view shapes (spec §17), also derived from the query validators rather than
 * hand-duplicated — same rationale as the four types above. `WireReplyItem` and
 * `WireReactionsView` are identical whether they came off a global or a league post (both post
 * validators embed the same `replyViewValidator`/`reactionsViewValidator`), so either source type
 * works; `WireLeaguePost` is picked because it's also where `WireAuthorRefView` comes from.
 */
export type WireReplyItem = WireLeaguePost["replies"][number];
export type WireReactionsView = WireLeaguePost["reactions"];
export type WireAuthorRefView = NonNullable<WireLeaguePost["author"]>;
export type WireTeamRefView = NonNullable<WireAuthorRefView["team"]>;

export type WireFeedItem =
  | { scope: "global"; createdAt: number; post: WireGlobalPost }
  | { scope: "league"; createdAt: number; post: WireLeaguePost };

const DEFAULT_PAGE_SIZE = 15;

export interface UseLeagueWireOptions {
  /** Items requested per feed per page. Default 15; the homepage panel passes a small number. */
  pageSize?: number;
}

export interface UseLeagueWireResult {
  /** `undefined` while `wire.getWireStatus` is still loading. */
  status: WireStatus | undefined;
  /** Global posts (with this league's overlays attached when it has a pass) merged with routine
   *  league posts, newest first. Overlays are never listed on their own — see `WireGlobalPost.overlays`. */
  items: WireFeedItem[];
  isLoadingFirstPage: boolean;
  isLoadingMore: boolean;
  canLoadMore: boolean;
  /** Advances whichever of the two underlying paginated queries can still load more. */
  loadMore: () => void;
}

/**
 * Merges the Wire's two paginated feeds — `wire.getGlobalPosts` (global posts, `by_created`) and
 * `wire.getLeaguePosts` (routine league posts only, `by_league_created`) — into one newest-first
 * timeline, client-side, as spec §4 describes. `wire.getLeaguePosts` already returns an empty page
 * for a league without an active pass, and `wire.getGlobalPosts` already omits overlays in that
 * case, so no pass-based filtering is needed here.
 */
export function useLeagueWire(
  leagueId: Id<"leagues">,
  options: UseLeagueWireOptions = {}
): UseLeagueWireResult {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  // On a hard load the Convex client can run queries before Clerk's token is attached; the server
  // answers empty in that case, and skipping until auth is ready avoids the flash (prod, 2026-09-06).
  const { isAuthenticated } = useConvexAuth();
  const queryArgs = isAuthenticated ? { leagueId } : "skip";

  const status = useQuery(api.wire.getWireStatus, queryArgs);

  const global = usePaginatedQuery(api.wire.getGlobalPosts, queryArgs, { initialNumItems: pageSize });
  const league = usePaginatedQuery(api.wire.getLeaguePosts, queryArgs, { initialNumItems: pageSize });

  const items = useMemo<WireFeedItem[]>(() => {
    const merged: WireFeedItem[] = [
      ...global.results.map((post) => ({ scope: "global" as const, createdAt: post.createdAt, post })),
      ...league.results.map((post) => ({ scope: "league" as const, createdAt: post.createdAt, post })),
    ];
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged;
  }, [global.results, league.results]);

  const loadMore = useCallback(() => {
    if (global.status === "CanLoadMore") global.loadMore(pageSize);
    if (league.status === "CanLoadMore") league.loadMore(pageSize);
  }, [global, league, pageSize]);

  return {
    status,
    items,
    isLoadingFirstPage: global.status === "LoadingFirstPage" || league.status === "LoadingFirstPage",
    isLoadingMore: global.status === "LoadingMore" || league.status === "LoadingMore",
    canLoadMore: global.status === "CanLoadMore" || league.status === "CanLoadMore",
    loadMore,
  };
}
