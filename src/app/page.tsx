"use client";

import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { 
  Zap, 
  Users, 
  BarChart3, 
  Sparkles, 
  ArrowRight, 
  CheckCircle, 
  Star,
  TrendingUp,
  Brain,
  Globe,
  Menu,
  LayoutDashboard
} from "lucide-react";
import { useState } from "react";
// import { useAuthSync } from "@/hooks/use-auth-sync";

export default function Home() {
  // useAuthSync(); // Ensure user is synced between Clerk and Convex
  const basePrice = 99.99;
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-red-900 relative overflow-hidden">
      {/* Background decorative elements */}
      <div className="absolute inset-0 bg-[url('/grid.svg')] bg-center [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))] opacity-10"></div>
      <div className="absolute top-0 -left-4 w-72 h-72 bg-red-500 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob"></div>
      <div className="absolute top-0 -right-4 w-72 h-72 bg-purple-500 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob animation-delay-2000"></div>
      <div className="absolute -bottom-8 left-20 w-72 h-72 bg-blue-500 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob animation-delay-4000"></div>
      
      <header className="relative z-10 backdrop-blur-md bg-gray-900/20 border-b border-gray-700/30">
        <div className="container mx-auto px-4 sm:px-6 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="p-1.5 sm:p-2 bg-red-600/20 rounded-lg">
                <img
                  src="/FFSN.png"
                  alt="FFSN Logo"
                  className="h-6 sm:h-8 w-auto"
                />
              </div>
              <div>
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <h1 className="text-lg sm:text-2xl font-bold text-white">FFSN</h1>
                  <Badge className="bg-orange-600/20 text-orange-300 border-orange-600/30 text-xs px-1.5 sm:px-2 py-0.5">
                    BETA
                  </Badge>
                </div>
                <p className="text-xs text-red-300 hidden sm:block">Fantasy Sports Network</p>
              </div>
            </div>
            
            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-8 text-gray-300">
              <Link href="#features" className="hover:text-white transition-colors">Features</Link>
              <Link href="#pricing" className="hover:text-white transition-colors">Pricing</Link>
              <Link href="#about" className="hover:text-white transition-colors">About</Link>
            </nav>
            
            {/* Desktop Auth Buttons */}
            <div className="hidden md:block">
              <SignedOut>
                <div className="flex gap-2 sm:gap-3">
                  <SignInButton>
                    <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/10 text-sm sm:text-base px-3 sm:px-4">
                      Sign In
                    </Button>
                  </SignInButton>
                  <SignUpButton>
                    <Button className="bg-red-600 hover:bg-red-700 shadow-lg text-sm sm:text-base px-3 sm:px-4">
                      <Sparkles className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                      Join Beta
                    </Button>
                  </SignUpButton>
                </div>
              </SignedOut>
              <SignedIn>
                <div className="flex items-center gap-2 sm:gap-4">
                  <Link href="/dashboard">
                    <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/10 text-sm sm:text-base px-3 sm:px-4">
                      <TrendingUp className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                      Dashboard
                    </Button>
                  </Link>
                  <UserButton />
                </div>
              </SignedIn>
            </div>
            
            {/* Mobile User + Hamburger */}
            <div className="md:hidden flex items-center gap-2">
              <SignedIn>
                <UserButton />
              </SignedIn>
              <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
                <SheetTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-gray-300 hover:text-white hover:bg-white/10 p-2 rounded-lg transition-all duration-200"
                  >
                    <Menu className="h-6 w-6" />
                    <span className="sr-only">Open navigation menu</span>
                  </Button>
                </SheetTrigger>
                <SheetContent 
                  side="right" 
                  className="bg-gradient-to-b from-gray-900/98 via-gray-900/95 to-gray-800/95 backdrop-blur-xl border-l border-gray-700/50 w-80 p-0"
                >
                  <SheetHeader className="px-6 py-6 border-b border-gray-700/30">
                    <SheetTitle className="text-white text-xl font-bold flex items-center gap-3">
                      <div className="p-2 bg-red-600/20 rounded-lg">
                        <img
                          src="/FFSN.png"
                          alt="FFSN Logo"
                          className="h-6 w-auto"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        FFSN
                        <Badge className="bg-orange-600/20 text-orange-300 border-orange-600/30 text-xs px-2 py-0.5">
                          BETA
                        </Badge>
                      </div>
                    </SheetTitle>
                  </SheetHeader>
                  
                  <div className="flex flex-col h-full px-6">
                    {/* Mobile Auth Section - Now Primary */}
                    <div className="py-8">
                      <SignedOut>
                        <div className="rounded-xl border border-gray-700/40 bg-white/5 backdrop-blur-sm p-4 shadow-sm">
                          <div className="flex flex-col gap-3">
                            <SignUpButton>
                              <Button
                                size="lg"
                                className="w-full h-12 bg-red-600 hover:bg-red-700 text-white shadow-md"
                                onClick={() => setIsMobileMenuOpen(false)}
                              >
                                <Sparkles className="h-5 w-5" />
                                Join Beta
                              </Button>
                            </SignUpButton>
                            <div className="flex items-center gap-3 px-1">
                              <div className="h-px bg-gray-700/50 flex-1" />
                              <span className="text-xs text-gray-500">or</span>
                              <div className="h-px bg-gray-700/50 flex-1" />
                            </div>
                            <SignInButton>
                              <Button
                                variant="outline"
                                size="lg"
                                className="w-full h-12 border-gray-700/60 text-gray-200 hover:text-white"
                                onClick={() => setIsMobileMenuOpen(false)}
                              >
                                <Users className="h-5 w-5" />
                                Sign In
                              </Button>
                            </SignInButton>
                          </div>
                        </div>
                      </SignedOut>
                      <SignedIn>
                        <div className="flex flex-col gap-4">
                          <Link href="/dashboard" onClick={() => setIsMobileMenuOpen(false)}>
                            <Button 
                              variant="outline"
                              size="lg"
                              className="w-full h-12 border-gray-700/60 text-gray-200 hover:text-white"
                            >
                              <LayoutDashboard className="h-5 w-5" />
                              Dashboard
                            </Button>
                          </Link>
                        </div>
                      </SignedIn>
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10">
        {/* Hero Section */}
        <section className="container mx-auto px-4 sm:px-6 py-12 sm:py-16 lg:py-20 text-center">
          <div className="max-w-5xl mx-auto">
            <div className="mb-6 sm:mb-8 flex flex-col items-center gap-3 sm:gap-4">
              <Badge className="bg-orange-600/20 text-orange-300 border-orange-600/30 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold">
                🚀 NOW IN BETA
              </Badge>
              <Badge className="bg-red-600/20 text-red-300 border-red-600/30 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm">
                <Sparkles className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                USE CODE &quot;BETA50&quot; FOR 50% OFF
              </Badge>
            </div>
            
            <h1 className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-6 sm:mb-8 leading-tight">
              Fantasy Football
              <br />
              <span className="bg-gradient-to-r from-red-400 via-red-500 to-orange-500 bg-clip-text text-transparent">
                Reimagined
              </span>
            </h1>
            
            <p className="text-lg sm:text-xl lg:text-2xl text-gray-300 mb-8 sm:mb-12 max-w-3xl mx-auto leading-relaxed px-2 sm:px-0">
              Transform your league with <span className="text-white font-semibold">AI-powered content</span> that brings 
              personality, insights, and excitement to every matchup. Get personalized recaps, trade analysis, 
              and power rankings from <span className="text-red-400 font-semibold">5 distinct AI personas</span>. 
              <span className="text-orange-300 font-semibold"> Join our exclusive beta</span> and shape the future of fantasy football!
            </p>
            
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center items-center mb-10 sm:mb-16 px-4 sm:px-0">
              <SignedOut>
                <SignUpButton>
                  <Button size="lg" className="w-full sm:w-auto bg-red-600 hover:bg-red-700 px-6 sm:px-8 py-3 sm:py-4 text-base sm:text-lg font-bold shadow-2xl hover:shadow-red-500/25 transition-all transform hover:scale-105">
                    <Zap className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                    Join Beta!
                    <ArrowRight className="h-4 w-4 sm:h-5 sm:w-5 ml-2" />
                  </Button>
                </SignUpButton>
              </SignedOut>
              
              <SignedIn>
                <Link href="/dashboard" className="w-full sm:w-auto">
                  <Button size="lg" className="w-full sm:w-auto bg-red-600 hover:bg-red-700 px-6 sm:px-8 py-3 sm:py-4 text-base sm:text-lg font-bold shadow-2xl hover:shadow-red-500/25 transition-all transform hover:scale-105">
                    <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                    Go to Dashboard
                    <ArrowRight className="h-4 w-4 sm:h-5 sm:w-5 ml-2" />
                  </Button>
                </Link>
              </SignedIn>
            </div>
            
            <div className="flex flex-wrap justify-center gap-4 sm:gap-8 text-xs sm:text-sm text-gray-400 px-4 sm:px-0">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 text-green-400" />
                <span>Beta Access</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 text-green-400" />
                <span>ESPN Integration</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 text-green-400" />
                <span>Early Adopter Discount</span>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="container mx-auto px-4 sm:px-6 py-12 sm:py-16 lg:py-20">
          <div className="text-center mb-12 sm:mb-16">
            <Badge className="bg-blue-600/20 text-blue-300 border-blue-600/30 mb-4 sm:mb-6 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm">
              <Star className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
              Core Features
            </Badge>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mb-4 sm:mb-6 px-2 sm:px-0">
              Everything You Need to
              <br />
              <span className="text-red-400">Elevate Your League</span>
            </h2>
            <p className="text-lg sm:text-xl text-gray-300 max-w-2xl mx-auto px-4 sm:px-0">
              From AI-generated content to advanced analytics, we&apos;ve got everything covered to make your fantasy league legendary.
            </p>
          </div>
          
          <div className="grid sm:grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8 max-w-6xl mx-auto mb-12 sm:mb-20">
            <Card className="bg-gray-800/30 backdrop-blur-sm border-gray-700/50 hover:bg-gray-800/50 transition-all duration-300 hover:scale-105 group">
              <CardHeader className="text-center pb-3 sm:pb-4">
                <div className="mx-auto mb-3 sm:mb-4 p-2.5 sm:p-3 bg-purple-600/20 rounded-xl w-fit group-hover:bg-purple-600/30 transition-colors">
                  <Brain className="h-6 w-6 sm:h-8 sm:w-8 text-purple-400" />
                </div>
                <CardTitle className="text-xl sm:text-2xl font-bold text-white">AI Writer Personas</CardTitle>
              </CardHeader>
              <CardContent className="text-center">
                <CardDescription className="text-gray-300 text-base sm:text-lg leading-relaxed">
                  5 distinct AI personalities from hot-take artists to data analysts create engaging, 
                  personalized content that brings your league to life every week.
                </CardDescription>
                <div className="mt-3 sm:mt-4 flex flex-wrap gap-1.5 sm:gap-2 justify-center">
                  <Badge variant="secondary" className="text-xs">Hot Takes</Badge>
                  <Badge variant="secondary" className="text-xs">Data Analysis</Badge>
                  <Badge variant="secondary" className="text-xs">Comedy</Badge>
                </div>
              </CardContent>
            </Card>
            
            <Card className="bg-gray-800/30 backdrop-blur-sm border-gray-700/50 hover:bg-gray-800/50 transition-all duration-300 hover:scale-105 group">
              <CardHeader className="text-center pb-3 sm:pb-4">
                <div className="mx-auto mb-3 sm:mb-4 p-2.5 sm:p-3 bg-green-600/20 rounded-xl w-fit group-hover:bg-green-600/30 transition-colors">
                  <Users className="h-6 w-6 sm:h-8 sm:w-8 text-green-400" />
                </div>
                <CardTitle className="text-xl sm:text-2xl font-bold text-white">League-Wide Coverage</CardTitle>
              </CardHeader>
              <CardContent className="text-center">
                <CardDescription className="text-gray-300 text-base sm:text-lg leading-relaxed">
                  One subscription covers your entire league with personalized content about 
                  YOUR specific teams, players, and matchups. Everyone wins!
                </CardDescription>
                <div className="mt-3 sm:mt-4 flex flex-wrap gap-1.5 sm:gap-2 justify-center">
                  <Badge variant="secondary" className="text-xs">All Teams</Badge>
                  <Badge variant="secondary" className="text-xs">Custom Content</Badge>
                  <Badge variant="secondary" className="text-xs">Fair Pricing</Badge>
                </div>
              </CardContent>
            </Card>
            
            <Card className="bg-gray-800/30 backdrop-blur-sm border-gray-700/50 hover:bg-gray-800/50 transition-all duration-300 hover:scale-105 group">
              <CardHeader className="text-center pb-3 sm:pb-4">
                <div className="mx-auto mb-3 sm:mb-4 p-2.5 sm:p-3 bg-red-600/20 rounded-xl w-fit group-hover:bg-red-600/30 transition-colors">
                  <Globe className="h-6 w-6 sm:h-8 sm:w-8 text-red-400" />
                </div>
                <CardTitle className="text-xl sm:text-2xl font-bold text-white">ESPN Integration</CardTitle>
              </CardHeader>
              <CardContent className="text-center">
                <CardDescription className="text-gray-300 text-base sm:text-lg leading-relaxed">
                  Seamlessly connect your ESPN league for automatic data sync, real-time analysis, 
                  and instant content generation based on actual league activity.
                </CardDescription>
                <div className="mt-3 sm:mt-4 flex flex-wrap gap-1.5 sm:gap-2 justify-center">
                  <Badge variant="secondary" className="text-xs">Auto Sync</Badge>
                  <Badge variant="secondary" className="text-xs">Real-time</Badge>
                  <Badge variant="secondary" className="text-xs">Secure</Badge>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Additional Features Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 max-w-6xl mx-auto">
            <div className="text-center p-4 sm:p-6 bg-gray-800/20 rounded-xl border border-gray-700/30">
              <BarChart3 className="h-6 w-6 sm:h-8 sm:w-8 text-blue-400 mx-auto mb-2 sm:mb-3" />
              <h3 className="font-semibold text-white mb-1 sm:mb-2 text-sm sm:text-base">Advanced Analytics</h3>
              <p className="text-xs sm:text-sm text-gray-400">Deep insights and performance tracking</p>
            </div>
            <div className="text-center p-4 sm:p-6 bg-gray-800/20 rounded-xl border border-gray-700/30">
              <Zap className="h-6 w-6 sm:h-8 sm:w-8 text-yellow-400 mx-auto mb-2 sm:mb-3" />
              <h3 className="font-semibold text-white mb-1 sm:mb-2 text-sm sm:text-base">Instant Generation</h3>
              <p className="text-xs sm:text-sm text-gray-400">Content ready in seconds, not hours</p>
            </div>
            <div className="text-center p-4 sm:p-6 bg-gray-800/20 rounded-xl border border-gray-700/30">
              <TrendingUp className="h-6 w-6 sm:h-8 sm:w-8 text-green-400 mx-auto mb-2 sm:mb-3" />
              <h3 className="font-semibold text-white mb-1 sm:mb-2 text-sm sm:text-base">Power Rankings</h3>
              <p className="text-xs sm:text-sm text-gray-400">AI-driven weekly team rankings</p>
            </div>
            <div className="text-center p-4 sm:p-6 bg-gray-800/20 rounded-xl border border-gray-700/30">
              <Star className="h-6 w-6 sm:h-8 sm:w-8 text-purple-400 mx-auto mb-2 sm:mb-3" />
              <h3 className="font-semibold text-white mb-1 sm:mb-2 text-sm sm:text-base">Premium Quality</h3>
              <p className="text-xs sm:text-sm text-gray-400">Professional-grade content every time</p>
            </div>
          </div>
        </section>

        {/* Pricing Section */}
        <section id="pricing" className="container mx-auto px-4 sm:px-6 py-12 sm:py-16 lg:py-20">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-10 sm:mb-14">
              <Badge className="bg-green-600/20 text-green-300 border-green-600/30 mb-4 sm:mb-6 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm">
                Simple Pricing
              </Badge>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mb-3 sm:mb-4">
                One Price. One League.
              </h2>
              <p className="text-base sm:text-lg text-gray-300">
                $99.99 for a single league — use code <span className="font-semibold text-white">BETA50</span> for 50% off during beta.
              </p>
            </div>

            <Card className="bg-gray-800/30 backdrop-blur-sm border-gray-700/50">
              <CardContent className="p-6 sm:p-8">
                <div className="flex flex-col md:flex-row items-stretch gap-6 sm:gap-8">
                  {/* Price */}
                  <div className="flex-1 text-center md:text-left">
                    <div className="mb-2 text-gray-300 uppercase tracking-wide text-xs sm:text-sm">Single League</div>
                    <div className="flex items-end justify-center md:justify-start gap-3">
                      <div className="text-4xl sm:text-5xl lg:text-6xl font-black text-white">
                        ${basePrice.toFixed(2)}
                      </div>
                    </div>
                    <div className="mt-2 text-gray-400 text-sm sm:text-base">Use code BETA50 at checkout to save 50%.</div>
                  </div>

                  {/* Promo / CTA */}
                  <div className="flex-1">
                    <div className="">
                      <SignedOut>
                        <SignUpButton>
                          <Button className="w-full bg-red-600 hover:bg-red-700">
                            Get Started
                            <ArrowRight className="h-4 w-4 ml-2" />
                          </Button>
                        </SignUpButton>
                      </SignedOut>
                      <SignedIn>
                        <Link href="/dashboard/credits" className="block">
                          <Button className="w-full bg-red-600 hover:bg-red-700">
                            Purchase Credits
                            <ArrowRight className="h-4 w-4 ml-2" />
                          </Button>
                        </Link>
                      </SignedIn>
                      <p className="text-xs text-gray-400 mt-2">Coupon applied during checkout. One license covers your whole league.</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* CTA Section */}
        <section className="container mx-auto px-4 sm:px-6 py-12 sm:py-16 lg:py-20">
          <div className="max-w-4xl mx-auto text-center">
            <Card className="bg-gradient-to-r from-red-900/20 to-purple-900/20 border-red-500/30 backdrop-blur-sm">
              <CardContent className="p-6 sm:p-8 lg:p-12">
                <div className="mb-6 sm:mb-8">
                  <div className="inline-flex p-2.5 sm:p-3 bg-red-600/20 rounded-full mb-3 sm:mb-4">
                    <Sparkles className="h-6 w-6 sm:h-8 sm:w-8 text-red-400" />
                  </div>
                  <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black text-white mb-3 sm:mb-4 px-2 sm:px-0">
                    Ready to Join the FFSN Revolution?
                  </h2>
                  <p className="text-base sm:text-lg lg:text-xl text-gray-300 mb-6 sm:mb-8 px-2 sm:px-0">
                    Be among the first to experience the future of fantasy football. Join our exclusive beta and help shape the platform that&apos;s revolutionizing fantasy leagues everywhere.
                  </p>
                </div>
                
                <SignedOut>
                  <SignUpButton>
                    <Button size="lg" className="w-full sm:w-auto bg-red-600 hover:bg-red-700 px-8 sm:px-12 py-3 sm:py-4 text-lg sm:text-xl font-bold shadow-2xl hover:shadow-red-500/25 transition-all transform hover:scale-105">
                      <Zap className="h-5 w-5 sm:h-6 sm:w-6 mr-2" />
                      Join Beta Now
                      <ArrowRight className="h-5 w-5 sm:h-6 sm:w-6 ml-2" />
                    </Button>
                  </SignUpButton>
                </SignedOut>
                
                <SignedIn>
                  <Link href="/dashboard" className="block">
                    <Button size="lg" className="w-full sm:w-auto bg-red-600 hover:bg-red-700 px-8 sm:px-12 py-3 sm:py-4 text-lg sm:text-xl font-bold shadow-2xl hover:shadow-red-500/25 transition-all transform hover:scale-105">
                      <TrendingUp className="h-5 w-5 sm:h-6 sm:w-6 mr-2" />
                      Access Your Dashboard
                      <ArrowRight className="h-5 w-5 sm:h-6 sm:w-6 ml-2" />
                    </Button>
                  </Link>
                </SignedIn>
                
                <p className="text-xs sm:text-sm text-gray-400 mt-4 sm:mt-6 px-2 sm:px-0">
                  Beta access • Help shape the future of fantasy football
                </p>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
      
      {/* Footer */}
      <footer className="relative z-10 border-t border-gray-700/30 bg-gray-900/50 backdrop-blur-md mt-20">
        <div className="container mx-auto px-4 sm:px-6 py-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 bg-red-600/20 rounded-lg">
                  <img
                    src="/FFSN.png"
                    alt="FFSN Logo"
                    className="h-6 w-auto"
                  />
                </div>
                <h3 className="text-lg font-bold text-white">FFSN</h3>
              </div>
              <p className="text-sm text-gray-400">
                Your AI-powered fantasy football companion
              </p>
            </div>
            
            {/* Quick Links */}
            <div>
              <h4 className="text-white font-semibold mb-3">Quick Links</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/dashboard" className="text-gray-400 hover:text-white transition-colors">
                    Dashboard
                  </Link>
                </li>
                <li>
                  <Link href="#features" className="text-gray-400 hover:text-white transition-colors">
                    Features
                  </Link>
                </li>
                <li>
                  <Link href="#pricing" className="text-gray-400 hover:text-white transition-colors">
                    Pricing
                  </Link>
                </li>
              </ul>
            </div>
            
            {/* Legal */}
            <div>
              <h4 className="text-white font-semibold mb-3">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/terms" className="text-gray-400 hover:text-white transition-colors">
                    Terms of Service
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className="text-gray-400 hover:text-white transition-colors">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/contact" className="text-gray-400 hover:text-white transition-colors">
                    Contact Us
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          
          <div className="border-t border-gray-700/30 mt-8 pt-8 text-center text-sm text-gray-400">
            <p>&copy; {new Date().getFullYear()} FFSN. All rights reserved.</p>
          </div>
        </div>
      </footer>
      
      {/* Custom CSS for animations */}
      <style jsx>{`
        @keyframes blob {
          0% {
            transform: translate(0px, 0px) scale(1);
          }
          33% {
            transform: translate(30px, -50px) scale(1.1);
          }
          66% {
            transform: translate(-20px, 20px) scale(0.9);
          }
          100% {
            transform: translate(0px, 0px) scale(1);
          }
        }
        .animate-blob {
          animation: blob 7s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
      `}</style>
    </div>
  );
}
