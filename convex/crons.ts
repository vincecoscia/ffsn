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

export default crons;