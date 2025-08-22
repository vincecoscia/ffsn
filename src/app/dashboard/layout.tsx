"use client";

import Link from "next/link";
import { useState, PropsWithChildren } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TrendingUp, Menu, LayoutDashboard, Plus, Zap } from "lucide-react";

export default function DashboardLayout({ children }: PropsWithChildren) {
  const [isNavOpen, setIsNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-red-900">
      <header className="sticky top-0 z-40 backdrop-blur-md bg-gray-900/20 border-b border-gray-700/30">
        <div className="container mx-auto px-4 sm:px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/" className="flex items-center gap-2 sm:gap-3 cursor-pointer">
              <div className="p-1.5 sm:p-2 bg-red-600/20 rounded-lg">
                <img src="/FFSN.png" alt="FFSN Logo" className="h-6 sm:h-8 w-auto" />
              </div>
              <div>
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <span className="text-lg sm:text-2xl font-bold text-white">FFSN</span>
                  <Badge className="bg-orange-600/20 text-orange-300 border-orange-600/30 text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5">BETA</Badge>
                </div>
                <span className="text-[10px] sm:text-xs text-red-300 hidden sm:block">Fantasy Sports Network</span>
              </div>
            </Link>
            <div className="hidden sm:flex items-center gap-2 text-gray-300 ml-2">
              <TrendingUp className="h-4 w-4" />
              <span>Dashboard</span>
            </div>
          </div>

          <Sheet open={isNavOpen} onOpenChange={setIsNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="text-gray-300 hover:text-white hover:bg-white/10">
                <Menu className="h-6 w-6" />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="bg-gradient-to-b from-gray-900/98 via-gray-900/95 to-gray-800/95 backdrop-blur-xl border-l border-gray-700/50 w-80 p-0">
              <SheetHeader className="px-6 py-6 border-b border-gray-700/30">
                <SheetTitle className="text-white text-xl font-bold flex items-center gap-3">
                  <div className="p-2 bg-red-600/20 rounded-lg">
                    <img src="/FFSN.png" alt="FFSN Logo" className="h-6 w-auto" />
                  </div>
                  <div className="flex items-center gap-2">
                    FFSN
                    <Badge className="bg-orange-600/20 text-orange-300 border-orange-600/30 text-xs px-2 py-0.5">BETA</Badge>
                  </div>
                </SheetTitle>
              </SheetHeader>
              <div className="flex flex-col h-full px-6 py-5">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-3">Navigation</div>
                <div className="flex flex-col gap-2">
                  <Link href="/dashboard" onClick={() => setIsNavOpen(false)} className="cursor-pointer">
                    <Button variant="outline" className="w-full justify-start border-gray-700/60 text-gray-200 hover:text-white">
                      <LayoutDashboard className="h-4 w-4 mr-2" />
                      Dashboard
                    </Button>
                  </Link>
                  <Link href="/dashboard/credits" onClick={() => setIsNavOpen(false)} className="cursor-pointer">
                    <Button variant="outline" className="w-full justify-start border-gray-700/60 text-gray-200 hover:text-white">
                      <Zap className="h-4 w-4 mr-2" />
                      Credits
                    </Button>
                  </Link>
                  <Link href="/dashboard/settings/notifications" onClick={() => setIsNavOpen(false)} className="cursor-pointer">
                    <Button variant="outline" className="w-full justify-start border-gray-700/60 text-gray-200 hover:text-white">
                      <TrendingUp className="h-4 w-4 mr-2" />
                      Settings
                    </Button>
                  </Link>
                </div>

                <div className="border-t border-gray-700/40 mt-5 pt-5">
                  <div className="text-xs uppercase tracking-wider text-gray-500 mb-3">Quick Actions</div>
                  <div className="flex flex-col gap-2">
                    <Link href="/setup" onClick={() => setIsNavOpen(false)} className="cursor-pointer">
                      <Button className="w-full justify-start bg-red-600 hover:bg-red-700">
                        <Plus className="h-4 w-4 mr-2" />
                        Create League
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

        {children}
    </div>
  );
}


