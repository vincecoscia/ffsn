"use client";

import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useAuthSync } from "@/hooks/use-auth-sync";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Image from "next/image";

export default function Home() {
  const { clerkUser, convexUser, isLoaded } = useAuthSync();
  const router = useRouter();

  // Redirect authenticated users with completed onboarding to dashboard
  useEffect(() => {
    if (isLoaded && clerkUser && convexUser && convexUser.hasCompletedOnboarding) {
      router.push("/dashboard");
    }
  }, [isLoaded, clerkUser, convexUser, router]);
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-red-900">
      <header className="p-6 flex justify-between items-center">
        <div className="flex items-center">
          <Image
            src="/FFSN.png"
            alt="FFSN Logo"
            width={60}
            height={40}
            className="h-10 w-auto"
          />
        </div>
        <div>
          <SignedOut>
            <div className="flex gap-3">
              <SignInButton>
                <button className="bg-transparent border border-red-600 text-red-400 px-4 py-2 rounded-lg font-semibold hover:bg-red-600 hover:text-white transition-colors">
                  Sign In
                </button>
              </SignInButton>
              <SignUpButton>
                <button className="bg-red-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-red-700 transition-colors">
                  Sign Up
                </button>
              </SignUpButton>
            </div>
          </SignedOut>
          <SignedIn>
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="text-white hover:text-red-300 transition-colors cursor-pointer">
                Dashboard
              </Link>
              <UserButton />
            </div>
          </SignedIn>
        </div>
      </header>

      <main className="container mx-auto px-6 py-16 text-center">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-6xl font-black text-white mb-6">
            Fantasy Football<br />
            <span className="text-red-400">Sports Network</span>
          </h2>
          <p className="text-xl text-gray-300 mb-8 max-w-2xl mx-auto">
            AI-powered fantasy football content that makes your league feel alive. 
            Get personalized weekly recaps, trade analysis, and power rankings written by distinct AI personalities.
          </p>
          
          <SignedOut>
            <SignUpButton>
              <button className="bg-red-600 text-white px-8 py-4 text-lg rounded-lg font-bold hover:bg-red-700 transition-all transform hover:scale-105">
                Get Started - Sign Up Free
              </button>
            </SignUpButton>
          </SignedOut>
          
          <SignedIn>
            <Link href="/dashboard" className="cursor-pointer">
              <button className="bg-red-600 text-white px-8 py-4 text-lg rounded-lg font-bold hover:bg-red-700 transition-all transform hover:scale-105">
                Go to Dashboard
              </button>
            </Link>
          </SignedIn>
        </div>

        <div className="mt-16 grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          <div className="bg-gray-800/50 p-6 rounded-lg backdrop-blur-sm">
            <h3 className="text-xl font-bold text-white mb-3">AI Writer Personas</h3>
            <p className="text-gray-300">
              5 distinct personalities from hot-take artists to data analysts create engaging content for your league
            </p>
          </div>
          <div className="bg-gray-800/50 p-6 rounded-lg backdrop-blur-sm">
            <h3 className="text-xl font-bold text-white mb-3">League-Wide Coverage</h3>
            <p className="text-gray-300">
              One subscription covers your entire league with personalized content about YOUR teams and players
            </p>
          </div>
          <div className="bg-gray-800/50 p-6 rounded-lg backdrop-blur-sm">
            <h3 className="text-xl font-bold text-white mb-3">ESPN Integration</h3>
            <p className="text-gray-300">
              Connect your ESPN league for automatic data sync and real-time analysis
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
