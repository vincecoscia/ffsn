import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// Plain-text transactional email for Better Auth flows (password reset, and
// verification once enabled). Reuses the same SendGrid account/sender as
// emailService.ts, but sends inline content instead of a dynamic template so no
// new SendGrid template is required.
export const sendAuthEmail = internalAction({
  args: {
    to: v.string(),
    subject: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      console.error("SENDGRID_API_KEY not set; cannot send auth email");
      return { success: false as const, error: "SENDGRID_API_KEY not set" };
    }

    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: args.to }] }],
        from: { email: "support@ffsn.ai", name: "FFSN Support" },
        subject: args.subject,
        content: [{ type: "text/plain", value: args.text }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`SendGrid auth email failed: ${res.status} ${body}`);
      return { success: false as const, error: `SendGrid ${res.status}` };
    }

    return { success: true as const };
  },
});
