# FFSN Code Audit

_Fantasy football league app — Next.js 15 (App Router) · React 19 · Convex · Clerk · Stripe · SendGrid · Anthropic/OpenAI_

**Date:** 2026-07-07
**Scope:** full repository — `convex/` backend, `src/` frontend, config, dependencies, repo hygiene.
**Method:** four parallel specialist passes (Convex backend, Next.js frontend, security/payments, project health), each reading and citing actual code. Highest-risk claims were re-verified by hand.

---

## TL;DR

The app is feature-rich and the "good" auth pattern already exists in the codebase — it's just applied **inconsistently**. The dominant, repeated problem is that **many Convex functions are declared as public `mutation`/`query`/`action` (callable by anyone with the deployment URL) and never call `ctx.auth.getUserIdentity()`**. Because Convex has no other gate, these are directly exploitable today.

**Do not run this in production until the Critical section is fixed.** The most urgent items:

1. **Free money / theft:** public no-auth functions let anyone mint credits (`grantJoinCredits`), drain another user's credits (`deductCredits`), mark payments "succeeded" without paying (`reconcilePayment`, has a literal `// TODO: Add admin authorization check`), and hijack another user's payment (`linkPaymentToLeague`).
2. **Secret leak:** `listLeagues` is a public no-auth query that returns **every** league including plaintext ESPN session cookies (`espnS2`/`swid`).
3. **Data destruction:** public no-auth mutations `clearAllLeagueData` and `cleanupTestData` can wipe league / comment data platform-wide.
4. **Unprotected pages:** `/test-comments` and `/sync` match neither the protected nor public route list in `middleware.ts`, so they render with no login and expose test mutations + PII.
5. **Known CVEs:** `@clerk/nextjs` 6.25.4 and `next` 15.4.3 both carry **critical** advisories (Clerk = middleware route-protection bypass, which is exactly what this app relies on).

Counts across all passes: **~19 Critical · ~15 High · ~24 Medium · ~13 Low**, plus a dozen-plus additional sync functions catalogued in the ESPN-sync appendix. These are grouped by root cause rather than counted per-function — the true number of individually-fixable no-auth endpoints is well over 60. Full detail below.

---

## The root-cause pattern (read this first)

In Convex, `mutation`, `query`, and `action` are **public HTTP endpoints** — any browser that knows your deployment URL can call them with arbitrary arguments. Only `internalMutation`/`internalQuery`/`internalAction` are private. Many functions here take a `userId`/`clerkId`/`leagueId` **as an argument** and trust it, instead of deriving the caller from `ctx.auth.getUserIdentity()`.

The codebase already does this correctly in places — e.g. `leagues.getById`, `leagues.create`, all of `notifications.ts`, `teamInvitations.claimInvitation`, `teams.getByLeague`, and `aiContent.regenerateContentWithCredits` all check identity **and** verify `leagueMemberships`/commissioner role before touching data. The fix for most Critical/High findings is to copy that existing pattern onto the functions that skip it (and to convert sync-/cron-/test-only functions to `internal*`).

---

## Critical

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| C1 | `convex/credits.ts:277` `grantJoinCredits` | Public, no auth; grants 100 credits per unused league for a client-supplied `userId`. Iterate league IDs → unlimited free credits (packs otherwise cost $9.99). | Derive `userId` from `ctx.auth`; verify real membership before granting. |
| C2 | `convex/credits.ts:84` `deductCredits` | Public, no auth, arbitrary `userId` — drain any user's balance to zero (griefing/theft). **Verified.** | Take user from `ctx.auth`, not args; or make `internalMutation`. |
| C3 | `convex/payments.ts:272` `reconcilePayment` | Public mutation with literal `// TODO: Add admin authorization check here` — anyone can mark any payment `succeeded`, triggering free 1000-credit/league grants. **Verified.** | Add admin authorization before status override, or make internal-only. |
| C4 | `convex/payments.ts:114` `linkPaymentToLeague` | Public, no auth — link another user's paid Stripe payment to an attacker-controlled league, hijacking the purchase. | Require auth; only link payments where `payment.userId === identity.subject`. |
| C5 | `convex/payments.ts:249` `getPendingPayments` | Public, no auth — dumps `paymentIntentId`/`userId`/`leagueId` for all pending payments (feeds C3/C4). | Make `internalQuery` or gate behind admin role. |
| C6 | `convex/leagues.ts:139` `listLeagues` | Public, no auth, `.collect()` of **all** leagues incl. plaintext `espnData.espnS2`/`swid` (live ESPN session cookies). **Verified.** | Remove/make internal; if a browse feature is needed, project only non-secret fields. |
| C7 | `convex/leagues.ts:476` `clearAllLeagueData` | Public, no auth — deletes all teams/matchups/seasons/aiContent/weeklyStats for any `leagueId`. | Require auth + commissioner check (copy `refreshLeagueData` at :431). |
| C8 | `convex/teams.ts:349` `updateTeamRoster` | Public, no auth — overwrite any team's entire roster by `teamId`. | Require auth + commissioner/owner check, or make internal. |
| C9 | `convex/stripe.ts:282` `processCheckoutSessionCompleted` | No idempotency guard and doesn't require `paymentStatus === "paid"` before fulfilling; combined with public no-auth `verifyPaymentCompleted` (`stripe.ts:131`), a session can be fulfilled repeatedly / while unpaid. | Short-circuit if already fulfilled; only fulfill when `paymentStatus === "paid"`. |
| C10 | `src/app/api/stripe/webhook/route.ts:41` + `convex/stripe.ts:196` | No event-level idempotency (no dedupe on `event.id`); Stripe's normal re-delivery double-grants credits. | Persist processed `event.id`s and no-op on repeats. |
| C11 | `convex/espnSync.ts` (~15 public exports incl. `updateTeams:518`, `updatePlayers:645`, `updateMatchups:718`, `syncAllLeagueData:1431`, `storeTrades:2882`, `updateLeagueSync:2660`), `convex/playerSyncInternal.ts` (all write mutations, re-exported publicly via `playerSync.ts:92`), `convex/playerHistoricalSync.ts` | Grep-confirmed **none** call `ctx.auth`. Anyone can overwrite any league's teams/matchups/season/draft data or trigger expensive ESPN syncs for an arbitrary `leagueId`. Sync actions read the league via `internal.leagues.getByIdInternal` (`leagues.ts:241`) which does **zero** membership check — an intentional bypass (a code comment at `playerHistoricalSync.ts:371` even says "no identity required"). See the dedicated ESPN-sync appendix below for the full per-function list. | Convert cron/server-only fns to `internal*`; add explicit `ctx.auth` + commissioner check to the handful that must stay public (`syncAllLeagueData`, `syncAllDataWithRosters`, `syncHistoricalLeaguePlayerStats`, `fetchHistoricalRosters`, `fetchDraftDataForSeason`) instead of relying on `getByIdInternal`. |
| C11b | `convex/espnSync.ts:3021` `syncPlayerTransactions` / `:3085` `storePlayerTransactions`; `convex/playerSyncInternal.ts:498` `refreshLeagueTopPerformers`, `:98` `updateLeaguePlayerStatuses` | **Data spoofing, not just missing authz.** These public mutations take `players: v.array(v.any())` fully caller-authored — an attacker injects fabricated "ESPN transactions" / fake top-performer stats / bogus roster-ownership into any league's stored data **without ESPN ever being contacted**, and it renders as real. | Make `internalMutation`; if a public path is needed, re-fetch/verify against ESPN server-side rather than trusting the payload. |
| C11c | `convex/playerHistoricalSync.ts:197` `dailyAllLeaguesPlayerStatsSync`, `:500` `syncAllLeaguesHistoricalPlayerStats`, `convex/espnSync.ts:2150` `syncAllHistoricalPlayerStats` | **Unauthenticated all-leagues DoS/cost bomb.** Zero args, zero auth; each enumerates **every** league (via the also-unauth'd `listLeagues`) and runs full multi-season ESPN resyncs for all of them. Correctly-internal cron twins already exist (`scheduledDailyAllLeaguesSync`) — the public copies are pure exposure. | Delete the public copies / make `internalAction`. |
| C12 | `convex/commentRequestTesting.ts` (entire file — `cleanupTestData:617`, `triggerTestCommentRequests:74`, `simulateUserResponse:263`, `sendPendingRequests:484`, `runEndToEndTest:504`, `debugLeagueData:394`, `getTestingData:328`) | Test scaffolding shipped as **public** functions, no auth. `cleanupTestData` with no args mass-deletes real comment data platform-wide; `debugLeagueData`/`getTestingData` `.collect()` the whole users table and leak name/email/clerkId; the trigger fns cascade into paid AI calls + user emails; `simulateUserResponse` injects fabricated responses into real requests. | Convert all to `internal*` (or delete the file); never `.collect()` the users table. |
| C13 | `convex/commentRequests.ts:1111` `triggerCommentRequests` | Public "admin" mutation, no auth — schedules paid Anthropic calls + notification/email spam for arbitrary content. | Require identity + commissioner role for the target league. |
| C14 | `convex/commentRequests.ts:684` `getConversationContext`, `:1066` `getLeagueCommentRequests` | Public, no auth — leak scores/standings/rosters and enumerate per-user PII (`userName`) for any league. | Require identity + membership/ownership check. |
| C15 | `convex/commentConversations.ts:8` `getActiveRequests`, `:48` `getConversation` | Public, no auth — read any user's active comment conversations and full raw message history by id. | Derive user from `ctx.auth`; verify caller is `targetUserId` or commissioner. |
| C16 | `src/middleware.ts` + `src/app/test-comments/page.tsx` + `src/app/sync/page.tsx` | Middleware only calls `auth.protect()` for routes on an explicit allowlist; `/test-comments` and `/sync` match neither list, so they render with **no login**. `/test-comments` exposes league/user data + test mutations; `/sync` (a leftover demo with a hardcoded placeholder league id) can trigger ESPN sync actions. **Verified matcher is allowlist-only.** | Delete both pages, or add them to `isProtectedRoute`; switch middleware to default-deny (allowlist public routes only). |

## High

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| H1 | `convex/emailService.ts:30` `queueEmail` | Public mutation, arbitrary `to`/`templateId`/`data` — anyone can send SendGrid mail from `support@ffsn.ai` (spam/phishing on your dime). | Make `internalMutation` (callers already use the internal variant) or require auth + recipient allowlist + rate limit. |
| H2 | `convex/credits.ts:188,211,242` (`checkSufficientCredits`, `getUserCredits`, `getCreditHistory`) | Public, no auth, arbitrary `userId` — read any user's balance/transaction history (IDOR). | Require auth; use `identity.subject`. |
| H3 | `convex/payments.ts:191,218,322` (`getUserPaymentHistory`, `getLeaguePaymentStatus`, `getLeaguePaymentStats`) | Public, no auth — IDOR on any user's payment history / any league's stats. | Add auth + ownership/membership check. |
| H4 | `convex/teams.ts:57` `getTeamsByLeague`, `:334` `getBySeasonAndLeague` | Public, no auth — full team/roster data for any league (sibling `getByLeague:28` does it correctly). | Copy the auth+membership check from `getByLeague`. |
| H5 | `convex/users.ts:171` `updateUserPreferences`, `:156` `getUserPreferences` | Public, no auth, arbitrary `clerkId` — read/overwrite another user's preferences (incl. email-notification toggles). | Derive target user from `ctx.auth`, not client-supplied `clerkId`. |
| H6 | `convex/aiContent.ts:169`/`:641` `createGenerationRequest`→`generateContentAction` | Credits are deducted **after** generation and deduction failure is swallowed (`console.warn`) with no upfront balance check — unlimited free paid-AI generation. | Check + deduct credits **before** scheduling (mirror `regenerateContentWithCredits:327`); don't swallow deduction failures. |
| H7 | `convex/leagues.ts:145` `getById` / `:110` `getByUser` | Return the full league object incl. plaintext `espnData.espnS2`/`swid` to **every** league member, not just the owner. | Strip credential fields from member-facing responses. |
| H8 | `convex/schema.ts:55` | ESPN `espnS2`/`swid` stored in plaintext in `leagues`. | Encrypt at rest or store in a restricted secrets table; never return from public queries. |
| H9 | `src/components/AIGenerationPage.tsx:294,347` | `dangerouslySetInnerHTML` renders AI-generated `article.content` that embeds user-supplied names/comments — stored-XSS surface. | Render sanitized markdown (e.g. DOMPurify) instead of raw HTML. |
| H10 | `convex/commentRequests.ts:669,998,1014` (`getRequestsForLeague`, `getActiveRequests`, `getRequestById`) | Public, no auth — leak `targetUserId`/`articleContext`/`aiContext.initialPrompt` for any id. | Add identity + ownership/membership check. |
| H11 | `@clerk/nextjs` 6.25.4 (+ `@clerk/shared`, `@clerk/backend`) | **Critical CVEs** GHSA-vqx2-fgx2-5wq9 (middleware route-protection bypass — exactly this app's model) + GHSA-w24r-5266-9c3c. | `npm audit fix` (→ 6.39.5); the single highest-value dependency action. |
| H12 | `next` 15.4.3 (exact-pinned) | **Critical CVEs**: image-optimization cache-key confusion, RSC cache poisoning, content injection, middleware bypass via segment-prefetch. | Bump to ≥15.5.x manually (pin blocks `audit fix`). |
| H13 | No tests, no CI | No `test` script, zero test files, no framework; no `.github/workflows`. Nothing gates merges; typecheck/lint run only by hand. | Add a CI workflow running `tsc --noEmit` + eslint over **`src/` and `convex/`**; start a smoke-test suite on the payment/credit paths. |
| H14 | `convex/` is unlinted | `npm run lint` = `next lint`, which only covers `src/`. `npx eslint convex/` → **164 errors, 68 warnings** (154 are `no-explicit-any`). The most sensitive code is effectively unlinted. | Lint `convex/` in CI; burn down the `any`s. |

## Medium

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| M1 | `convex/credits.ts:315` `getLeagueCreditStats`, `:315`/`payments.ts:322` | No membership check + unbounded `.collect()` over `creditTransactions` (grows forever). | Add membership check; cache/paginate aggregates. |
| M2 | `convex/teamClaims.ts:162,244,219` (`updateTeamOwnersFromClaims`, `syncAllTeamOwners`, `getTeamsWithUnknownOwners`) | Public, no auth; some `.collect()`+`.filter()` scan the whole `teams` table when `leagueId` omitted. | Add auth + commissioner check; make `leagueId` required; index `owner`. |
| M3 | `convex/dataProcessing.ts:21,89` (`runDataProcessing`, `calculateTeamMetrics`) | Public, no auth — trigger recomputation for any league. | Make `internalMutation` or add commissioner check. |
| M4 | `convex/matchups.ts:41` `getCurrentWeekMatchups` | N+1: separate indexed query per week 1–18 instead of one range query. | One `by_league_season` range query, group in memory. |
| M5 | `convex/matchups.ts:119` `getTopScoresAllTime` (+ lowest/by-season variants) | `.collect()` every matchup across all seasons then sort in memory — risks 8MiB/16k-doc read limits as history grows. | Maintain a precomputed top/bottom cache (pattern already exists for `leagueTopPerformers`). |
| M6 | `convex/schema.ts:204,239,440,446,587` | Multiple `v.any()` fields (`leagueSeasons.settings`/`draftInfo`, `playersEnhanced.stats`, `playerStats.stats`) drop validation, undermining `strict: true`. | Model the stable ESPN shapes with narrower validators. |
| M7 | `convex/commentRequests.ts:49` & `aiContentWithComments.ts:210` | Compares `team.owner` (a Clerk ID string) against a Convex `Id<"users">` — never matches, so `userTeam`/priority logic is silently broken dead code. | Resolve via `teamClaims` (as `getUserTeam:542` does) or remove. |
| M7b | `convex/espnSync.ts:91` `syncLeagueData`, `:1431` `syncAllLeagueData` | Multi-step syncs are separate sequential `runMutation`s, not one transaction — a mid-way failure (e.g. `updateTeams` throws) leaves a committed season doc with no matching teams/matchups; per-year sub-steps in `syncAllLeagueData` **swallow** errors and still report `{success:true}`, so the UI shows success on partial/stale data. | Surface partial-step failures in the return value; consider a saga/cleanup on failure. |
| M7c | `convex/playerSync.ts` `completeLeagueSync:573`, `syncAllPlayers:107`; `playerSyncInternal.ts:282` `getAllPlayersForSeason` | Unbounded `while(hasMore)` pagination loops with no max-iteration cap (DoS if ESPN keeps returning full pages); `getAllPlayersForSeason` filters `season` on an index keyed `(espnId, season)` — an unindexed scan that `.collect()`s the whole season and risks the read-limit as history grows. | Add iteration caps; add a dedicated `by_season` index. |
| M7d | `convex/espnNews.ts:74,149,184`, `convex/matchupRosters.ts:68` `fetchMatchupRosters`, `convex/playerSync.ts:785` `syncLeaguePlayerStats` | Public actions never called from `src/` (only from cron/other actions) — needless attack surface. | Convert to `internalAction`. |
| M8 | Season year `2025` hardcoded in 20+ places | `src/components/LeagueHomepage.tsx`, `LeagueSettingsPage.tsx`, `TeamInviteManager.tsx`, `CommissionerTeamSelection.tsx`, all `leagues/[id]/*/page.tsx`, even UI copy — no single source of truth. | Introduce a `CURRENT_SEASON` constant / derive from league data; replace all literals **before the 2026 rollover silently breaks every page**. |
| M9 | `src/components/LeagueSettingsPage.tsx:93` vs `TeamInviteManager.tsx:98` | Team-invitation creation implemented twice, divergently (Promise.all vs sequential loop), neither validates the email despite zod being available. | Extract one shared `useTeamInvitations` hook; add a `z.string().email()` schema. |
| M10 | Every `src/app/leagues/[id]/*/page.tsx` | Route param force-cast `resolvedParams.id as Id<"leagues">` with no runtime validation — garbage URL segments flow straight into Convex queries. | Validate id shape (zod/`normalizeId`) and render an "invalid league" state. |
| M11 | `next` 15.4.3, `@clerk/nextjs` 6.25.4, `stripe` 18→22, `convex` 1.25→1.42, `zod` 3→4, `@anthropic-ai/sdk` **^0.24.3→0.110** | Majorly outdated core deps; the Anthropic SDK is ~2 years behind and predates the models the code targets (`claude-sonnet-4`). `openai` **is** legitimately used (image gen in `src/lib/ai/image-generator.ts`), so keep both — but update both. | Staged dependency upgrade; prioritize the Anthropic SDK and the CVE'd packages. |
| M12 | `npm audit --omit=dev` | **12 vulns: 3 critical / 5 high / 4 moderate** — Clerk, next, plus high `axios` (SSRF/proto-pollution), `form-data` (CRLF), `js-cookie`. | `npm audit fix` clears most; next requires a manual bump. |

## Low

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| L1 | `convex/leagues.ts:154`, `teamInvitations.ts:151`, `scores/page.tsx:101` | Verbose `console.log` of PII (emails/names/membership) on every call; 101 debug logs across 13 files incl. the Stripe webhook route. | Strip or gate behind a debug flag / logger util. |
| L2 | `convex/debugTeamNames.ts` | 0-byte dead file, still registered in generated API. | Delete. |
| L3 | `convex/espn.ts:8` | User-supplied `leagueId` interpolated into ESPN URL path (host fixed, so limited SSRF; path injection possible). | Validate `leagueId` is numeric before building the URL. |
| L4 | `.serena/cache/.../document_symbols_cache_*.pkl` | **39 MB** binary tool cache committed to git; bloats every clone. | Gitignore + `git rm --cached`. |
| L5 | Repo root | ~20 loose implementation-note `.md` files + `draftGradeTest.json` (52 KB), referenced by nothing. | Move to `docs/` or delete. |
| L6 | `src/app/invite/[token]/page.tsx:47` | Hardcoded `setTimeout(250ms)` as a "wait for Convex reactivity" race workaround. | Await the mutation's returned state / a reactive query instead. |
| L7 | `src/components/notifications/hooks/useNotifications.ts:74` | Redundant client-side re-filter of an already server-filtered `isRead` list. | Keep one source of truth. |
| L8 | `src/components/transactions/TradeCard.tsx:49`, `TransactionCard.tsx:55` | Array-index `key` on player/detail lists where stable IDs exist. | Key by `player.espnId` / detail id. |
| L9 | Whole app is `"use client"` | Data-heavy pages (`scores/page.tsx` 784 lines, `schedule` 517) fetch via `useQuery` in client components instead of Server Components with `preloadQuery`. | Convert top-level pages to Server Components; keep interactivity in small client leaves. |
| L10 | Large files | `src/lib/ai/prompt-builder.ts` 1906 lines, `conversation-service.ts` 1067, `ContentGenerator.tsx` 788, `setup/page.tsx` 777. | Split by persona/content-type/step. |
| L11 | `next lint` deprecated (removed in Next 16); no `typecheck` script | Tooling drift. | Migrate to direct `eslint`; add `"typecheck": "tsc --noEmit"`. |
| L12 | `convex/espnSync.ts:138`, `matchupRosters.ts:111` vs `syncHistoricalData`/`fetchHistoricalRosters` | Inconsistent `espnS2` handling — some call sites use the raw stored cookie, others `decodeURIComponent()` it first; if cookies are stored URL-encoded the raw call sites silently fail ESPN auth for private leagues. | Standardize decoding in one helper. |
| L13 | `convex/espnSync.ts:2882` `storeTrades` | Live public mutation whose only caller (`processTradeMessage:2684`) is commented-out dead code — a callerless, exploitable write. | Remove or make internal. |

---

## Appendix — ESPN sync layer (full per-function detail)

The sync files (`espnSync.ts`, `playerSync.ts`, `playerSyncInternal.ts`, `playerHistoricalSync.ts`, `matchupRosters.ts`, `espnNews.ts`, `espn.ts`) are where the no-auth pattern is densest. The shared enabler is `internal.leagues.getByIdInternal` (`leagues.ts:241`), which — unlike `leagues.getById` — does no identity/membership check, so any public action built on it runs server-side using the target league's stored ESPN cookies for an arbitrary caller-supplied `leagueId`.

**Convert to `internal*` (never called from `src/`):** `espnSync.ts` `updateTeams:518`, `updatePlayers:645`, `updateMatchups:718`, `updateLeagueSeason:1209`, `updateSeasonDraftData:1336`, `updateLeagueSync:2660`, `storeTrades:2882`, `syncPlayerTransactions:3021`, `storePlayerTransactions:3085`, `syncAllHistoricalPlayerStats:2150`; all write mutations in `playerSyncInternal.ts` (`upsertPlayersBatch:25`, `updateLeaguePlayerStatuses:98`, `updateSyncStatus:155`, `createSyncStatus:178`, `upsertPlayerStatsBatch:296`, `refreshLeagueTopPerformers:498`, `computeLeagueTopPerformers:539`); `playerSync.ts` `syncLeaguePlayerStats:785`, `syncAllLeaguePlayerStats:879`, `syncPlayersDefaultStats:615`; nearly all of `playerHistoricalSync.ts` (`syncHistoricalPlayers:7`, `dailyPlayerSync:134`, `dailyAllLeaguesPlayerStatsSync:197`, `initializePlayerData:305`, `syncHistoricalLeaguePlayerStats:352`, `syncAllLeaguesHistoricalPlayerStats:500`); `matchupRosters.fetchMatchupRosters:68`; `espnNews.ts` `fetchESPNNews:74`, `syncESPNNews:184`.

**Must stay public but need an explicit `ctx.auth` + membership/commissioner check at the top of the handler** (they're wired to real UI buttons — `league-card.tsx`, `sync/actions.ts`, `HistoricalDataSync.tsx`, `payment-success/page.tsx`): `syncAllLeagueData:1431`, `syncAllDataWithRosters:2576`, `syncLeagueData:91`, `syncHistoricalData:814`, `fetchHistoricalRosters:2174`, `fetchDraftDataForSeason:2393`.

**Public read queries in `playerSyncInternal.ts` leaking private-league data** (no membership check, arbitrary `leagueId`): `getLeagueFreeAgents:235`, `getPlayersWithLeagueStats:393`, `getLeagueFreeAgentsWithStats:434`, `getTopPerformersCache:630`, `hasPlayerStatsForLeagueSeason:644`. Add membership checks.

**Correctly-internal reference implementations** (what the above should look like): `espnSync.syncAllLeaguesCurrentSeason:3140`, `playerHistoricalSync.scheduledDailyPlayerSync:341` / `scheduledDailyAllLeaguesSync:581`, `matchupRosters.updateMatchupRosters:202`.

**Note:** `syncPlayersForDraft`, `syncLeaguePlayers`, `syncAllLeaguePlayers`, `completeLeagueSync`, and `syncAllPlayers` (with `leagueId` supplied) route through `api.leagues.getById`, which **does** check membership — these are effectively protected already. Good.

---

## What's healthy (for balance)

- **`tsc --noEmit` is clean** — 0 type errors under `strict: true`.
- **`src/` lint is basically clean** — 0 errors, 2 unused-var warnings.
- **No hardcoded secrets** anywhere in `src/` or `convex/` — all API keys (Stripe, Anthropic, OpenAI, SendGrid, Clerk) come from `process.env`. `.env*` is gitignored; no `.env` in git history. The only key-shaped strings are placeholders in `STRIPE_SETUP.md`.
- **`next.config.ts` does not ignore build errors** — no `ignoreBuildErrors`/`ignoreDuringBuilds`, so builds fail on TS/lint errors in covered dirs.
- **The correct auth pattern already exists** (see "root-cause" section) — this is an application-consistency problem, not a "we never thought about auth" problem.
- **Next 15 async `params` handled correctly** everywhere (`await params` / `React.use(params)`).

---

## Recommended order of attack

1. **Stop the bleeding (Critical auth).** Add `ctx.auth` + membership/commissioner checks to the public no-auth functions in `credits.ts`, `payments.ts`, `leagues.ts`, `teams.ts`, `users.ts`, `emailService.ts`; convert sync/test/debug functions (`espnSync.ts`, `commentRequestTesting.ts`, `dataProcessing.ts`) to `internal*`. Delete `src/app/test-comments/` and `src/app/sync/`, and switch `middleware.ts` to default-deny.
2. **Payments integrity.** Add `event.id` idempotency to the Stripe webhook and require `paymentStatus === "paid"` before fulfillment; add the missing admin check to `reconcilePayment`; deduct credits before AI generation.
3. **Stop leaking ESPN cookies.** Remove `espnData.espnS2`/`swid` from all member-facing query responses; plan encryption at rest.
4. **Dependencies.** `npm audit fix` (Clerk CVEs) + manually bump `next` to a patched 15.5.x → clears all three critical CVEs. Then update the Anthropic SDK.
5. **Guardrails.** Add CI (`tsc --noEmit` + eslint over `src/` **and** `convex/`), burn down the 164 convex `any`s, and start a smoke-test suite on the credit/payment paths.
6. **Hygiene.** Delete `convex/debugTeamNames.ts`, drop the 39 MB `.serena` cache and `draftGradeTest.json` from git, move root `.md` notes to `docs/`, centralize the `2025` season constant.

---

_This audit is static analysis of the code as committed. It does not include dynamic pen-testing or a review of the live Convex deployment's actual dashboard/API access settings. Line numbers are from the audited commit and may drift as the code changes._
