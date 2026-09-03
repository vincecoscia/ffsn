import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Ensure the current (and, in-season-off, upcoming) NFL season's boundary
// row exists before anything else runs today. Idempotent - safe to run
// daily even once seasons are seeded.
crons.daily(
  "ensure current NFL season boundaries",
  { hourUTC: 1, minuteUTC: 0 },
  internal.nflSeasonSetup.ensureCurrentSeason,
);

// Sync ESPN news every hour
crons.hourly(
  "sync ESPN news",
  { 
    minuteUTC: 0, // Run at the top of every hour
  },
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

export default crons;