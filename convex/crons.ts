import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { TRANSACTION_LOG_POLL_MINUTES } from "../src/lib/ai/wire/types";

const crons = cronJobs();

// Ensure the current (and, in-season-off, upcoming) NFL season's boundary
// row exists before anything else runs today. Idempotent - safe to run
// daily even once seasons are seeded.
crons.daily(
  "ensure current NFL season boundaries",
  { hourUTC: 1, minuteUTC: 0 },
  internal.nflSeasonSetup.ensureCurrentSeason,
);

// Sync ESPN news every 5 minutes in season (The Wire, spec §5.1/§12.1: news moves from hourly to
// every 5 min so a headline can clear the wire's interest bar within minutes, not up to an hour).
crons.interval(
  "sync ESPN news",
  { minutes: 5 },
  internal.espnNews.scheduledNewsSync,
);

// Daily sync of default player stats at 3 AM ET (8 AM UTC)
crons.daily(
  "daily default player stats sync",
  { hourUTC: 8, minuteUTC: 0 },
  internal.playerHistoricalSync.scheduledDailyPlayerSync,
);

// Daily sync of all leagues' player stats at 4 AM ET (9 AM UTC)  
crons.daily(
  "daily all leagues player stats sync",
  { hourUTC: 9, minuteUTC: 0 },
  internal.playerHistoricalSync.scheduledDailyAllLeaguesSync,
);

// Process scheduled content generation every 15 minutes
crons.interval(
  "process scheduled content",
  { minutes: 15 },
  internal.contentScheduling.processScheduledContentCron,
);

// Schedule weekly content generation - runs daily to check for new weekly content to schedule
crons.daily(
  "schedule weekly content",
  { hourUTC: 2, minuteUTC: 0 }, // 2 AM UTC (10 PM ET previous day)
  internal.contentScheduling.scheduleWeeklyContentCron,
);

// Daily cron to schedule season-based and relative content triggers
crons.daily(
  "schedule season/relative content",
  { hourUTC: 3, minuteUTC: 0 },
  internal.contentScheduling.scheduleSeasonAndRelativeContentCron,
);

// Sync current season data for all leagues every 4 hours
crons.interval(
  "sync current season data for all leagues",
  { hours: 4 },
  internal.espnSync.syncAllLeaguesCurrentSeason,
);

// Receipts (spec §8.4): settle last week's open claims against what actually
// happened, Tuesday 09:30 UTC - deliberately before the relationship decay below,
// so a writer's record is current when the week's articles are written.
crons.cron(
  "resolve open writer claims",
  "30 9 * * 2",
  internal.claims.resolveOpenClaims,
  {},
);

// Relationship meter cooldown (spec §6.2): every non-zero manager <-> writer
// score moves 15% toward 0 once a week, Tuesday 10:00 UTC (after Monday night
// football has settled the week's roasts).
crons.cron(
  "decay writer relationships",
  "0 10 * * 2",
  internal.relationships.decayRelationships,
  {},
);

// Message Batches come back on their own schedule (spec §10.3.5), so the desk
// checks every ten minutes for scheduled articles whose batch has finished.
// A batch that is still processing when print time arrives loses its turn:
// `processScheduledContentCron` puts the row back and generates it directly.
crons.interval(
  "poll scheduled article batches",
  { minutes: 10 },
  internal.aiBatch.pollBatches,
  {},
);

// Season credits do not roll over (spec §10.1). Every Monday 11:00 UTC, any
// balance whose expiry has passed is zeroed and written off in the ledger.
// Weekly rather than daily because the expiry is a date, not a deadline: a few
// days of grace after February 15 costs nothing and a stuck sweep is obvious.
crons.cron(
  "expire season credits",
  "0 11 * * 1",
  internal.credits.expireSeasonCredits,
  {},
);

// Operator digest (spec §11.3.10). One email a day for whoever runs this
// deployment: what published, what was held, what failed, what deferred, spend
// against the cap, the loudest verifier flags, batch fallbacks and the
// interview decline rate - per league, for the last 24 hours. 13:00 UTC is
// after the Tuesday recap window and the Wednesday rankings/waiver window, so
// the digest reports on a day that has already happened.
crons.daily(
  "operator digest",
  { hourUTC: 13, minuteUTC: 0 },
  internal.deskMetrics.sendOperatorDigest,
  {},
);

// Commissioner-facing ESPN credential lifecycle reminders, private leagues
// only ("notify the commissioner 2 weeks before a known token expires, or
// once it has, so they can fix it ASAP"): resends the "still broken" notice
// every 3 days a connection stays invalid, warns once per expiry date inside
// the 14-day window, and probes a token whose commissioner-entered expiry has
// passed but that no sync has caught yet. 13:30 UTC, right after the operator
// digest above.
crons.daily(
  "ESPN credential reminders",
  { hourUTC: 13, minuteUTC: 30 },
  internal.espnCredentialLifecycle.dailyCredentialReminders,
  {},
);

// ESPN refresh audit (Sept 2026), recommendation (i): the 4-hourly liveness sync above never
// backfills a week once it closes (stat corrections, a settled `pending` transaction) - this
// re-pulls exactly the weeks that just finished, per league, and records them so it's never redone.
crons.interval(
  "close finished weeks",
  { hours: 6 },
  internal.seasonSync.weekClosedCron,
  {},
);

// ESPN refresh audit, recommendation (ii): once a league's bracket is decided, do the one full pull
// a season needs to be DONE (every period, draft picks, trades, the bracket-derived champion, season
// player stats) and stamp it finalized. `crons.daily` (not `crons.cron`) matches this job's own
// "daily" cadence - see `convex/seasonSync.ts`'s header for what runs and why.
crons.daily(
  "close finished seasons",
  { hourUTC: 10, minuteUTC: 30 },
  internal.seasonSync.seasonClosedCron,
  {},
);

// --- Player intelligence layer (Sept 2026) -----------------------------
//
// Fresh injury/practice/depth-chart/market color for AI sportswriters, kept
// on each feed's own natural cadence rather than one combined job - see
// `convex/intelSync.ts` for why each sync is idempotent and safe to rerun,
// and `convex/intel.ts` for how staleness is judged on read. (`syncAllPlayerIntel`
// also exists as a single manually-invokable entry point that runs all four
// in sequence; it is intentionally not cron-wired since the four feeds don't
// share a cadence.) Uses `crons.cron`/`crons.interval` (not `crons.daily`),
// per this repo's current Convex guidelines.
// Sleeper is the freshest injury / depth-chart source; every 4 hours keeps a Sunday inactive
// or a Wednesday designation inside the 3-day freshness window with room to spare (2026-09-05).
crons.interval(
  "sync Sleeper players (player intel)",
  { hours: 4 },
  internal.intelSync.runIntelSync,
  { source: "sleeper_players" },
);

crons.interval(
  "sync Sleeper trending adds (player intel)",
  { hours: 6 },
  internal.intelSync.runIntelSync,
  { source: "sleeper_trending" },
);

crons.cron(
  "sync nflverse injuries (player intel)",
  "0 11 * * *",
  internal.intelSync.runIntelSync,
  { source: "nflverse_injuries" },
);

crons.cron(
  "sync FFC ADP (player intel)",
  "0 12 * * *",
  internal.intelSync.runIntelSync,
  { source: "ffc_adp" },
);

// --- The Wire (ffsn-the-wire-spec.md §11) ------------------------------
//
// ESPN's injuries feed, polled every 5 minutes in season (the poller itself throttles to 30 min
// off-season, §5.1) - the primary global detector for injury_status/injury_note events.
crons.interval(
  "poll ESPN injuries (The Wire)",
  { minutes: 5 },
  internal.wireSourcesNode.pollEspnInjuries,
  {},
);

// One Sonnet call per persona covers every pending take_pending post in the window (spec §3.1) -
// paid once per 10 minutes rather than once per event.
crons.interval(
  "flush Wire take batch",
  { minutes: 10 },
  internal.wireGenerate.flushTakeBatch,
  {},
);

// --- Dex Desk (ffsn-the-wire-spec.md §18) ------------------------------

// ESPN's transaction log, polled every 15 min in season for the current scoring period of every
// pass-holding, wire-enabled league with valid credentials - the primary source for lineup moves,
// trade proposals/declines, pending claims and streaming churn.
crons.interval(
  "poll transaction logs (The Wire)",
  { minutes: TRANSACTION_LOG_POLL_MINUTES },
  internal.wireDesk.pollTransactionLogs,
  {},
);

// The current + next NFL week's kickoffs from ESPN's public scoreboard, every 6 hours in season -
// upserts `nflSchedules` and schedules a private lineup-lock warning + public post per kickoff.
crons.interval(
  "sync NFL kickoffs (The Wire)",
  { hours: 6 },
  internal.wireSourcesNode.pollNflSchedule,
  {},
);

// weekly_rundown (Wednesday 07:00 league-local) and quiet_desk (Tuesdays inside the trade-deadline
// window) both fire on a wall-clock condition the cron checks hourly, per league.
crons.interval(
  "Dex Desk hourly checks (The Wire)",
  { hours: 1 },
  internal.wireDesk.hourlyDeskCron,
  {},
);

// --- Live game engine (ffsn-the-wire-spec.md §19) ------------------------------

// `wireLive.tick` is a self-rescheduling action (60s while any game is live, else at the next
// kickoff minus 5 minutes, else it stops) - this daily check re-arms it if its scheduled run died
// (a deploy, an uncaught throw). `pollNflSchedule` also calls `ensureWireClock` directly right
// after it stores new kickoffs, so a freshly-discovered game week wakes the clock immediately.
crons.cron(
  "ensure Wire clock (The Wire)",
  "0 6 * * *",
  internal.wireLive.ensureWireClock,
  {},
);

// The Sunday-night digest (spec §19.3): Monday 04:00 UTC - midnight ET, right after Sunday night
// football - one email per opted-in manager with a claimed team in a pass-holding, wire-enabled
// league and something to say from the last 24 hours.
crons.cron(
  "wire Sunday digest",
  "0 4 * * 1",
  internal.wireDigest.sendDigestForAllUsers,
  {},
);

export default crons;