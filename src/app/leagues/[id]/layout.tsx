"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { 
  Sheet, 
  SheetContent, 
  SheetHeader, 
  SheetTitle, 
  SheetTrigger,
  SheetClose
} from "@/components/ui/sheet";
import { Menu, Home, Trophy, Calendar, BarChart3, Users, Target, Settings, Sparkles, FileText } from "lucide-react";

interface LeagueLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export default function LeagueLayout({ children, params }: LeagueLayoutProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const pathname = usePathname();
  
  // Get league data for navigation
  const league = useQuery(api.leagues.getById, { id: leagueId });

  // Helper function to check if a path is active
  const isActivePath = (path: string) => {
    if (path === `/leagues/${leagueId}`) {
      return pathname === path;
    }
    return pathname.startsWith(path);
  };

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
              <span className="text-red-200 hidden sm:inline">|</span>
              <span className="text-white font-semibold text-lg hidden sm:inline">{league.name}</span>
            </div>
            
            <div className="flex items-center gap-4">
              {/* Desktop Navigation */}
              <nav className="hidden md:flex items-center gap-6">
                <Link href={`/leagues/${league._id}/ai-generation`} className="text-white hover:text-red-200 transition-colors cursor-pointer">
                  <Sparkles className="h-5 w-5" />
                  <span className="sr-only">AI Content Generation</span>
                </Link>
                {league.role === "commissioner" && (
                  <Link href={`/leagues/${league._id}/settings`} className="text-white hover:text-red-200 transition-colors cursor-pointer">
                    Settings
                  </Link>
                )}
              </nav>
              
              {/* Mobile Menu */}
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="md:hidden text-white hover:text-red-200 hover:bg-red-700">
                    <Menu className="h-6 w-6" />
                    <span className="sr-only">Open menu</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[340px] sm:w-[400px] p-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border-slate-700">
                  <div className="flex flex-col h-full relative overflow-hidden">
                    {/* Subtle background pattern */}
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(59,130,246,0.1),transparent_70%)]"></div>
                    
                    {/* Elegant Header Section with Gradient */}
                    <div className="relative bg-gradient-to-r from-red-600 via-red-500 to-orange-500 shadow-xl">
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.1),transparent_70%)]"></div>
                      <SheetHeader className="relative p-6 pb-6">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center shadow-lg border border-white/20">
                            <span className="text-white font-black text-sm">NFL</span>
                          </div>
                          <div className="flex-1">
                            <div className="text-white/80 text-xs font-medium uppercase tracking-wider">Fantasy League</div>
                            <SheetTitle className="text-left text-white font-bold text-xl leading-tight drop-shadow-sm">
                              {league.name}
                            </SheetTitle>
                          </div>
                        </div>
                      </SheetHeader>
                    </div>
                    
                    {/* Modern Navigation Section */}
                    <nav className="flex-1 px-5 py-6 relative">
                      <div className="space-y-1.5">
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <Home className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Home</span>
                          </Link>
                        </SheetClose>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/scores`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/scores`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <Trophy className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/scores`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Scores</span>
                          </Link>
                        </SheetClose>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/schedule`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/schedule`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <Calendar className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/schedule`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Schedule</span>
                          </Link>
                        </SheetClose>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/standings`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/standings`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <BarChart3 className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/standings`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Standings</span>
                          </Link>
                        </SheetClose>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/teams`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/teams`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <Users className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/teams`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Teams</span>
                          </Link>
                        </SheetClose>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/transactions`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/transactions`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <FileText className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/transactions`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Transactions</span>
                          </Link>
                        </SheetClose>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/depth-charts`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/depth-charts`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <Target className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/depth-charts`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">Depth Charts</span>
                          </Link>
                        </SheetClose>
                        
                        {/* AI Generation for all members */}
                        <div className="h-px bg-slate-700/50 my-3 mx-4"></div>
                        <SheetClose asChild>
                          <Link 
                            href={`/leagues/${league._id}/ai-generation`}
                            className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                              isActivePath(`/leagues/${league._id}/ai-generation`)
                                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                            }`}
                          >
                            <Sparkles className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/ai-generation`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                            <span className="text-base">AI Content</span>
                          </Link>
                        </SheetClose>
                        
                        {league.role === "commissioner" && (
                          <>
                            <div className="h-px bg-slate-700/50 my-3 mx-4"></div>
                            <SheetClose asChild>
                              <Link 
                                href={`/leagues/${league._id}/settings`}
                                className={`group flex items-center gap-4 w-full px-4 py-3.5 rounded-xl font-medium transition-all duration-300 transform hover:scale-[1.02] ${
                                  isActivePath(`/leagues/${league._id}/settings`)
                                    ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg shadow-red-500/25 border border-red-400/20'
                                    : 'text-slate-300 hover:text-white hover:bg-slate-800/50 backdrop-blur-sm border border-transparent hover:border-slate-700/50'
                                }`}
                              >
                                <Settings className={`w-5 h-5 ${isActivePath(`/leagues/${league._id}/settings`) ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                                <span className="text-base">Settings</span>
                              </Link>
                            </SheetClose>
                          </>
                        )}
                      </div>
                    </nav>
                  </div>
                </SheetContent>
              </Sheet>
              
              <UserButton />
            </div>
          </div>
        </div>
      </header>

      {/* NFL Sub Navigation - Desktop Only */}
      <div className="bg-gray-800 border-b border-gray-600 hidden md:block">
        <div className="container mx-auto px-4">
          <div className="flex items-center gap-8 py-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-white rounded flex items-center justify-center">
                <span className="text-gray-800 font-bold text-sm">NFL</span>
              </div>
              <span className="text-white font-semibold">Fantasy</span>
            </div>
            <nav className="flex items-center gap-2 text-sm">
              <Link 
                href={`/leagues/${league._id}`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Home
              </Link>
              <Link 
                href={`/leagues/${league._id}/scores`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}/scores`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Scores
              </Link>
              <Link 
                href={`/leagues/${league._id}/schedule`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}/schedule`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Schedule
              </Link>
              <Link 
                href={`/leagues/${league._id}/standings`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}/standings`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Standings
              </Link>
              <Link 
                href={`/leagues/${league._id}/teams`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}/teams`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Teams
              </Link>
              <Link 
                href={`/leagues/${league._id}/transactions`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}/transactions`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Transactions
              </Link>
              <Link 
                href={`/leagues/${league._id}/depth-charts`} 
                className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                  isActivePath(`/leagues/${league._id}/depth-charts`)
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                Depth Charts
              </Link>
              {league.role === "commissioner" && (
                <Link 
                  href={`/leagues/${league._id}/settings`} 
                  className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 cursor-pointer ${
                    isActivePath(`/leagues/${league._id}/settings`)
                      ? 'bg-white text-gray-800 shadow-sm'
                      : 'text-gray-300 hover:text-white hover:bg-gray-700'
                  }`}
                >
                  Settings
                </Link>
              )}
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