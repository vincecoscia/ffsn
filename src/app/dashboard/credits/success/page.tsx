"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, Zap, AlertCircle, CreditCard } from "lucide-react";

function CreditsPurchaseSuccessContent() {
  const [isLoading, setIsLoading] = useState(true);
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditsGranted, setCreditsGranted] = useState<number | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  
  const verifyPayment = useAction(api.stripe.verifyPaymentCompleted);

  const processPaymentSuccess = useCallback(async (sessionId: string) => {
    try {
      const paymentResult = await verifyPayment({ sessionId });
      
      if (!paymentResult.success) {
        throw new Error("Payment verification failed");
      }

      const metadata = paymentResult.session?.metadata;
      const creditsAmount = metadata?.creditsPurchased ? parseInt(metadata.creditsPurchased) : 0;

      setPaymentVerified(true);
      setCreditsGranted(creditsAmount);

    } catch (error) {
      console.error("Payment verification error:", error);
      setError(error instanceof Error ? error.message : "Payment verification failed");
    } finally {
      setIsLoading(false);
    }
  }, [verifyPayment, setPaymentVerified, setCreditsGranted, setError, setIsLoading]);

  useEffect(() => {
    const sessionId = searchParams?.get("session_id");
    
    if (!sessionId) {
      setError("No payment session found.");
      setIsLoading(false);
      return;
    }

    processPaymentSuccess(sessionId);
  }, [searchParams, processPaymentSuccess]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-4"></div>
          <p className="text-white">Verifying your payment...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-900">
        <header className="bg-gray-800 border-b border-gray-700">
          <div className="container mx-auto px-6 py-4 flex justify-between items-center">
            <Link href="/" className="text-2xl font-bold text-white cursor-pointer">
              FFSN
            </Link>
            <UserButton />
          </div>
        </header>

        <main className="container mx-auto px-6 py-8 max-w-2xl">
          <div className="text-center">
            <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-4">Verification Error</h1>
            <p className="text-gray-300 mb-6">{error}</p>
            
            <div className="space-y-2">
              <Button onClick={() => router.push("/dashboard/credits")}>
                Back to Credits
              </Button>
              <Button 
                onClick={() => router.push("/dashboard")}
                variant="outline"
              >
                Go to Dashboard
              </Button>
            </div>
          </div>
        </main>
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
            <span className="text-gray-300">Credits Purchased</span>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-2xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-black text-white mb-2">
            Credits Purchased Successfully!
          </h1>
          <p className="text-gray-400">
            Your credits have been added to your account
          </p>
        </div>

        <Card className="bg-gray-800 border-gray-700 mb-6">
          <CardHeader>
            <CardTitle className="text-white flex items-center justify-center">
              <Zap className="w-6 h-6 mr-2 text-yellow-400" />
              Purchase Complete
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            {creditsGranted && (
              <div>
                <div className="text-4xl font-bold text-yellow-400 mb-2">
                  +{creditsGranted}
                </div>
                <p className="text-gray-300">credits added to your account</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 mt-6">
              <div className="bg-gray-700/50 p-4 rounded-lg">
                <CreditCard className="w-6 h-6 text-green-400 mx-auto mb-2" />
                <p className="text-white font-medium">Payment</p>
                <p className="text-green-400 text-sm">Completed</p>
              </div>
              <div className="bg-gray-700/50 p-4 rounded-lg">
                <Zap className="w-6 h-6 text-yellow-400 mx-auto mb-2" />
                <p className="text-white font-medium">Credits</p>
                <p className="text-yellow-400 text-sm">Added</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="bg-blue-900/50 border border-blue-500 p-4 rounded-lg mb-6">
          <p className="text-blue-200 text-sm">
            🎉 <strong>Ready to create!</strong> You can now use your credits to generate AI-powered fantasy content. 
            Head to your league dashboard to start creating weekly recaps, trade analysis, and more.
          </p>
        </div>

        <div className="space-y-3">
          <Button 
            onClick={() => router.push("/dashboard")}
            className="w-full bg-red-600 hover:bg-red-700"
          >
            Go to Dashboard
          </Button>
          
        </div>
      </main>
    </div>
  );
}

export default function CreditsPurchaseSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-4"></div>
          <p className="text-white">Loading payment details...</p>
        </div>
      </div>
    }>
      <CreditsPurchaseSuccessContent />
    </Suspense>
  );
}