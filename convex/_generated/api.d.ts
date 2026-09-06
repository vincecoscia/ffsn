/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adminTools from "../adminTools.js";
import type * as aiBatch from "../aiBatch.js";
import type * as aiContent from "../aiContent.js";
import type * as aiContentHelpers from "../aiContentHelpers.js";
import type * as aiContentWithComments from "../aiContentWithComments.js";
import type * as aiNode from "../aiNode.js";
import type * as aiQueries from "../aiQueries.js";
import type * as articleEngagement from "../articleEngagement.js";
import type * as claimRollover from "../claimRollover.js";
import type * as claims from "../claims.js";
import type * as commentConversations from "../commentConversations.js";
import type * as commentRequestTesting from "../commentRequestTesting.js";
import type * as commentRequests from "../commentRequests.js";
import type * as contentCalendar from "../contentCalendar.js";
import type * as contentScheduling from "../contentScheduling.js";
import type * as contentSchedulingIntegration from "../contentSchedulingIntegration.js";
import type * as credits from "../credits.js";
import type * as crons from "../crons.js";
import type * as dataProcessing from "../dataProcessing.js";
import type * as deskMetrics from "../deskMetrics.js";
import type * as devTools from "../devTools.js";
import type * as disputed from "../disputed.js";
import type * as disputedNode from "../disputedNode.js";
import type * as draftRankingsHelpers from "../draftRankingsHelpers.js";
import type * as emailService from "../emailService.js";
import type * as espn from "../espn.js";
import type * as espnCredentialLifecycle from "../espnCredentialLifecycle.js";
import type * as espnNews from "../espnNews.js";
import type * as espnStatsMapping from "../espnStatsMapping.js";
import type * as espnSync from "../espnSync.js";
import type * as inGameInjuries from "../inGameInjuries.js";
import type * as intel from "../intel.js";
import type * as intelSync from "../intelSync.js";
import type * as languageSettings from "../languageSettings.js";
import type * as leagues from "../leagues.js";
import type * as lib_almanacData from "../lib/almanacData.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_contentCalendar from "../lib/contentCalendar.js";
import type * as lib_declineDetection from "../lib/declineDetection.js";
import type * as lib_draftDate from "../lib/draftDate.js";
import type * as lib_draftPhase from "../lib/draftPhase.js";
import type * as lib_espnClient from "../lib/espnClient.js";
import type * as lib_espnConnection from "../lib/espnConnection.js";
import type * as lib_espnSettings from "../lib/espnSettings.js";
import type * as lib_espnTransactions from "../lib/espnTransactions.js";
import type * as lib_feedFreshness from "../lib/feedFreshness.js";
import type * as lib_generationFailure from "../lib/generationFailure.js";
import type * as lib_inGameInjuries from "../lib/inGameInjuries.js";
import type * as lib_intelFreshness from "../lib/intelFreshness.js";
import type * as lib_intelMapping from "../lib/intelMapping.js";
import type * as lib_interviewees from "../lib/interviewees.js";
import type * as lib_leagueCalendar from "../lib/leagueCalendar.js";
import type * as lib_lineupSlots from "../lib/lineupSlots.js";
import type * as lib_matchupSummary from "../lib/matchupSummary.js";
import type * as lib_mockDraftIntel from "../lib/mockDraftIntel.js";
import type * as lib_nodeHelpers from "../lib/nodeHelpers.js";
import type * as lib_playerBoard from "../lib/playerBoard.js";
import type * as lib_playoffTypes from "../lib/playoffTypes.js";
import type * as lib_playoffValidators from "../lib/playoffValidators.js";
import type * as lib_playoffs from "../lib/playoffs.js";
import type * as lib_printTime from "../lib/printTime.js";
import type * as lib_reminderTimes from "../lib/reminderTimes.js";
import type * as lib_season from "../lib/season.js";
import type * as lib_seasonBackfillPlan from "../lib/seasonBackfillPlan.js";
import type * as lib_seasonSyncPlan from "../lib/seasonSyncPlan.js";
import type * as lib_seasonToSync from "../lib/seasonToSync.js";
import type * as lib_seasonWindow from "../lib/seasonWindow.js";
import type * as lib_standingsThroughWeek from "../lib/standingsThroughWeek.js";
import type * as lib_teamClaims from "../lib/teamClaims.js";
import type * as lib_tradesFromTransactions from "../lib/tradesFromTransactions.js";
import type * as lib_weekOneGate from "../lib/weekOneGate.js";
import type * as lib_wireDeskRules from "../lib/wireDeskRules.js";
import type * as lib_wireLeaguePosting from "../lib/wireLeaguePosting.js";
import type * as lib_wireLiveRules from "../lib/wireLiveRules.js";
import type * as lib_wireSocialRules from "../lib/wireSocialRules.js";
import type * as matchupRosters from "../matchupRosters.js";
import type * as matchups from "../matchups.js";
import type * as migrations from "../migrations.js";
import type * as news from "../news.js";
import type * as nflSeasonBoundaries from "../nflSeasonBoundaries.js";
import type * as nflSeasonSetup from "../nflSeasonSetup.js";
import type * as notifications from "../notifications.js";
import type * as payments from "../payments.js";
import type * as playerHistoricalSync from "../playerHistoricalSync.js";
import type * as playerSync from "../playerSync.js";
import type * as playerSyncInternal from "../playerSyncInternal.js";
import type * as players from "../players.js";
import type * as relationships from "../relationships.js";
import type * as rivalries from "../rivalries.js";
import type * as seasonBackfill from "../seasonBackfill.js";
import type * as seasonResults from "../seasonResults.js";
import type * as seasonSync from "../seasonSync.js";
import type * as seasonSyncStatus from "../seasonSyncStatus.js";
import type * as stripe from "../stripe.js";
import type * as teamClaims from "../teamClaims.js";
import type * as teamInvitations from "../teamInvitations.js";
import type * as teams from "../teams.js";
import type * as tradesSync from "../tradesSync.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";
import type * as validators from "../validators.js";
import type * as wire from "../wire.js";
import type * as wireDesk from "../wireDesk.js";
import type * as wireDeskData from "../wireDeskData.js";
import type * as wireDetect from "../wireDetect.js";
import type * as wireDigest from "../wireDigest.js";
import type * as wireGenerate from "../wireGenerate.js";
import type * as wireLive from "../wireLive.js";
import type * as wireLiveData from "../wireLiveData.js";
import type * as wireOverlay from "../wireOverlay.js";
import type * as wireRoutine from "../wireRoutine.js";
import type * as wireSocial from "../wireSocial.js";
import type * as wireSocialData from "../wireSocialData.js";
import type * as wireSourcesNode from "../wireSourcesNode.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  adminTools: typeof adminTools;
  aiBatch: typeof aiBatch;
  aiContent: typeof aiContent;
  aiContentHelpers: typeof aiContentHelpers;
  aiContentWithComments: typeof aiContentWithComments;
  aiNode: typeof aiNode;
  aiQueries: typeof aiQueries;
  articleEngagement: typeof articleEngagement;
  claimRollover: typeof claimRollover;
  claims: typeof claims;
  commentConversations: typeof commentConversations;
  commentRequestTesting: typeof commentRequestTesting;
  commentRequests: typeof commentRequests;
  contentCalendar: typeof contentCalendar;
  contentScheduling: typeof contentScheduling;
  contentSchedulingIntegration: typeof contentSchedulingIntegration;
  credits: typeof credits;
  crons: typeof crons;
  dataProcessing: typeof dataProcessing;
  deskMetrics: typeof deskMetrics;
  devTools: typeof devTools;
  disputed: typeof disputed;
  disputedNode: typeof disputedNode;
  draftRankingsHelpers: typeof draftRankingsHelpers;
  emailService: typeof emailService;
  espn: typeof espn;
  espnCredentialLifecycle: typeof espnCredentialLifecycle;
  espnNews: typeof espnNews;
  espnStatsMapping: typeof espnStatsMapping;
  espnSync: typeof espnSync;
  inGameInjuries: typeof inGameInjuries;
  intel: typeof intel;
  intelSync: typeof intelSync;
  languageSettings: typeof languageSettings;
  leagues: typeof leagues;
  "lib/almanacData": typeof lib_almanacData;
  "lib/auth": typeof lib_auth;
  "lib/contentCalendar": typeof lib_contentCalendar;
  "lib/declineDetection": typeof lib_declineDetection;
  "lib/draftDate": typeof lib_draftDate;
  "lib/draftPhase": typeof lib_draftPhase;
  "lib/espnClient": typeof lib_espnClient;
  "lib/espnConnection": typeof lib_espnConnection;
  "lib/espnSettings": typeof lib_espnSettings;
  "lib/espnTransactions": typeof lib_espnTransactions;
  "lib/feedFreshness": typeof lib_feedFreshness;
  "lib/generationFailure": typeof lib_generationFailure;
  "lib/inGameInjuries": typeof lib_inGameInjuries;
  "lib/intelFreshness": typeof lib_intelFreshness;
  "lib/intelMapping": typeof lib_intelMapping;
  "lib/interviewees": typeof lib_interviewees;
  "lib/leagueCalendar": typeof lib_leagueCalendar;
  "lib/lineupSlots": typeof lib_lineupSlots;
  "lib/matchupSummary": typeof lib_matchupSummary;
  "lib/mockDraftIntel": typeof lib_mockDraftIntel;
  "lib/nodeHelpers": typeof lib_nodeHelpers;
  "lib/playerBoard": typeof lib_playerBoard;
  "lib/playoffTypes": typeof lib_playoffTypes;
  "lib/playoffValidators": typeof lib_playoffValidators;
  "lib/playoffs": typeof lib_playoffs;
  "lib/printTime": typeof lib_printTime;
  "lib/reminderTimes": typeof lib_reminderTimes;
  "lib/season": typeof lib_season;
  "lib/seasonBackfillPlan": typeof lib_seasonBackfillPlan;
  "lib/seasonSyncPlan": typeof lib_seasonSyncPlan;
  "lib/seasonToSync": typeof lib_seasonToSync;
  "lib/seasonWindow": typeof lib_seasonWindow;
  "lib/standingsThroughWeek": typeof lib_standingsThroughWeek;
  "lib/teamClaims": typeof lib_teamClaims;
  "lib/tradesFromTransactions": typeof lib_tradesFromTransactions;
  "lib/weekOneGate": typeof lib_weekOneGate;
  "lib/wireDeskRules": typeof lib_wireDeskRules;
  "lib/wireLeaguePosting": typeof lib_wireLeaguePosting;
  "lib/wireLiveRules": typeof lib_wireLiveRules;
  "lib/wireSocialRules": typeof lib_wireSocialRules;
  matchupRosters: typeof matchupRosters;
  matchups: typeof matchups;
  migrations: typeof migrations;
  news: typeof news;
  nflSeasonBoundaries: typeof nflSeasonBoundaries;
  nflSeasonSetup: typeof nflSeasonSetup;
  notifications: typeof notifications;
  payments: typeof payments;
  playerHistoricalSync: typeof playerHistoricalSync;
  playerSync: typeof playerSync;
  playerSyncInternal: typeof playerSyncInternal;
  players: typeof players;
  relationships: typeof relationships;
  rivalries: typeof rivalries;
  seasonBackfill: typeof seasonBackfill;
  seasonResults: typeof seasonResults;
  seasonSync: typeof seasonSync;
  seasonSyncStatus: typeof seasonSyncStatus;
  stripe: typeof stripe;
  teamClaims: typeof teamClaims;
  teamInvitations: typeof teamInvitations;
  teams: typeof teams;
  tradesSync: typeof tradesSync;
  transactions: typeof transactions;
  users: typeof users;
  validators: typeof validators;
  wire: typeof wire;
  wireDesk: typeof wireDesk;
  wireDeskData: typeof wireDeskData;
  wireDetect: typeof wireDetect;
  wireDigest: typeof wireDigest;
  wireGenerate: typeof wireGenerate;
  wireLive: typeof wireLive;
  wireLiveData: typeof wireLiveData;
  wireOverlay: typeof wireOverlay;
  wireRoutine: typeof wireRoutine;
  wireSocial: typeof wireSocial;
  wireSocialData: typeof wireSocialData;
  wireSourcesNode: typeof wireSourcesNode;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
