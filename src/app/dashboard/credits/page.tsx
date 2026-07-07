"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { Zap, CreditCard, History, Plus, AlertCircle, Check, ArrowLeft } from "lucide-react";
import Link from "next/link";

const CREDIT_PACKAGES = [
  {
    id: "basic",
    name: "Basic Pack",
    credits: 100,
    price: 9.99,
    popular: false,
    description: "Perfect for occasional content generation",
    features: ["100 AI credits", "~6-8 articles", "Valid for 12 months"],
  },
  {
    id: "value",
    name: "Value Pack", 
    credits: 250,
    price: 19.99,
    popular: true,
    description: "Best value for regular users",
    features: ["250 AI credits", "~16-20 articles", "Valid for 12 months", "20% bonus credits"],
  },
  {
    id: "pro",
    name: "Pro Pack",
    credits: 500,
    price: 34.99,
    popular: false,
    description: "For power users and multiple leagues",
    features: ["500 AI credits", "~33-40 articles", "Valid for 12 months", "25% bonus credits"],
  },
];

export default function CreditsPage() {
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { user } = useUser();
  // Credit balance/history are derived from the authenticated identity on the
  // server — no user id is passed from the client.
  const userCredits = useQuery(api.credits.getUserCredits, {});
  const creditHistory = useQuery(api.credits.getCreditHistory, { limit: 10 });
  const createCreditsCheckout = useAction(api.stripe.createCreditsCheckoutSession);

  const handlePurchase = async (packageId: string) => {
    if (!user?.id || !user?.primaryEmailAddress?.emailAddress) {
      setError("Please sign in to purchase credits");
      return;
    }

    const creditPackage = CREDIT_PACKAGES.find(p => p.id === packageId);
    if (!creditPackage) return;

    setIsProcessing(true);
    setError(null);
    setSelectedPackage(packageId);

    try {
      const result = await createCreditsCheckout({
        userId: user.id,
        userEmail: user.primaryEmailAddress.emailAddress,
        creditsAmount: creditPackage.credits,
      });

      if (result.success && result.url) {
        window.location.href = result.url;
      } else {
        setError(result.error || "Failed to create checkout session");
      }
    } catch (err) {
      console.error("Credits purchase error:", err);
      setError("Failed to process purchase. Please try again.");
    } finally {
      setIsProcessing(false);
      setSelectedPackage(null);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-red-900">
    <div className="container mx-auto px-4 sm:px-6 py-6 sm:py-8 max-w-6xl">
      <div className="mb-8">

        <div className="flex justify-between items-center">
        <Button variant="secondary" className="mb-4 !bg-gray-700 !hover:bg-gray-600 text-white flex items-center">
          <Link href="/dashboard" className="text-white flex items-center">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Link>
        </Button>
        </div>
        <h1 className="text-3xl font-bold text-white mb-2 flex items-center">
          <Zap className="w-8 h-8 mr-3 text-yellow-400" />
          Credits
        </h1>
        <p className="text-gray-400">
          Purchase credits to generate AI-powered fantasy football content
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Current Balance */}
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center">
              <Zap className="w-5 h-5 mr-2 text-yellow-400" />
              Current Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-yellow-400 mb-2">
              {userCredits?.balance || 0}
            </div>
            <p className="text-gray-400 text-sm">credits available</p>
          </CardContent>
        </Card>

        {/* Lifetime Stats */}
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-white">Lifetime Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Earned:</span>
              <span className="text-green-400">{userCredits?.totalEarned || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Spent:</span>
              <span className="text-red-400">{userCredits?.totalSpent || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Purchased:</span>
              <span className="text-blue-400">{userCredits?.totalPurchased || 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Credit Costs */}
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-white">Content Costs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Weekly Recap:</span>
              <span className="text-white">15 credits</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Trade Analysis:</span>
              <span className="text-white">20 credits</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Power Rankings:</span>
              <span className="text-white">18 credits</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Custom Roast:</span>
              <span className="text-white">8 credits</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-900/50 border border-red-500 p-4 rounded-lg mb-6 flex items-start">
          <AlertCircle className="w-5 h-5 text-red-400 mr-3 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-red-200 font-medium">Purchase Error</p>
            <p className="text-red-300 text-sm mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* Credit Packages */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-4">Purchase Credits</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {CREDIT_PACKAGES.map((pkg) => (
            <Card 
              key={pkg.id} 
              className={`bg-gray-800 border-gray-700 relative ${
                pkg.popular ? 'border-red-500' : ''
              }`}
            >
              {pkg.popular && (
                <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                  <Badge className="bg-red-600 text-white">Most Popular</Badge>
                </div>
              )}
              
              <CardHeader>
                <CardTitle className="text-white flex items-center justify-between">
                  {pkg.name}
                  <div className="text-right">
                    <div className="text-2xl font-bold">${pkg.price}</div>
                    <div className="text-xs text-gray-400">one-time</div>
                  </div>
                </CardTitle>
                <CardDescription>{pkg.description}</CardDescription>
              </CardHeader>
              
              <CardContent className="space-y-4">
                <div className="text-center py-4">
                  <div className="text-4xl font-bold text-yellow-400 mb-2">
                    {pkg.credits}
                  </div>
                  <div className="text-gray-400">credits</div>
                </div>

                <ul className="space-y-2">
                  {pkg.features.map((feature, index) => (
                    <li key={index} className="flex items-center text-sm">
                      <Check className="w-4 h-4 text-green-400 mr-2 flex-shrink-0" />
                      <span className="text-gray-300">{feature}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  onClick={() => handlePurchase(pkg.id)}
                  disabled={isProcessing}
                  className={`w-full ${
                    pkg.popular 
                      ? 'bg-red-600 hover:bg-red-700' 
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  {isProcessing && selectedPackage === pkg.id ? (
                    <>
                      <CreditCard className="w-4 h-4 mr-2 animate-pulse" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-2" />
                      Purchase Credits
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Credit History */}
      <Card className="bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-white flex items-center">
            <History className="w-5 h-5 mr-2" />
            Recent Transactions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {creditHistory && creditHistory.length > 0 ? (
            <div className="space-y-3">
              {creditHistory.map((transaction) => (
                <div key={transaction.id} className="flex items-center justify-between py-3 border-b border-gray-700 last:border-b-0">
                  <div>
                    <p className="text-white font-medium">{transaction.description}</p>
                    <p className="text-gray-400 text-sm">{formatDate(transaction.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <div className={`font-bold ${
                      transaction.amount > 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {transaction.amount > 0 ? '+' : ''}{transaction.amount} credits
                    </div>
                    <div className="text-gray-400 text-sm">
                      Balance: {transaction.balanceAfter}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-400">No credit transactions yet</p>
            </div>
          )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}