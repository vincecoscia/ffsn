# SendGrid Email Setup for FFSN

This document outlines the complete setup process for SendGrid email integration in the FFSN application.

## Prerequisites

1. SendGrid account with API key
2. Verified sender domain/email (support@ffsn.ai)
3. Environment variables configured

## Environment Variables Required

Add these to your `.env.local` and Convex dashboard:

```env
SENDGRID_API_KEY=your_sendgrid_api_key_here
# Legacy - no longer read for sending. See "Templates" below.
SENDGRID_COMMENT_REQUEST_TEMPLATE_ID=d-your_template_id_here
SENDGRID_UNSUBSCRIBE_GROUP_ID=your_unsubscribe_group_id_here
SITE_URL=https://ffsn.ai
```

## SendGrid Configuration Steps

### 1. Create Unsubscribe Group

1. Go to SendGrid Dashboard > Settings > Unsubscribe Groups
2. Create a new group called "FFSN Notifications"
3. Set description: "Notifications about comment requests and league updates"
4. Note the Group ID for environment variables

### 2. Templates

Comment-request (and its reminder variants), article-published, and test
emails are not SendGrid Dynamic Templates - they're code, in
`src/lib/email/` (the Broadcast design system). They share the writer roster
in `src/lib/ai/persona-prompts.ts`, so a byline always matches the persona
who "wrote" the piece and never drifts from what the article itself says.

- Subject, HTML, and plain-text are all rendered at send time in
  `emailService.sendNow` (`convex/emailService.ts`), via `renderLocalTemplate`
  for any queued email whose `templateId` starts with `ffsn:` (see
  `src/lib/email/templates.ts` for the id -> renderer map).
- ASM group unsubscribe/suppression still applies exactly as before: every
  rendered email keeps the `<%asm_group_unsubscribe_raw_url%>` and
  `<%asm_preferences_raw_url%>` tags, which SendGrid substitutes at delivery
  time and gates on `SENDGRID_UNSUBSCRIBE_GROUP_ID`.
- To change copy or layout, edit `src/lib/email/templates.ts` (and the shared
  building blocks in `src/lib/email/shell.ts`) and redeploy Convex functions -
  there's no SendGrid dashboard template to edit, re-upload, or re-activate.

To preview a template end to end on a dev deployment:

```bash
# Generic system-notice test (renderSystemNoticeEmail)
npx convex run emailService:sendTestEmail '{"toEmail": "you@example.com"}'

# Comment-request test with sample league/question data (renderCommentRequestEmail)
npx convex run emailService:testCommentRequestEmail '{"testEmail": "you@example.com"}'

# Preview a reminder variant instead of the initial request
npx convex run emailService:testCommentRequestEmail '{"testEmail": "you@example.com", "variant": "final_reminder"}'
```

### 3. Verify Sender Authentication

1. Go to SendGrid Dashboard > Settings > Sender Authentication
2. Verify the domain `ffsn.ai` or authenticate `support@ffsn.ai`
3. Complete DNS verification if using domain authentication

### 4. Configure Webhook (Optional)

For tracking email events (opens, clicks, bounces):

1. Go to Settings > Mail Settings > Event Webhook
2. Set HTTP POST URL to: `https://your-app.com/api/sendgrid/webhook`
3. Select events: Delivered, Opened, Clicked, Bounced, Unsubscribed

## Testing the Integration

1. Run the migration to opt-in existing users:
```bash
# In Convex dashboard, run:
npx convex run migrations:optInAllUsersForEmail
```

2. Test email sending:
```bash
# In Convex dashboard, run:
npx convex run migrations:testEmailSystem
```

3. Test the notification settings page:
   - Visit `/dashboard/settings/notifications`
   - Toggle email notifications on/off
   - Verify changes are saved

## Email Flow

1. **Comment Request Created**: System creates notification with email channel
2. **Email Service**: Checks user preferences and SendGrid suppression
3. **Template Rendering**: Populates dynamic template with user/league data
4. **Delivery**: SendGrid delivers email with unsubscribe links
5. **Tracking**: Email events logged in `emailLogs` table

## User Email Preferences

Users can manage their email preferences at:
- `/dashboard/settings/notifications`

When users disable email notifications:
- Local preference updated in database
- Email added to SendGrid suppression group
- In-app notifications continue to work

When users re-enable email notifications:
- Local preference updated in database  
- Email removed from SendGrid suppression group

## Monitoring and Troubleshooting

### Check Email Logs
Query the `emailLogs` table to see sent emails and errors:
```javascript
// In Convex dashboard
ctx.db.query("emailLogs").order("desc").take(10)
```

### Common Issues

1. **API Key Issues**: Verify `SENDGRID_API_KEY` is set correctly
2. **Rendering errors**: A local template throwing during render marks the email failed with the error message - check `emailLogs.error` (`convex run emailService:getRecentEmailLogs`)
3. **Sender Not Verified**: Complete sender authentication in SendGrid
4. **Suppression List**: Users may be on global suppression lists

### Testing Checklist

- [ ] Environment variables configured
- [ ] Unsubscribe group created
- [ ] Templates render correctly (`emailService:sendTestEmail` / `emailService:testCommentRequestEmail`)
- [ ] Sender authentication completed
- [ ] Test email sends successfully
- [ ] Notification settings page works
- [ ] User opt-in migration completed
- [ ] Email preferences sync with SendGrid

## Security Considerations

1. **API Key**: Store securely in environment variables
2. **Unsubscribe**: Always include unsubscribe links
3. **Rate Limits**: SendGrid has sending limits based on plan
4. **Data Privacy**: Only send emails to users who opted in

## Support

For SendGrid-specific issues:
- SendGrid Documentation: https://docs.sendgrid.com/
- SendGrid Support: Available through dashboard

For FFSN email integration issues:
- Check Convex logs for error messages
- Review `emailLogs` table for failed sends
- Verify user preferences in `users` table
