/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as aiContent from "../aiContent.js";
import type * as crons from "../crons.js";
import type * as espn from "../espn.js";
import type * as espnNews from "../espnNews.js";
import type * as espnSync from "../espnSync.js";
import type * as leagues from "../leagues.js";
import type * as matchups from "../matchups.js";
import type * as news from "../news.js";
import type * as playerHistoricalSync from "../playerHistoricalSync.js";
import type * as playerSync from "../playerSync.js";
import type * as playerSyncInternal from "../playerSyncInternal.js";
import type * as teamClaims from "../teamClaims.js";
import type * as teamInvitations from "../teamInvitations.js";
import type * as teams from "../teams.js";
import type * as users from "../users.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  aiContent: typeof aiContent;
  crons: typeof crons;
  espn: typeof espn;
  espnNews: typeof espnNews;
  espnSync: typeof espnSync;
  leagues: typeof leagues;
  matchups: typeof matchups;
  news: typeof news;
  playerHistoricalSync: typeof playerHistoricalSync;
  playerSync: typeof playerSync;
  playerSyncInternal: typeof playerSyncInternal;
  teamClaims: typeof teamClaims;
  teamInvitations: typeof teamInvitations;
  teams: typeof teams;
  users: typeof users;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
