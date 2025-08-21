import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Migration to opt in all existing users for email notifications
export const optInAllUsersForEmail = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("Starting email opt-in migration...");
    
    const result = await ctx.scheduler.runAfter(0, internal.emailService.optInAllUsers, {});
    
    console.log("Email opt-in migration scheduled");
    return { scheduled: true };
  },
});

// Test email functionality
export const testEmailSystem = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("Testing email system...");
    
    // Schedule a test email
    await ctx.scheduler.runAfter(0, internal.emailService.sendTestEmail, {
      toEmail: "test@example.com", // Replace with your test email
      testType: "system_test",
    });
    
    console.log("Test email scheduled");
    return { scheduled: true };
  },
});
