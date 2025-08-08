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
import type * as aiContentHelpers from "../aiContentHelpers.js";
import type * as aiQueries from "../aiQueries.js";
import type * as commentConversations from "../commentConversations.js";
import type * as commentRequestTesting from "../commentRequestTesting.js";
import type * as commentRequests from "../commentRequests.js";
import type * as contentScheduling from "../contentScheduling.js";
import type * as contentSchedulingIntegration from "../contentSchedulingIntegration.js";
import type * as crons from "../crons.js";
import type * as dataProcessing from "../dataProcessing.js";
import type * as espn from "../espn.js";
import type * as espnNews from "../espnNews.js";
import type * as espnStatsMapping from "../espnStatsMapping.js";
import type * as espnSync from "../espnSync.js";
import type * as leagues from "../leagues.js";
import type * as matchupRosters from "../matchupRosters.js";
import type * as matchups from "../matchups.js";
import type * as news from "../news.js";
import type * as nflSeasonBoundaries from "../nflSeasonBoundaries.js";
import type * as nflSeasonSetup from "../nflSeasonSetup.js";
import type * as notifications from "../notifications.js";
import type * as playerHistoricalSync from "../playerHistoricalSync.js";
import type * as playerSync from "../playerSync.js";
import type * as playerSyncInternal from "../playerSyncInternal.js";
import type * as rivalries from "../rivalries.js";
import type * as teamClaims from "../teamClaims.js";
import type * as teamInvitations from "../teamInvitations.js";
import type * as teams from "../teams.js";
import type * as transactions from "../transactions.js";
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
  aiContentHelpers: typeof aiContentHelpers;
  aiQueries: typeof aiQueries;
  commentConversations: typeof commentConversations;
  commentRequestTesting: typeof commentRequestTesting;
  commentRequests: typeof commentRequests;
  contentScheduling: typeof contentScheduling;
  contentSchedulingIntegration: typeof contentSchedulingIntegration;
  crons: typeof crons;
  dataProcessing: typeof dataProcessing;
  espn: typeof espn;
  espnNews: typeof espnNews;
  espnStatsMapping: typeof espnStatsMapping;
  espnSync: typeof espnSync;
  leagues: typeof leagues;
  matchupRosters: typeof matchupRosters;
  matchups: typeof matchups;
  news: typeof news;
  nflSeasonBoundaries: typeof nflSeasonBoundaries;
  nflSeasonSetup: typeof nflSeasonSetup;
  notifications: typeof notifications;
  playerHistoricalSync: typeof playerHistoricalSync;
  playerSync: typeof playerSync;
  playerSyncInternal: typeof playerSyncInternal;
  rivalries: typeof rivalries;
  teamClaims: typeof teamClaims;
  teamInvitations: typeof teamInvitations;
  teams: typeof teams;
  transactions: typeof transactions;
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
