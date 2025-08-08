# Comment Request Feature Testing Guide 🧪

## Overview
This guide covers comprehensive testing of the "request for comment" feature where AI reaches out to users before generating scheduled articles.

## Features to Test

### 1. **Comment Request Creation**
- ✅ Scheduled content triggers comment requests
- ✅ Correct users are selected based on content type
- ✅ Request timing (12-24 hours before generation)
- ✅ Anti-abuse and expiration settings

### 2. **AI Conversation System**
- ✅ Initial AI question generation
- ✅ User response processing
- ✅ Follow-up question intelligence
- ✅ Automatic conversation ending
- ✅ Off-topic detection and handling

### 3. **Notification System**
- ✅ In-app notifications for requests
- ✅ Follow-up notifications
- ✅ Expiration warnings
- ✅ Thank you messages

### 4. **Data Integration**
- ✅ Comment responses are stored
- ✅ Quality scoring and filtering
- ✅ Integration with article generation

---

## Testing Methods

### Method 1: Web Dashboard (Recommended)
**URL:** `http://localhost:3000/test-comments`

**Step-by-Step:**
1. **Select League** - Choose from available leagues
2. **Create Test Content** - Creates a scheduled weekly_recap
3. **Trigger Requests** - Sends AI requests to users immediately
4. **Monitor Status** - Watch real-time updates of request states
5. **Simulate Responses** - Test user interactions and AI follow-ups
6. **Cleanup** - Remove test data when done

### Method 2: Convex Dashboard Functions
**URL:** `npx convex dashboard` → Functions tab

**Key Functions:**
```javascript
// 1. Get available test data
commentRequestTesting:getTestingData()

// 2. Run complete end-to-end test
commentRequestTesting:runEndToEndTest({
  "leagueId": "YOUR_LEAGUE_ID"
})

// 3. Check current status
commentRequestTesting:getTestStatus({
  "leagueId": "YOUR_LEAGUE_ID"
})

// 4. Simulate user responses
commentRequestTesting:simulateUserResponse({
  "commentRequestId": "REQUEST_ID",
  "response": "Great week! My QB threw 3 TDs and my defense got 2 picks!"
})

// 5. Cleanup test data
commentRequestTesting:cleanupTestData({
  "leagueId": "YOUR_LEAGUE_ID",
  "olderThanHours": 1
})
```

### Method 3: Production-Like Testing
**For testing with real scheduling and timing:**

1. **Create Real Scheduled Content:**
   ```javascript
   // Use existing content scheduling functions
   api.contentScheduling.scheduleContent({
     leagueId: "REAL_LEAGUE_ID",
     contentType: "weekly_recap",
     scheduledFor: Date.now() + (2 * 60 * 60 * 1000) // 2 hours from now
   })
   ```

2. **Monitor Natural Flow:**
   - Wait for comment requests to be created automatically
   - Check notifications in the app
   - Test real user responses through the UI

---

## Test Scenarios

### Scenario 1: Happy Path
**Goal:** Test complete successful workflow
```
1. Create scheduled weekly_recap (2 hours from now)
2. System creates comment requests (12 hours before = immediate for testing)
3. AI generates initial questions about team performance
4. User responds with detailed feedback
5. AI asks 1-2 follow-up questions
6. User provides quotable insights
7. Conversation ends with thank you
8. Responses are integrated into article generation
```

### Scenario 2: Non-Responsive User
**Goal:** Test timeout and expiration handling
```
1. Create comment request
2. AI sends initial question
3. User doesn't respond
4. System sends reminder notification
5. Request expires 15 minutes before article generation
6. Article generates without user input
```

### Scenario 3: Off-Topic User
**Goal:** Test abuse detection and conversation control
```
1. User responds with completely unrelated content
2. AI detects off-topic conversation
3. AI attempts to redirect conversation
4. If user continues off-topic, conversation ends
5. Limited or no content used in article
```

### Scenario 4: High-Quality Conversation
**Goal:** Test AI follow-up intelligence
```
1. User provides good initial response
2. AI identifies areas for deeper insights
3. AI asks targeted follow-up about specific players/decisions
4. User provides quotable analysis
5. AI recognizes sufficient content and ends conversation
6. High-quality responses are prioritized for article
```

---

## Expected Results

### Database Records Created:
- **commentRequests** - One per user/content combination
- **commentConversations** - AI questions and user responses
- **commentResponses** - Processed final responses for article use
- **userNotifications** - Notifications sent to users

### AI Behavior:
- **Initial Questions** should be contextual and specific to the user's team
- **Follow-ups** should build on user responses, not repeat questions
- **Conversation Ending** should happen after 1-3 meaningful exchanges

### User Experience:
- **Notifications** appear in-app immediately
- **Response Interface** allows easy text input
- **Real-time Updates** show conversation progress

---

## Troubleshooting

### Common Issues:

1. **"Not authenticated" errors**
   - Ensure you're logged in with Clerk
   - Check that user exists in database

2. **No comment requests created**
   - Verify league has active teams with owners
   - Check that users exist for team owners
   - Ensure scheduled content exists

3. **AI not responding**
   - Check ANTHROPIC_API_KEY is configured
   - Verify conversation service functions are working
   - Check scheduled functions are running

4. **Notifications not appearing**
   - Check notification queries return data
   - Verify real-time subscriptions are working
   - Check user notification preferences

### Debug Commands:
```javascript
// Check if users exist for league
api.commentRequestTesting.getTestingData()

// Check comment request status
api.commentRequestTesting.getTestStatus({ leagueId: "LEAGUE_ID" })

// Check notifications
api.notifications.getUserNotifications()

// Check conversations
api.commentConversations.getActiveRequests({ userId: "USER_ID" })
```

---

## Success Criteria

### ✅ **Feature is Working If:**
1. **Comment requests are created automatically** when content is scheduled
2. **AI generates contextual questions** about user's team performance
3. **Users can respond** through the interface
4. **AI provides intelligent follow-ups** based on responses
5. **Conversations end appropriately** (not too short, not too long)
6. **Notifications work** for all interaction types
7. **Responses are stored and integrated** into article generation
8. **System handles edge cases** (non-responsive users, off-topic responses)

### 📊 **Performance Targets:**
- **Response Rate:** >60% of users provide some response
- **Conversation Quality:** >40% of conversations produce quotable content
- **AI Accuracy:** <10% false positives for abuse detection
- **System Reliability:** >99% of scheduled requests are created successfully

---

## Cleanup

**Always clean up test data after testing:**
```javascript
// Through dashboard
api.commentRequestTesting.cleanupTestData({
  olderThanHours: 1
})

// Or through web interface
// Visit test page and click "Clean Up Test Data"
```

**Manual cleanup if needed:**
- Delete test commentRequests
- Delete related commentConversations  
- Delete commentResponses
- Delete test scheduledContent
- Delete test userNotifications