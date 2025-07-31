"use client";

import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Globe
} from "lucide-react";
// import { useAuthSync } from "@/hooks/use-auth-sync";

export default function Home() {
  // useAuthSync(); // Ensure user is synced between Clerk and Convex

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
            <nav className="hidden md:flex items-center gap-8 text-gray-300">
              <Link href="#features" className="hover:text-white transition-colors">Features</Link>
              <Link href="#pricing" className="hover:text-white transition-colors">Pricing</Link>
              <Link href="#about" className="hover:text-white transition-colors">About</Link>
            </nav>
            <div>
              <SignedOut>
                <div className="flex gap-2 sm:gap-3">
                  <SignInButton>
                    <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/10 text-sm sm:text-base px-3 sm:px-4">
                      <span className="hidden sm:inline">Sign In</span>
                      <span className="sm:hidden">In</span>
                    </Button>
                  </SignInButton>
                  <SignUpButton>
                    <Button className="bg-red-600 hover:bg-red-700 shadow-lg text-sm sm:text-base px-3 sm:px-4">
                      <Sparkles className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
                      <span className="hidden sm:inline ml-2">Get Started</span>
                      <span className="sm:hidden">Start</span>
                    </Button>
                  </SignUpButton>
                </div>
              </SignedOut>
              <SignedIn>
                <div className="flex items-center gap-2 sm:gap-4">
                  <Link href="/dashboard">
                    <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/10 text-sm sm:text-base px-3 sm:px-4">
                      <TrendingUp className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
                      <span className="hidden sm:inline ml-2">Dashboard</span>
                      <span className="sm:hidden">Dash</span>
                    </Button>
                  </Link>
                  <UserButton />
                </div>
              </SignedIn>
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
                🚀 NOW IN BETA - EARLY ACCESS
              </Badge>
              <Badge className="bg-red-600/20 text-red-300 border-red-600/30 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm">
                <Sparkles className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                Powered by Advanced AI
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
                    Join Beta - Free Access
                    <ArrowRight className="h-4 w-4 sm:h-5 sm:w-5 ml-2" />
                  </Button>
                </SignUpButton>
                <SignInButton>
                  <Button variant="outline" size="lg" className="w-full sm:w-auto border-gray-600 text-gray-300 hover:bg-white/10 hover:text-white px-6 sm:px-8 py-3 sm:py-4 text-base sm:text-lg">
                    View Demo
                  </Button>
                </SignInButton>
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
                <span>Free Beta Access</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 text-green-400" />
                <span>ESPN Integration</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 text-green-400" />
                <span>Early Adopter Benefits</span>
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
                    Ready to Join the Beta Revolution?
                  </h2>
                  <p className="text-base sm:text-lg lg:text-xl text-gray-300 mb-6 sm:mb-8 px-2 sm:px-0">
                    Be among the first to experience the future of fantasy football. Join our exclusive beta and help shape the platform that&apos;s revolutionizing fantasy leagues everywhere.
                  </p>
                </div>
                
                <SignedOut>
                  <SignUpButton>
                    <Button size="lg" className="w-full sm:w-auto bg-red-600 hover:bg-red-700 px-8 sm:px-12 py-3 sm:py-4 text-lg sm:text-xl font-bold shadow-2xl hover:shadow-red-500/25 transition-all transform hover:scale-105">
                      <Zap className="h-5 w-5 sm:h-6 sm:w-6 mr-2" />
                      Join Beta Now - Free
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
                  Free beta access • No credit card required • Help shape the future of fantasy football
                </p>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
      
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
