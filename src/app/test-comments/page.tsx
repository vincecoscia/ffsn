"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";

export default function TestCommentsPage() {
  const [selectedLeague, setSelectedLeague] = useState<Id<"leagues"> | null>(null);
  const [selectedScheduledContent, setSelectedScheduledContent] = useState<Id<"scheduledContent"> | null>(null);
  const [userResponse, setUserResponse] = useState("");

  // Queries
  const testingData = useQuery(api.commentRequestTesting.getTestingData);
  const testStatus = useQuery(api.commentRequestTesting.getTestStatus, 
    selectedLeague ? { leagueId: selectedLeague } : {}
  );
  const debugData = useQuery(api.commentRequestTesting.debugLeagueData,
    selectedLeague ? { leagueId: selectedLeague } : "skip"
  );

  // Mutations
  const createTestContent = useMutation(api.commentRequestTesting.createTestScheduledContent);
  const triggerRequests = useMutation(api.commentRequestTesting.triggerTestCommentRequests);
  const sendPendingRequests = useMutation(api.commentRequestTesting.sendPendingRequests);
  const simulateResponse = useMutation(api.commentRequestTesting.simulateUserResponse);
  const cleanupData = useMutation(api.commentRequestTesting.cleanupTestData);

  const handleCreateTestContent = async () => {
    if (!selectedLeague) {
      alert("Please select a league first");
      return;
    }

    try {
      const result = await createTestContent({
        leagueId: selectedLeague,
        contentType: "weekly_recap",
        hoursFromNow: 2,
        week: 12,
      });
      alert(`Created test content: ${result.scheduledContentId}`);
      setSelectedScheduledContent(result.scheduledContentId);
    } catch (error) {
      alert(`Error: ${error}`);
    }
  };

  const handleTriggerRequests = async () => {
    if (!selectedScheduledContent) {
      alert("Please create test content first");
      return;
    }

    try {
      const result = await triggerRequests({
        scheduledContentId: selectedScheduledContent,
        requestTimeOffset: 1000, // 1 second for immediate testing
      });
      alert(`Created ${result.targetUserCount} comment requests`);
    } catch (error) {
      alert(`Error: ${error}`);
    }
  };

  const handleSendPendingRequests = async () => {
    if (!selectedScheduledContent) {
      alert("Please create test content first");
      return;
    }

    try {
      const result = await sendPendingRequests({
        scheduledContentId: selectedScheduledContent,
      });
      alert(result.message);
    } catch (error) {
      alert(`Error: ${error}`);
    }
  };

  const handleSimulateResponse = async (requestId: Id<"commentRequests">) => {
    if (!userResponse.trim()) {
      alert("Please enter a response");
      return;
    }

    try {
      const result = await simulateResponse({
        commentRequestId: requestId,
        response: userResponse,
      });
      alert(`Response sent! Message count: ${result.messageCount}`);
      setUserResponse("");
    } catch (error) {
      alert(`Error: ${error}`);
    }
  };

  const handleCleanup = async () => {
    if (!confirm("Are you sure you want to clean up test data?")) return;

    try {
      const result = await cleanupData({
        leagueId: selectedLeague || undefined,
        olderThanHours: 1,
      });
      alert(`Cleaned up: ${result.cleanup.deletedRequests} requests, ${result.cleanup.deletedMessages} messages`);
    } catch (error) {
      alert(`Error: ${error}`);
    }
  };

  if (!testingData) {
    return <div className="p-8">Loading testing data...</div>;
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Comment Request Testing Dashboard</h1>
      
      {/* League Selection */}
      <div className="mb-8 p-6 bg-gray-50 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">1. Select League</h2>
        <select 
          value={selectedLeague || ""} 
          onChange={(e) => setSelectedLeague(e.target.value as Id<"leagues">)}
          className="w-full p-2 border rounded"
        >
          <option value="">Select a league...</option>
          {testingData.leagues.map(league => (
            <option key={league._id} value={league._id}>
              {league.name} ({league.memberCount} claimed teams, {league.totalTeams} total teams)
            </option>
          ))}
        </select>
        
        {/* Debug Information */}
        {selectedLeague && debugData && (
          <div className="mt-4 p-4 bg-blue-50 rounded border">
            <h3 className="font-medium mb-2">Debug Information</h3>
            <div className="text-sm space-y-1">
              <p><strong>League:</strong> {debugData.league.name}</p>
              <p><strong>Teams:</strong> {debugData.teams.total} total</p>
              <p><strong>Team Claims:</strong> {debugData.teamClaims.total} total, {debugData.teamClaims.active} active</p>
              <p><strong>Can find users from claims:</strong> {debugData.diagnosis.canFindUsersFromClaims ? "✅ Yes" : "❌ No"}</p>
              <p><strong>Approach:</strong> {debugData.diagnosis.recommendedApproach}</p>
              
              {debugData.teamClaims.sample.length > 0 && (
                <div className="mt-2">
                  <p><strong>Sample team claims:</strong></p>
                  {debugData.teamClaims.sample.map((claim, idx) => (
                    <div key={idx} className="ml-2 text-xs">
                      • Team: {claim.teamId} → User: {claim.userId} (status: {claim.status})
                    </div>
                  ))}
                </div>
              )}
              
              {debugData.teamClaimLookups.length > 0 && (
                <div className="mt-2">
                  <p><strong>User lookups from claims:</strong></p>
                  {debugData.teamClaimLookups.map((lookup, idx) => (
                    <div key={idx} className="ml-2 text-xs">
                      • {lookup.teamName}: user {lookup.userId} → {lookup.userExists ? `✅ ${lookup.userName}` : "❌ user not found"}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Test Content Creation */}
      <div className="mb-8 p-6 bg-blue-50 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">2. Create Test Scheduled Content</h2>
        <button 
          onClick={handleCreateTestContent}
          disabled={!selectedLeague}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:bg-gray-400"
        >
          Create Test Weekly Recap (2 hours from now)
        </button>
        {selectedScheduledContent && (
          <p className="mt-2 text-sm text-gray-600">
            Selected: {selectedScheduledContent}
          </p>
        )}
      </div>

      {/* Trigger Comment Requests */}
      <div className="mb-8 p-6 bg-green-50 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">3. Trigger Comment Requests</h2>
        <div className="space-x-2">
          <button 
            onClick={handleTriggerRequests}
            disabled={!selectedScheduledContent}
            className="bg-green-600 text-white px-4 py-2 rounded disabled:bg-gray-400"
          >
            Send Comment Requests to Users
          </button>
          <button 
            onClick={handleSendPendingRequests}
            disabled={!selectedScheduledContent}
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:bg-gray-400"
          >
            Force Send Pending Requests
          </button>
        </div>
        <p className="text-sm text-gray-600 mt-2">
          Use &quot;Force Send&quot; if requests are created but stuck in pending status
        </p>
      </div>

      {/* Current Status */}
      {testStatus && (
        <div className="mb-8 p-6 bg-yellow-50 rounded-lg">
          <h2 className="text-xl font-semibold mb-4">4. Current Test Status</h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <h3 className="font-medium">Summary</h3>
              <p>Total Requests: {testStatus.summary.totalRequests}</p>
              <p>Status Breakdown: {JSON.stringify(testStatus.summary.statusBreakdown, null, 2)}</p>
              <p>Conversation States: {JSON.stringify(testStatus.summary.conversationStateBreakdown, null, 2)}</p>
            </div>
          </div>

          {/* Active Requests */}
          {testStatus.requests.length > 0 && (
            <div>
              <h3 className="font-medium mb-2">Active Requests:</h3>
              {testStatus.requests.map(request => (
                <div key={request._id} className="mb-4 p-4 border rounded bg-white">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p><strong>User:</strong> {request.userName}</p>
                      <p><strong>Status:</strong> {request.status}</p>
                      <p><strong>Conversation:</strong> {request.conversationState}</p>
                      <p><strong>Messages:</strong> {request.messageCount}</p>
                    </div>
                    <div className="text-sm text-gray-500">
                      ID: {request._id}
                    </div>
                  </div>
                  
                  {request.messages.length > 0 && (
                    <div className="mb-3">
                      <p className="font-medium">Recent Messages:</p>
                      {request.messages.map((msg, idx) => (
                        <div key={idx} className="text-sm bg-gray-100 p-2 rounded mt-1">
                          <span className="font-medium">{msg.messageType}:</span> {msg.content}
                          <span className="text-gray-500 ml-2">({msg.createdAt})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {request.status === "active" && (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={userResponse}
                        onChange={(e) => setUserResponse(e.target.value)}
                        placeholder="Enter user response..."
                        className="flex-1 p-2 border rounded"
                      />
                      <button
                        onClick={() => handleSimulateResponse(request._id)}
                        className="bg-purple-600 text-white px-4 py-2 rounded"
                      >
                        Simulate Response
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Cleanup */}
      <div className="mb-8 p-6 bg-red-50 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">5. Cleanup Test Data</h2>
        <button 
          onClick={handleCleanup}
          className="bg-red-600 text-white px-4 py-2 rounded"
        >
          Clean Up Test Data (older than 1 hour)
        </button>
      </div>

      {/* Available Data */}
      <div className="mb-8 p-6 bg-gray-50 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">Available Test Data</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <h3 className="font-medium">Leagues ({testingData.leagues.length})</h3>
            <ul className="text-sm">
              {testingData.leagues.slice(0, 3).map(league => (
                <li key={league._id}>{league.name}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-medium">Users ({testingData.users.length})</h3>
            <ul className="text-sm">
              {testingData.users.slice(0, 3).map(user => (
                <li key={user._id}>{user.name}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-medium">Recent Content ({testingData.recentScheduledContent.length})</h3>
            <ul className="text-sm">
              {testingData.recentScheduledContent.map(content => (
                <li key={content._id}>{content.contentType} - {content.status}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}