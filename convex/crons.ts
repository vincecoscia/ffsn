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

export default crons;