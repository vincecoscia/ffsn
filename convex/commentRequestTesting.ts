// This module previously exposed comment-request test scaffolding as PUBLIC
// Convex functions (createTestScheduledContent, triggerTestCommentRequests,
// simulateUserResponse, sendPendingRequests, runEndToEndTest, cleanupTestData,
// debugLeagueData, getTestingData, getTestStatus). Because Convex `mutation`/
// `query`/`action` are publicly callable by any client, those endpoints were a
// critical vulnerability: unauthenticated mass-deletion of production comment
// data, platform-wide PII disclosure (name/email/clerkId), and a paid-AI /
// email cost-abuse vector.
//
// The scaffolding and its only caller (the /test-comments page) have been
// removed. If test helpers are needed again, reintroduce them as
// `internalMutation`/`internalQuery` and drive them from a protected admin
// route or a dev-only script — never as public functions.

export {};
