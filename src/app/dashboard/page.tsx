"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { CreateLeagueForm } from "@/components/create-league-form";
import { LeagueCard } from "@/components/league-card";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useAuthSync } from "@/hooks/use-auth-sync";

export default function Dashboard() {
  const leagues = useQuery(api.leagues.getByUser);
  const { isLoaded } = useAuthSync();

  if (!isLoaded || leagues === undefined) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-white cursor-pointer">
            FFSN
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-gray-300">Dashboard</span>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-black text-white mb-2">Your Leagues</h1>
          <p className="text-gray-400">
            Create or join fantasy football leagues to get started with AI-generated content
          </p>
        </div>

        {leagues.length === 0 ? (
          <div className="text-center py-12">
            <div className="bg-gray-800 rounded-lg p-8 max-w-md mx-auto">
              <h2 className="text-xl font-bold text-white mb-4">No leagues yet</h2>
              <p className="text-gray-400 mb-6">
                Create your first league to start generating AI content for your fantasy football experience
              </p>
              <CreateLeagueForm />
            </div>
          </div>
        ) : (
          <div>
            <div className="grid gap-4 mb-8">
              {leagues.map((league) => (
                <LeagueCard key={league._id} league={league} />
              ))}
            </div>
            <div className="flex justify-center">
              <CreateLeagueForm />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}