"use client"

import { use } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

export default function InvitePage({ params }: InvitePageProps) {
  const { user, isLoaded: userLoaded } = useUser();
  const router = useRouter();
  const [isClaiming, setIsClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Unwrap the params Promise
  const { token } = use(params);
  
  const invitation = useQuery(api.teamInvitations.getByToken, { 
    token: token 
  });
  
  const claimInvitation = useMutation(api.teamInvitations.claimInvitation);

  const handleClaimTeam = async () => {
    if (!user) {
      // Redirect to sign-in with return URL to come back to this invite page
      router.push(`/sign-in?redirect_url=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }

    setIsClaiming(true);
    setError(null);
    
    try {
      console.log("🔄 Claiming invitation...");
      const leagueId = await claimInvitation({ token: token });
      
      console.log("✅ Invitation claimed successfully!");
      console.log("🔄 Redirecting to league:", leagueId);
      
      // Add a small delay before redirect to ensure Convex reactivity catches up
      await new Promise(resolve => setTimeout(resolve, 250));
      
      router.push(`/leagues/${leagueId}`);
    } catch (error) {
      console.error("❌ Error claiming invitation:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      
      // Provide more specific error messages based on the error
      if (errorMessage.includes("database consistency issue")) {
        setError("There was a temporary database issue. Please try again in a moment.");
      } else if (errorMessage.includes("User not found")) {
        setError("Authentication issue. Please sign out and try again.");
      } else if (errorMessage.includes("already claimed")) {
        setError("This team has already been claimed by another user.");
      } else if (errorMessage.includes("already have a team")) {
        setError("You already have a team in this league for this season.");
      } else {
        setError(`Failed to claim team: ${errorMessage}`);
      }
    } finally {
      setIsClaiming(false);
    }
  };

  if (!userLoaded || invitation === undefined) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  if (!invitation) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="bg-gray-800 rounded-lg p-8 max-w-md mx-auto text-center">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.864-.833-2.634 0L4.168 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Invalid Invitation</h1>
          <p className="text-gray-400 mb-6">
            This invitation link is invalid or has expired.
          </p>
          <Link
            href="/dashboard"
            className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors inline-block"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-red-600 border-b border-red-700">
        <div className="container mx-auto px-6 py-4">
          <Link href="/" className="flex items-center cursor-pointer">
            <img 
              src="/FFSN.png" 
              alt="FFSN Logo" 
              className="h-8 w-auto"
            />
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="bg-gray-800 rounded-lg p-8 text-center">
            <div className="mb-6">
              <div className="text-green-500 mb-4">
                <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">
                You&apos;re Invited!
              </h1>
              <p className="text-gray-400 text-lg">
                Join {invitation.league?.name} and claim your team
              </p>
            </div>

            <div className="bg-gray-700 rounded-lg p-6 mb-6">
              <div className="flex items-center justify-center gap-4 mb-4">
                {invitation.team?.logo && (
                  <img 
                    src={invitation.team.logo} 
                    alt={`${invitation.teamName} logo`}
                    className="w-16 h-16 rounded-full"
                  />
                )}
                <div>
                  <h2 className="text-2xl font-bold text-white">
                    {invitation.teamName}
                  </h2>
                  <p className="text-gray-400">
                    {invitation.league?.name}
                  </p>
                </div>
              </div>
              
              <div className="text-sm text-gray-400">
                Season: {invitation.seasonId}
              </div>
            </div>

            {error && (
              <div className="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-6">
                <p className="text-red-200">{error}</p>
                <p className="text-red-300 text-sm mt-2">
                  Please try again or contact support if the issue persists.
                </p>
              </div>
            )}

            <button
              onClick={handleClaimTeam}
              disabled={isClaiming}
              className="bg-red-600 text-white px-8 py-4 rounded-lg font-bold text-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isClaiming ? "Claiming Team..." : user ? "Claim Team" : "Sign In to Claim Team"}
            </button>

            <p className="text-gray-500 text-sm mt-4">
              {user ? "Click to claim this team and join the league" : "You&apos;ll need to sign in first to claim this team"}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}