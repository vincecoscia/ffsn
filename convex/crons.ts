import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

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

export default crons;