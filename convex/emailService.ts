import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// SendGrid email service for FFSN using fetch-based approach
// Record → queue → send pattern for reliable email delivery

// Types for email templates and data
export interface CommentRequestEmailData {
  userName: string;
  leagueName: string;
  articleType: string;
  week?: number;
  commentRequestUrl: string;
  unsubscribeUrl: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// Kill switch. Set EMAIL_SENDING_DISABLED=true on a deployment (e.g. the beta backend, which
// holds a copy of production's leagues and members) to stop every outbound email while leaving
// data, notifications, and scheduling untouched. Production leaves it unset.
function emailSendingDisabled(): boolean {
  return process.env.EMAIL_SENDING_DISABLED === "true";
}

// ===============================
// EMAIL QUEUE SYSTEM
// ===============================

// Queue an email for sending. INTERNAL ONLY — it sends mail from the app's
// verified sender to an arbitrary recipient, so exposing it publicly was a
// spam/phishing vector. Server callers use queueEmailInternal (below).
export const queueEmail = internalMutation({
  args: {
    to: v.string(),
    templateId: v.string(),            // SendGrid Dynamic Template ID
    data: v.any(),                     // dynamic_template_data
    userId: v.optional(v.id("users")), // For tracking
    relatedEntityType: v.optional(v.string()),
    relatedEntityId: v.optional(v.string()),
  },
  handler: async (ctx, { to, templateId, data, userId, relatedEntityType, relatedEntityId }) => {
    const id = await ctx.db.insert("emailLogs", {
      userId: userId || ("system" as any), // Fallback for system emails
      email: to,
      templateType: relatedEntityType || "unknown",
      templateId,
      messageId: "queued",
      status: "queued" as any, // Cast to avoid type error during transition
      relatedEntityType,
      relatedEntityId,
      sentAt: Date.now(),
      createdAt: Date.now(),
    });

    // Fire-and-forget send (runs right after the mutation)
    await ctx.scheduler.runAfter(0, internal.emailService.sendNow, { id });
    return id;
  },
});

// Send email immediately (internal action)
export const sendNow = internalAction({
  args: { id: v.id("emailLogs") },
  handler: async (ctx, { id }) => {
    const email = await ctx.runQuery(internal.emailService.getEmailById, { id });
    if (!email || (email.status as any) !== "queued") return;

    // Get the email data from the email log
    let templateData = {};
    try {
      const emailData = JSON.parse(email.relatedEntityId || "{}");
      // Handle both old format (direct template data) and new format (with templateData property)
      templateData = emailData.templateData || emailData;
    } catch (error) {
      console.error("Failed to parse email template data:", error);
      await ctx.runMutation(internal.emailService.markFailed, { 
        id, 
        error: "Invalid template data format", 
        statusCode: 400 
      });
      return;
    }

    const payload = {
      from: { email: "support@ffsn.ai", name: "FFSN Support" },
      personalizations: [{
        to: [{ email: email.email }],
        dynamic_template_data: templateData,
        // Helpful for webhook correlation
        custom_args: { email_id: id },
      }],
      template_id: email.templateId,
      categories: [email.templateType, "notification"],
      asm: {
        group_id: parseInt((process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID || "1").replace(/^ID:/, "")),
      },
      tracking_settings: {
        click_tracking: {
          enable: true,
          enable_text: true,
        },
        open_tracking: {
          enable: true,
        },
      },
    };

    console.log(`Sending email to ${email.email} with template ${email.templateId}`);
    console.log(`Template data:`, JSON.stringify(templateData, null, 2));

    if (emailSendingDisabled()) {
      console.log(`Email sending is disabled on this deployment; not sending ${email.email} (${email.templateId})`);
      await ctx.runMutation(internal.emailService.markFailed, { id, error: "EMAIL_SENDING_DISABLED", statusCode: 0 });
      return;
    }
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.error(`SendGrid API error ${res.status}:`, errorText);
      console.error(`Failed payload:`, JSON.stringify(payload, null, 2));
      await ctx.runMutation(internal.emailService.markFailed, { 
        id, 
        error: errorText, 
        statusCode: res.status 
      });
      throw new Error(`SendGrid ${res.status}: ${errorText}`);
    }

    // SendGrid replies 202 and includes X-Message-ID header you can store
    const xMessageId = res.headers.get("x-message-id") ?? "unknown";
    console.log(`Email sent successfully, message ID: ${xMessageId}`);
    await ctx.runMutation(internal.emailService.markSent, { id, xMessageId });
  },
});

// Mark email as sent (internal mutation)
export const markSent = internalMutation({
  args: { id: v.id("emailLogs"), xMessageId: v.string() },
  handler: async (ctx, { id, xMessageId }) => {
    await ctx.db.patch(id, { 
      status: "sent", 
      messageId: xMessageId, 
      sentAt: Date.now() 
    });
  },
});

// Mark email as failed (internal mutation)
export const markFailed = internalMutation({
  args: { id: v.id("emailLogs"), error: v.string(), statusCode: v.number() },
  handler: async (ctx, { id, error, statusCode }) => {
    await ctx.db.patch(id, { 
      status: "error", 
      error: `${statusCode}: ${error}`,
      sentAt: Date.now() 
    });
  },
});

// Get email by ID (internal query)
export const getEmailById = internalQuery({
  args: { id: v.id("emailLogs") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

// ===============================
// COMMENT REQUEST EMAIL FUNCTIONS
// ===============================

// Send comment request notification email (simplified)
export const sendCommentRequestEmail = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    templateData: v.object({
      userName: v.string(),
      leagueName: v.string(),
      articleType: v.string(),
      week: v.optional(v.number()),
      commentRequestUrl: v.string(),
      unsubscribeUrl: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<EmailResult> => {
    try {
      // Get user details
      const user = await ctx.runQuery(internal.emailService.getUserEmailPreferences, {
        userId: args.userId,
      });

      if (!user) {
        console.error(`User not found: ${args.userId}`);
        return { success: false, error: "User not found" };
      }

      if (!user.email) {
        console.log(`User ${args.userId} has no email address`);
        return { success: false, error: "No email address" };
      }

      if (!user.emailNotificationsEnabled) {
        console.log(`User ${args.userId} has email notifications disabled`);
        return { success: false, error: "Email notifications disabled" };
      }

      // Check if we have SendGrid API key
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        console.error("SENDGRID_API_KEY environment variable not set");
        return { success: false, error: "SendGrid not configured" };
      }

      // Get template ID
      const templateId = process.env.SENDGRID_COMMENT_REQUEST_TEMPLATE_ID;
      if (!templateId) {
        console.error("SENDGRID_COMMENT_REQUEST_TEMPLATE_ID not set");
        return { success: false, error: "Template not configured" };
      }

      // Enhanced template data with user info
      const enhancedTemplateData = {
        ...args.templateData,
        userName: user.name || "User",
        supportEmail: "support@ffsn.ai",
        currentYear: new Date().getFullYear(),
      };

      // Queue the email for sending
      const emailId = await ctx.runMutation(internal.emailService.queueEmailInternal, {
        to: user.email,
        templateId,
        data: enhancedTemplateData,
        userId: args.userId,
        relatedEntityType: "comment_request",
        relatedEntityId: args.commentRequestId, // This will be overridden in queueEmailInternal
      });

      console.log(`Queued comment request email for user ${args.userId}, email ID: ${emailId}`);

      return {
        success: true,
        messageId: emailId,
      };

    } catch (error: any) {
      console.error("Error queuing comment request email:", error);
      return {
        success: false,
        error: error.message || "Unknown error",
      };
    }
  },
});

// Internal version of queueEmail for use within actions
export const queueEmailInternal = internalMutation({
  args: {
    to: v.string(),
    templateId: v.string(),
    data: v.any(),
    userId: v.optional(v.id("users")),
    relatedEntityType: v.optional(v.string()),
    relatedEntityId: v.optional(v.string()),
  },
  handler: async (ctx, { to, templateId, data, userId, relatedEntityType, relatedEntityId }) => {
    // Create a combined object that stores both template data and entity reference
    const emailData = {
      templateData: data,
      entityId: relatedEntityId,
    };

    const id = await ctx.db.insert("emailLogs", {
      userId: userId || ("system" as any),
      email: to,
      templateType: relatedEntityType || "unknown",
      templateId,
      messageId: "queued",
      status: "queued" as any, // Cast to avoid type error during transition
      relatedEntityType,
      relatedEntityId: JSON.stringify(emailData), // Store both template data and entity ID
      sentAt: Date.now(),
      createdAt: Date.now(),
    });

    // Schedule immediate sending
    await ctx.scheduler.runAfter(0, internal.emailService.sendNow, { id });
    return id;
  },
});

// ===============================
// PLAIN (NON-TEMPLATE) EMAIL
// ===============================

// Send a one-off plain-text (optionally with HTML) email via the same
// SendGrid fetch client and env vars as the template-based sendNow, but
// without a Dynamic Template. Used for notifications that don't warrant a
// dedicated SendGrid template, e.g. article-published emails. Internal
// only, for the same reason queueEmail is internal - it sends mail from the
// app's verified sender to an arbitrary recipient.
export const sendPlainEmail = internalAction({
  args: {
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    relatedEntityType: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EmailResult> => {
    try {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        console.error("SENDGRID_API_KEY environment variable not set");
        return { success: false, error: "SendGrid not configured" };
      }

      const payload = {
        from: { email: "support@ffsn.ai", name: "FFSN Support" },
        personalizations: [{ to: [{ email: args.to }] }],
        subject: args.subject,
        content: [
          { type: "text/plain", value: args.text },
          ...(args.html ? [{ type: "text/html", value: args.html }] : []),
        ],
        categories: [args.relatedEntityType || "notification", "notification"],
        // Respects the same SendGrid unsubscribe/suppression group as the
        // template-based sendNow, so members who disabled email notifications
        // (addToSuppressionList below) are never actually delivered to.
        asm: {
          group_id: parseInt((process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID || "1").replace(/^ID:/, "")),
        },
        tracking_settings: {
          click_tracking: { enable: true, enable_text: true },
          open_tracking: { enable: true },
        },
      };

      if (emailSendingDisabled()) {
        console.log(`Email sending is disabled on this deployment; not sending "${args.subject}" to ${args.to}`);
        return { success: false, error: "EMAIL_SENDING_DISABLED" };
      }
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        console.error(`SendGrid plain email error ${res.status}:`, errorText);
        return { success: false, error: `${res.status}: ${errorText}` };
      }

      const xMessageId = res.headers.get("x-message-id") ?? "unknown";
      return { success: true, messageId: xMessageId };
    } catch (error: any) {
      console.error("Error sending plain email:", error);
      return { success: false, error: error.message || "Unknown error" };
    }
  },
});

// ===============================
// USER PREFERENCE FUNCTIONS
// ===============================

// Get user email preferences
export const getUserEmailPreferences = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;

    return {
      email: user.email,
      name: user.name,
      emailNotificationsEnabled: user.preferences?.emailNotifications ?? true, // Default to true (opt-in)
    };
  },
});

// Update user email preferences (called from users.ts)
export const updateEmailPreferences = internalAction({
  args: {
    userId: v.id("users"),
    emailNotifications: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.emailService.getUserEmailPreferences, {
      userId: args.userId,
    });
    
    if (!user || !user.email) {
      console.log("User not found or no email address");
      return;
    }

    // If disabling emails, add to SendGrid suppression list
    if (!args.emailNotifications) {
      try {
        await ctx.scheduler.runAfter(0, internal.emailService.addToSuppressionList, {
          email: user.email,
          userId: args.userId,
        });
      } catch (error) {
        console.error("Failed to schedule addition to suppression list:", error);
      }
    } else {
      // Re-enabling emails - remove from suppression list
      try {
        await ctx.scheduler.runAfter(0, internal.emailService.removeFromSuppressionList, {
          email: user.email,
          userId: args.userId,
        });
      } catch (error) {
        console.error("Failed to schedule removal from suppression list:", error);
      }
    }
  },
});

// ===============================
// SENDGRID SUPPRESSION MANAGEMENT
// ===============================

// Add email to SendGrid suppression list
export const addToSuppressionList = internalAction({
  args: {
    email: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    try {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        console.error("SENDGRID_API_KEY not configured");
        return;
      }

      const unsubscribeGroupId = parseInt((process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID || "1").replace(/^ID:/, ""));
      
      const res = await fetch(`https://api.sendgrid.com/v3/asm/groups/${unsubscribeGroupId}/suppressions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient_emails: [args.email]
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`SendGrid suppression add failed ${res.status}: ${errorText}`);
      }

      console.log(`Added ${args.email} to SendGrid suppression list`);

    } catch (error) {
      console.error("Error adding to suppression list:", error);
      throw error;
    }
  },
});

// Remove email from SendGrid suppression list
export const removeFromSuppressionList = internalAction({
  args: {
    email: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    try {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        console.error("SENDGRID_API_KEY not configured");
        return;
      }

      const unsubscribeGroupId = parseInt((process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID || "1").replace(/^ID:/, ""));
      
      const res = await fetch(`https://api.sendgrid.com/v3/asm/groups/${unsubscribeGroupId}/suppressions/${args.email}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`SendGrid suppression remove failed ${res.status}: ${errorText}`);
      }

      console.log(`Removed ${args.email} from SendGrid suppression list`);

    } catch (error) {
      console.error("Error removing from suppression list:", error);
      throw error;
    }
  },
});

// ===============================
// MIGRATION AND TESTING FUNCTIONS
// ===============================

// Opt in all existing users to email notifications (one-time migration)
export const optInAllUsers = internalAction({
  args: {},
  handler: async (ctx): Promise<{ updatedCount: number; errorCount: number; totalUsers: number }> => {
    console.log("Starting opt-in migration for all users...");
    
    // Get all users
    const users = await ctx.runQuery(internal.emailService.getAllUsers, {});
    
    let updatedCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        // Only update users who don't already have email preferences set
        if (!user.preferences?.emailNotifications) {
          await ctx.runMutation(internal.emailService.setDefaultEmailPreferences, {
            userId: user._id,
          });
          updatedCount++;
        }
      } catch (error) {
        console.error(`Failed to opt in user ${user._id}:`, error);
        errorCount++;
      }
    }

    console.log(`Opt-in migration completed. Updated: ${updatedCount}, Errors: ${errorCount}`);
    return { updatedCount, errorCount, totalUsers: users.length };
  },
});

// Get all users for migration
export const getAllUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  },
});

// Set default email preferences for a user
export const setDefaultEmailPreferences = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return;

    await ctx.db.patch(args.userId, {
      preferences: {
        ...user.preferences,
        emailNotifications: true, // Default to opted in
      },
    });
  },
});

// Get recent email logs for debugging
export const getRecentEmailLogs = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("emailLogs")
      .order("desc")
      .take(args.limit || 10);
    
    return logs.map(log => ({
      id: log._id,
      email: log.email,
      templateType: log.templateType,
      templateId: log.templateId,
      status: log.status,
      messageId: log.messageId,
      error: log.error,
      sentAt: new Date(log.sentAt).toISOString(),
      createdAt: new Date(log.createdAt).toISOString(),
      relatedEntityId: log.relatedEntityId ? log.relatedEntityId.substring(0, 100) + "..." : null,
    }));
  },
});

// Debug function to check environment variables
export const debugEmailConfig = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.SENDGRID_API_KEY;
    const templateId = process.env.SENDGRID_COMMENT_REQUEST_TEMPLATE_ID;
    const unsubscribeGroupId = process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID;
    
    const parsedUnsubscribeGroupId = parseInt((unsubscribeGroupId || "1").replace(/^ID:/, ""));
    
    console.log("Email Configuration Debug:");
    console.log("- SENDGRID_API_KEY:", apiKey ? "SET" : "NOT SET");
    console.log("- SENDGRID_COMMENT_REQUEST_TEMPLATE_ID:", templateId ? templateId : "NOT SET");
    console.log("- SENDGRID_UNSUBSCRIBE_GROUP_ID:", unsubscribeGroupId ? `${unsubscribeGroupId} (parsed: ${parsedUnsubscribeGroupId})` : "NOT SET");
    
    return {
      hasApiKey: !!apiKey,
      hasTemplateId: !!templateId,
      templateId: templateId || null,
      hasUnsubscribeGroupId: !!unsubscribeGroupId,
      unsubscribeGroupId: unsubscribeGroupId || null,
      parsedUnsubscribeGroupId,
    };
  },
});

// Test comment request email with mock data
export const testCommentRequestEmail: any = internalAction({
  args: {
    testEmail: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string; emailId?: string; message?: string }> => {
    // First check configuration
    const config: any = await ctx.runAction(internal.emailService.debugEmailConfig, {});
    
    if (!config.hasApiKey) {
      return { success: false, error: "SENDGRID_API_KEY not configured" };
    }
    
    if (!config.hasTemplateId) {
      return { success: false, error: "SENDGRID_COMMENT_REQUEST_TEMPLATE_ID not configured" };
    }
    
    // Create mock template data
    const mockTemplateData = {
      userName: "Test User",
      leagueName: "Test League",
      articleType: "Weekly recap for Test League",
      week: 12,
      commentRequestUrl: "https://ffsn.ai/test-comment-request",
      unsubscribeUrl: "https://ffsn.ai/settings/notifications",
      supportEmail: "support@ffsn.ai",
      currentYear: new Date().getFullYear(),
    };
    
    // Queue the test email
    const emailId: string = await ctx.runMutation(internal.emailService.queueEmailInternal, {
      to: args.testEmail,
      templateId: config.templateId!,
      data: mockTemplateData,
      userId: undefined,
      relatedEntityType: "comment_request_test",
      relatedEntityId: "test-comment-request-123",
    });
    
    console.log(`Queued test comment request email, ID: ${emailId}`);
    
    return {
      success: true,
      emailId,
      message: "Test comment request email queued successfully",
    };
  },
});

// Test email sending (for development/testing)
export const sendTestEmail = internalAction({
  args: {
    toEmail: v.string(),
    testType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        throw new Error("SENDGRID_API_KEY not configured");
      }

      const payload = {
        from: { email: "support@ffsn.ai", name: "FFSN Support" },
        personalizations: [{
          to: [{ email: args.toEmail }],
        }],
        subject: "FFSN Email Test",
        content: [{
          type: "text/html",
          value: `
            <h2>Email Test Successful!</h2>
            <p>This is a test email from FFSN to verify SendGrid integration is working.</p>
            <p>Test type: ${args.testType || "basic"}</p>
            <p>Sent at: ${new Date().toISOString()}</p>
          `,
        }],
        categories: ["test"],
      };

      if (emailSendingDisabled()) {
        console.log("Email sending is disabled on this deployment; test email not sent");
        return { success: false, error: "EMAIL_SENDING_DISABLED" };
      }
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`SendGrid ${res.status}: ${errorText}`);
      }

      const xMessageId = res.headers.get("x-message-id") ?? "unknown";
      console.log(`Test email sent to ${args.toEmail}, message ID: ${xMessageId}`);

      return {
        success: true,
        messageId: xMessageId,
      };

    } catch (error: any) {
      console.error("Error sending test email:", error);
      return {
        success: false,
        error: error.message || "Unknown error",
      };
    }
  },
});