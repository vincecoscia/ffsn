"use client";

import { useRouter } from "next/navigation";
import { UserButton } from "@/lib/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { XCircle, ArrowLeft, CreditCard } from "lucide-react";

export default function PaymentCancelledPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-white cursor-pointer">
            FFSN
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-gray-300">Payment Cancelled</span>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-2xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-yellow-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-black text-white mb-2">
            Payment Cancelled
          </h1>
          <p className="text-gray-400">
            No charges were made to your account
          </p>
        </div>

        <div className="bg-gray-800 rounded-lg p-6 space-y-6">
          <div className="text-center">
            <p className="text-gray-300 mb-4">
              You cancelled the payment process. Your league setup has not been completed and no charges were made.
            </p>
            
            <div className="bg-blue-900/50 border border-blue-500 p-4 rounded-lg text-left">
              <h3 className="text-blue-200 font-semibold mb-2">What you&apos;re missing:</h3>
              <ul className="text-blue-100 text-sm space-y-1">
                <li>• Full season fantasy league access</li>
                <li>• 1,000 AI content generation credits</li>
                <li>• Weekly recaps, previews, and analysis</li>
                <li>• Custom team roasts and power rankings</li>
                <li>• 100 bonus credits for each league member</li>
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-700 pt-6 space-y-3">
            <Button 
              onClick={() => router.push("/setup")}
              className="w-full bg-green-600 hover:bg-green-700 text-lg py-3 flex items-center justify-center"
            >
              <CreditCard className="w-5 h-5 mr-2" />
              Continue with Payment ($99.99)
            </Button>
            
            <Button 
              onClick={() => router.back()}
              variant="outline"
              className="w-full flex items-center justify-center"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to League Setup
            </Button>
            
            <Button 
              onClick={() => router.push("/dashboard")}
              variant="ghost"
              className="w-full text-gray-400 hover:text-white"
            >
              Skip for Now & Go to Dashboard
            </Button>
          </div>

          <div className="text-center pt-4 border-t border-gray-700">
            <p className="text-gray-500 text-xs">
              Need help? Contact us at support@ffsn.com
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}