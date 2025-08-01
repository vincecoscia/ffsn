"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { CreateLeagueForm } from "@/components/create-league-form";
import { LeagueCard } from "@/components/league-card";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useAuthSync } from "@/hooks/use-auth-sync";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, Users, TrendingUp } from "lucide-react";

export default function Dashboard() {
  const leagues = useQuery(api.leagues.getByUser);
  const { isLoaded } = useAuthSync();

  if (!isLoaded || leagues === undefined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-red-900">
        <header className="bg-gray-800/50 border-b border-gray-700/50 backdrop-blur-sm">
          <div className="container mx-auto px-6 py-4 flex justify-between items-center">
            <Skeleton className="h-8 w-16" />
            <div className="flex items-center gap-4">
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          </div>
        </header>

        <main className="container mx-auto px-6 py-8">
          <div className="mb-8">
            <Skeleton className="h-10 w-64 mb-2" />
            <Skeleton className="h-5 w-96" />
          </div>
          
          <div className="grid gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="bg-gray-800/50 border-gray-700">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div className="space-y-2">
                      <Skeleton className="h-6 w-48" />
                      <Skeleton className="h-4 w-32" />
                    </div>
                    <Skeleton className="h-4 w-20" />
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                  </div>
                  <div className="flex justify-between items-center">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-9 w-24" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-red-900">
      <header className="bg-gray-800/50 border-b border-gray-700/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-white hover:text-red-200 transition-colors cursor-pointer">
            FFSN
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-gray-300">
              <TrendingUp className="h-4 w-4" />
              <span>Dashboard</span>
            </div>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-red-600/20 rounded-lg">
              <Users className="h-8 w-8 text-red-400" />
            </div>
            <div>
              <h1 className="text-4xl font-black text-white mb-2">Your Leagues</h1>
              <p className="text-gray-300 text-lg">
                Manage your fantasy football leagues and AI-generated content
              </p>
            </div>
          </div>
        </div>

        {leagues.length === 0 ? (
          <div className="max-w-2xl mx-auto">
            <Card className="bg-gray-800/50 border-gray-700/50 backdrop-blur-sm">
              <CardHeader className="text-center pb-6">
                <div className="mx-auto mb-4 p-4 bg-red-600/20 rounded-full w-fit">
                  <Zap className="h-12 w-12 text-red-400" />
                </div>
                <CardTitle className="text-2xl font-bold text-white">Ready to get started?</CardTitle>
                <CardDescription className="text-gray-300 text-lg">
                  Create your first league to unlock AI-powered fantasy football content that will transform your league experience.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="text-center p-4 bg-gray-700/30 rounded-lg">
                    <div className="p-2 bg-blue-600/20 rounded-lg mx-auto mb-3 w-fit">
                      <Users className="h-6 w-6 text-blue-400" />
                    </div>
                    <h3 className="font-semibold text-white mb-2">Import Teams</h3>
                    <p className="text-sm text-gray-400">Connect your ESPN league and sync all team data automatically</p>
                  </div>
                  <div className="text-center p-4 bg-gray-700/30 rounded-lg">
                    <div className="p-2 bg-purple-600/20 rounded-lg mx-auto mb-3 w-fit">
                      <Zap className="h-6 w-6 text-purple-400" />
                    </div>
                    <h3 className="font-semibold text-white mb-2">AI Content</h3>
                    <p className="text-sm text-gray-400">Generate weekly recaps, power rankings, and trade analysis</p>
                  </div>
                  <div className="text-center p-4 bg-gray-700/30 rounded-lg">
                    <div className="p-2 bg-green-600/20 rounded-lg mx-auto mb-3 w-fit">
                      <TrendingUp className="h-6 w-6 text-green-400" />
                    </div>
                    <h3 className="font-semibold text-white mb-2">Analytics</h3>
                    <p className="text-sm text-gray-400">Deep insights and performance tracking for all teams</p>
                  </div>
                </div>
                <div className="text-center pt-4">
                  <CreateLeagueForm />
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h2 className="text-xl font-semibold text-white">
                  {leagues.length} League{leagues.length !== 1 ? 's' : ''}
                </h2>
                <div className="px-3 py-1 bg-red-600/20 text-red-300 text-sm rounded-full">
                  Active
                </div>
              </div>
              <CreateLeagueForm />
            </div>
            
            <div className="grid gap-6">
              {leagues.map((league) => (
                <div key={league._id} className="transform hover:scale-[1.02] transition-all duration-200">
                  <LeagueCard league={league} />
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}