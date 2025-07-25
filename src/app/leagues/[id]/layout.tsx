"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

interface League {
  _id: Id<"leagues">;
  name: string;
  role: "commissioner" | "member";
  platform: string;
  settings: {
    scoringType: string;
    rosterSize: number;
    playoffWeeks: number;
    categories: string[];
  };
}

interface LeagueLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export default function LeagueLayout({ children, params }: LeagueLayoutProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  
  // Get league data for navigation
  const league = useQuery(api.leagues.getById, { id: leagueId });

  if (!league) {
    return <div>Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* ESPN Main Header */}
      <header className="bg-red-600 shadow-lg">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center cursor-pointer">
                <img
                  src="/FFSN.png"
                  alt="FFSN Logo"
                  className="h-12 w-auto"
                />
              </Link>
              <span className="text-red-200">|</span>
              <span className="text-white font-semibold text-lg">{league.name}</span>
            </div>
            
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-6">
                {league.role === "commissioner" && (
                  <Link href={`/leagues/${league._id}/settings`} className="text-white hover:text-red-200 transition-colors cursor-pointer">
                    Settings
                  </Link>
                )}
              </nav>
              <UserButton />
            </div>
          </div>
        </div>
      </header>

      {/* NFL Sub Navigation */}
      <div className="bg-gray-800 border-b border-gray-600">
        <div className="container mx-auto px-4">
          <div className="flex items-center gap-8 py-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-white rounded flex items-center justify-center">
                <span className="text-gray-800 font-bold text-sm">NFL</span>
              </div>
              <span className="text-white font-semibold">Fantasy</span>
            </div>
            <nav className="flex items-center gap-6 text-sm">
              <Link href={`/leagues/${league._id}`} className="text-white hover:text-gray-300 transition-colors cursor-pointer">
                Home
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Scores
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Schedule
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Standings
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Teams
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Depth Charts
              </Link>
              {league.role === "commissioner" && (
                <Link href={`/leagues/${league._id}/settings`} className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                  Settings
                </Link>
              )}
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                More
              </Link>
            </nav>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-4 py-6">
        {children}
      </div>
    </div>
  );
}