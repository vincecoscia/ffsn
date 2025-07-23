"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

interface InvitePageProps {
  params: {
    token: string;
  };
}

export default function InvitePage({ params }: InvitePageProps) {
  const { user, isLoaded: userLoaded } = useUser();
  const router = useRouter();
  const [isClaiming, setIsClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const invitation = useQuery(api.teamInvitations.getByToken, { 
    token: params.token 
  });
  
  const claimInvitation = useMutation(api.teamInvitations.claimInvitation);

  const handleClaimTeam = async () => {
    if (!user) {
      router.push("/sign-in");
      return;
    }

    setIsClaiming(true);
    setError(null);
    
    try {
      const leagueId = await claimInvitation({ token: params.token });
      router.push(`/leagues/${leagueId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unknown error occurred");
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
          <Link href="/" className="text-2xl font-bold text-white">
            FFSN
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
                You're Invited!
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
                    className="w-16 h-16 rounded"
                  />
                )}
                <div className="text-left">
                  <h2 className="text-2xl font-bold text-white">{invitation.teamName}</h2>
                  {invitation.teamAbbreviation && (
                    <p className="text-gray-400">{invitation.teamAbbreviation}</p>
                  )}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-400">League</div>
                  <div className="text-white font-semibold">{invitation.league?.name}</div>
                </div>
                <div>
                  <div className="text-gray-400">Season</div>
                  <div className="text-white font-semibold">2025</div>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-6">
                <p className="text-red-200">{error}</p>
              </div>
            )}

            {!user ? (
              <div className="space-y-4">
                <p className="text-gray-400 mb-4">
                  You need to sign in to claim this team
                </p>
                <div className="space-x-4">
                  <Link
                    href="/sign-in"
                    className="bg-red-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors inline-block"
                  >
                    Sign In
                  </Link>
                  <Link
                    href="/sign-up"
                    className="bg-gray-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-gray-700 transition-colors inline-block"
                  >
                    Sign Up
                  </Link>
                </div>
              </div>
            ) : (
              <button
                onClick={handleClaimTeam}
                disabled={isClaiming}
                className="bg-red-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isClaiming ? "Claiming Team..." : "Claim This Team"}
              </button>
            )}

            <div className="mt-6 text-sm text-gray-400">
              <p>
                This invitation expires on{" "}
                <span className="text-white">
                  {new Date(invitation.expiresAt).toLocaleDateString()}
                </span>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}