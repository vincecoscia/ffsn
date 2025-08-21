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

### 2. Create Dynamic Email Template

1. Go to SendGrid Dashboard > Email API > Dynamic Templates
2. Create new template called "FFSN Comment Request"
3. Create a version with the following content:

#### Template Subject:
```
{{articleType}} - Your Input Needed for {{leagueName}}
```

#### Template HTML Content:
```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Comment Request - FFSN</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 40px; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 700; }
        .header p { margin: 10px 0 0 0; opacity: 0.9; font-size: 16px; }
        .content { padding: 40px; }
        .content h2 { color: #1a202c; margin-top: 0; font-size: 24px; }
        .content p { color: #4a5568; font-size: 16px; margin-bottom: 20px; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin: 20px 0; }
        .cta-button:hover { opacity: 0.9; }
        .league-info { background-color: #f7fafc; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 4px; }
        .footer { background-color: #f8fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer p { color: #718096; font-size: 14px; margin: 5px 0; }
        .footer a { color: #667eea; text-decoration: none; }
        .unsubscribe { font-size: 12px; color: #a0aec0; margin-top: 20px; }
        .unsubscribe a { color: #a0aec0; }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <h1>FFSN</h1>
            <p>Fantasy Football Social Network</p>
        </div>
        
        <!-- Main Content -->
        <div class="content">
            <h2>Hi {{userName}},</h2>
            
            <p>We're creating an article about <strong>{{articleType}}</strong> for your league and would love to include your insights!</p>
            
            <div class="league-info">
                <h3 style="margin-top: 0; color: #667eea;">{{leagueName}}</h3>
                {{#if week}}
                <p style="margin-bottom: 0;"><strong>Week:</strong> {{week}}</p>
                {{/if}}
            </div>
            
            <p>Your perspective as a league member is valuable and will help create more engaging content for everyone. This is a quick conversation - just share your thoughts and we'll take care of the rest.</p>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="{{commentRequestUrl}}" class="cta-button">Share Your Thoughts</a>
            </div>
            
            <p style="font-size: 14px; color: #718096;">This request will expire soon, so don't wait too long to respond!</p>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <p><strong>FFSN - Fantasy Football Social Network</strong></p>
            <p>Creating engaging content for fantasy football leagues</p>
            
            <div class="unsubscribe">
                <p>
                    Don't want to receive these emails? 
                    <a href="{{unsubscribeUrl}}">Update your notification preferences</a>
                </p>
                <p>
                    <a href="{{asm_group_unsubscribe_raw_url}}">Unsubscribe from all FFSN emails</a> | 
                    <a href="{{asm_preferences_raw_url}}">Manage email preferences</a>
                </p>
                <p>FFSN • {{supportEmail}} • {{currentYear}}</p>
            </div>
        </div>
    </div>
</body>
</html>
```

#### Template Plain Text Content:
```text
Hi {{userName}},

We're creating an article about {{articleType}} for {{leagueName}} and would love to include your insights!

{{#if week}}Week: {{week}}{{/if}}

Your perspective as a league member is valuable and will help create more engaging content for everyone. This is a quick conversation - just share your thoughts and we'll take care of the rest.

Click here to share your thoughts: {{commentRequestUrl}}

This request will expire soon, so don't wait too long to respond!

---
FFSN - Fantasy Football Social Network
Creating engaging content for fantasy football leagues

Don't want to receive these emails? Update your preferences: {{unsubscribeUrl}}
Unsubscribe from all emails: {{asm_group_unsubscribe_raw_url}}

FFSN • {{supportEmail}} • {{currentYear}}
```

4. Save and activate the template
5. Copy the template ID (starts with `d-`) for environment variables

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
2. **Template Not Found**: Check `SENDGRID_COMMENT_REQUEST_TEMPLATE_ID`
3. **Sender Not Verified**: Complete sender authentication in SendGrid
4. **Suppression List**: Users may be on global suppression lists

### Testing Checklist

- [ ] Environment variables configured
- [ ] Unsubscribe group created
- [ ] Dynamic template created and active
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
