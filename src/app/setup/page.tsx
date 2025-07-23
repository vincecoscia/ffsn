"use client";

import { useState } from "react";
import { useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    leagueName: "",
    platform: "espn" as const,
    externalId: "",
    scoringType: "standard", 
    rosterSize: 16,
    playoffWeeks: 3,
  });
  const [authData, setAuthData] = useState({
    espnS2: "",
    swid: "",
  });
  const [espnData, setEspnData] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingEspnData, setIsLoadingEspnData] = useState(false);
  const [espnError, setEspnError] = useState<string | null>(null);
  
  const createLeague = useMutation(api.leagues.create);
  const completeOnboarding = useMutation(api.users.completeOnboarding);
  const fetchEspnData = useAction(api.espn.fetchLeagueData);
  const syncAllLeagueData = useAction(api.espnSync.syncAllLeagueData);
  const router = useRouter();

  const loadEspnData = async () => {
    if (!formData.externalId) return;
    
    setIsLoadingEspnData(true);
    setEspnError(null);
    
    try {
      const result = await fetchEspnData({
        leagueId: formData.externalId,
        espnS2: authData.espnS2 || undefined,
        swid: authData.swid || undefined,
      });
      
      if (result.success && result.data) {
        // First set the basic ESPN data
        setEspnData(result.data);
        
        // Auto-populate form with ESPN data
        setFormData(prev => ({
          ...prev,
          leagueName: prev.leagueName || result.data.name,
          scoringType: result.data.scoringType,
          rosterSize: result.data.rosterSize,
          playoffWeeks: result.data.playoffWeeks,
        }));

        // Log historical data fetch results
        if (result.data.history && result.data.history.length > 0) {
          console.log(`✅ Historical data fetched: ${result.data.history.length} seasons found`);
        } else {
          console.log('ℹ️ No historical data found - this may be a new league or data may not be available');
        }
      } else {
        setEspnError(result.error || "Failed to load ESPN data");
      }
    } catch (error) {
      setEspnError("Failed to connect to ESPN. Please check your League ID.");
    } finally {
      setIsLoadingEspnData(false);
    }
  };

  const handleNext = async () => {
    if (step === 2 && formData.externalId && !espnData) {
      await loadEspnData();
    }
    if (step < 3) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      // Step 1: Create the basic league record
      const leagueId = await createLeague({
        name: formData.leagueName,
        platform: formData.platform,
        externalId: formData.externalId,
        settings: {
          scoringType: formData.scoringType,
          rosterSize: formData.rosterSize,
          playoffWeeks: formData.playoffWeeks,
          categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
          rosterComposition: espnData?.settings?.rosterComposition,
          playoffTeamCount: espnData?.settings?.playoffTeamCount,
          regularSeasonMatchupPeriods: espnData?.settings?.regularSeasonMatchupPeriods,
          divisions: espnData?.settings?.divisions,
        },
        espnData: espnData ? {
          seasonId: espnData.seasonId,
          currentScoringPeriod: espnData.currentScoringPeriod,
          size: espnData.size,
          lastSyncedAt: Date.now(),
          isPrivate: espnData.isPrivate || false,
          espnS2: espnData.espnS2,
          swid: espnData.swid,
        } : undefined,
        history: espnData?.history,
      });

      // Step 2: Run comprehensive data sync to populate leagueSeasons and teams tables
      console.log('🔄 Starting comprehensive league data sync...');
      const syncResult = await syncAllLeagueData({
        leagueId,
        includeCurrentSeason: true,
        historicalYears: 5, // Sync up to 5 years of historical data
      });

      if (syncResult.success) {
        console.log(`✅ League sync completed: ${syncResult.totalSynced}/${syncResult.totalYearsRequested} seasons synced`);
      } else {
        console.warn('⚠️ League sync had some issues, but league was created successfully');
      }

      // Step 3: Mark onboarding as complete
      await completeOnboarding();
      router.push("/dashboard");
    } catch (error) {
      console.error("Failed to create league:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-white">
            FFSN
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-gray-300">League Setup</span>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-white mb-2">
            Welcome to FFSN!
          </h1>
          <p className="text-gray-400">
            Let&apos;s set up your first fantasy football league to get started with AI-generated content
          </p>
        </div>

        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            {[1, 2, 3].map((num) => (
              <div key={num} className="flex items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    num <= step
                      ? "bg-red-600 text-white"
                      : "bg-gray-700 text-gray-400"
                  }`}
                >
                  {num}
                </div>
                {num < 3 && (
                  <div
                    className={`w-16 h-1 mx-2 ${
                      num < step ? "bg-red-600" : "bg-gray-700"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-center mt-2">
            <span className="text-gray-400 text-sm">
              Step {step} of 3
            </span>
          </div>
        </div>

        <div className="bg-gray-800 rounded-lg p-8">
          {step === 1 && (
            <div>
              <h2 className="text-xl font-bold text-white mb-4">
                Basic League Information
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-gray-300 mb-2">
                    League Name *
                  </label>
                  <input
                    type="text"
                    value={formData.leagueName}
                    onChange={(e) =>
                      setFormData({ ...formData, leagueName: e.target.value })
                    }
                    className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
                    placeholder="My Fantasy League"
                  />
                </div>
                <div>
                  <label className="block text-gray-300 mb-2">
                    Platform
                  </label>
                  <select
                    value={formData.platform}
                    onChange={(e) =>
                      setFormData({ ...formData, platform: e.target.value as "espn" })
                    }
                    className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
                  >
                    <option value="espn">ESPN</option>
                  </select>
                  <p className="text-gray-500 text-sm mt-1">
                    Currently only ESPN leagues are supported
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-xl font-bold text-white mb-4">
                ESPN League Connection
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-gray-300 mb-2">
                    ESPN League ID *
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={formData.externalId}
                      onChange={(e) => {
                        setFormData({ ...formData, externalId: e.target.value });
                        setEspnData(null);
                        setEspnError(null);
                      }}
                      className="flex-1 bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
                      placeholder="123456789"
                    />
                    <button
                      onClick={loadEspnData}
                      disabled={!formData.externalId || isLoadingEspnData}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoadingEspnData ? "Loading ESPN Data & History..." : "Fetch Data"}
                    </button>
                  </div>
                  <p className="text-gray-500 text-sm mt-1">
                    You can find your League ID in your ESPN league URL
                  </p>
                </div>

                {espnError && (
                  <div className="bg-red-900/50 border border-red-500 p-4 rounded-lg">
                    <p className="text-red-200 text-sm">{espnError}</p>
                    {espnError.includes("401") && (
                      <div className="mt-3 pt-3 border-t border-red-400">
                        <p className="text-red-200 text-sm font-semibold">Private League Detected</p>
                        <p className="text-red-300 text-xs mt-1">
                          Your league is private. Please provide your ESPN authentication cookies below to access it.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {(espnError?.includes("401") || authData.espnS2 || authData.swid) && (
                  <div className="bg-yellow-900/50 border border-yellow-500 p-4 rounded-lg">
                    <h3 className="text-yellow-200 font-semibold mb-2">
                      🔒 Private League Authentication
                    </h3>
                    <p className="text-yellow-100 text-sm mb-3">
                      For private leagues, you need to provide your ESPN cookies. These are safe to use and only allow read access to your league.
                    </p>
                    
                    <div className="space-y-3">
                      <div>
                        <label className="block text-yellow-200 text-sm mb-1">
                          ESPN S2 Cookie
                        </label>
                        <input
                          type="text"
                          value={authData.espnS2}
                          onChange={(e) => setAuthData({ ...authData, espnS2: e.target.value })}
                          className="w-full bg-gray-700 text-white px-3 py-2 rounded text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500"
                          placeholder="AEB..."
                        />
                      </div>
                      <div>
                        <label className="block text-yellow-200 text-sm mb-1">
                          SWID Cookie
                        </label>
                        <input
                          type="text"
                          value={authData.swid}
                          onChange={(e) => setAuthData({ ...authData, swid: e.target.value })}
                          className="w-full bg-gray-700 text-white px-3 py-2 rounded text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500"
                          placeholder="{...}"
                        />
                      </div>
                      <button
                        onClick={loadEspnData}
                        disabled={!formData.externalId || !authData.espnS2 || !authData.swid || isLoadingEspnData}
                        className="w-full px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                      >
                        {isLoadingEspnData ? "Loading ESPN Data & History..." : "Fetch Private League Data"}
                      </button>
                    </div>
                  </div>
                )}

                {espnData && (
                  <div className="bg-green-900/50 border border-green-500 p-4 rounded-lg">
                    <h3 className="text-green-200 font-semibold mb-2">
                      ✅ ESPN League Found!
                    </h3>
                    <div className="text-green-100 text-sm space-y-1">
                      <p><strong>Name:</strong> {espnData.name}</p>
                      <p><strong>Teams:</strong> {espnData.size}</p>
                      <p><strong>Scoring:</strong> {espnData.scoringType.toUpperCase()}</p>
                      <p><strong>Season:</strong> {espnData.seasonId}</p>
                      <p><strong>League Type:</strong> {espnData.isPrivate ? '🔒 Private' : '🌐 Public'}</p>
                      {espnData.history && espnData.history.length > 0 && (
                        <div className="mt-3 p-3 bg-green-800/30 rounded-lg border border-green-600/30">
                          <p className="text-green-200 font-semibold mb-2">🏆 League History Found ({espnData.history.length} seasons)</p>
                          <div className="space-y-1 text-sm">
                            {espnData.history.slice(0, 3).map((season: any) => (
                              <div key={season.seasonId} className="text-green-100">
                                <span className="font-semibold">{season.seasonId}:</span>
                                <span className="ml-1">🏆 {season.winner.teamName} ({season.winner.owner})</span>
                                {season.runnerUp && (
                                  <span className="ml-2 text-green-200">🥈 {season.runnerUp.teamName} ({season.runnerUp.owner})</span>
                                )}
                              </div>
                            ))}
                            {espnData.history.length > 3 && (
                              <p className="text-green-300 text-xs mt-2">+ {espnData.history.length - 3} more seasons found</p>
                            )}
                          </div>
                        </div>
                      )}
                      {espnData.isPrivate && (
                        <div className="mt-3 pt-2 border-t border-green-400">
                          <p className="text-green-300 text-xs">
                            🔐 Authentication credentials will be securely stored for daily data syncing
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="bg-gray-700 p-4 rounded-lg">
                  <h3 className="text-white font-semibold mb-2">
                    How to find your ESPN League ID:
                  </h3>
                  <ol className="text-gray-300 text-sm space-y-1 list-decimal list-inside">
                    <li>Go to your ESPN Fantasy Football league</li>
                    <li>Look at the URL in your browser</li>
                    <li>Find the number after &quot;leagueId=&quot; in the URL</li>
                    <li>Copy that number and paste it above</li>
                  </ol>
                </div>

                {(espnError?.includes("401") || authData.espnS2 || authData.swid) && (
                  <div className="bg-gray-700 p-4 rounded-lg">
                    <h3 className="text-white font-semibold mb-2">
                      How to find your ESPN Cookies:
                    </h3>
                    <ol className="text-gray-300 text-sm space-y-2 list-decimal list-inside">
                      <li>Go to your ESPN Fantasy league in your browser</li>
                      <li>Right-click and select &quot;Inspect Element&quot; or press F12</li>
                      <li>Go to the &quot;Application&quot; or &quot;Storage&quot; tab</li>
                      <li>Click on &quot;Cookies&quot; in the left sidebar</li>
                      <li>Click on &quot;https://fantasy.espn.com&quot;</li>
                      <li>Find and copy the values for:
                        <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                          <li><strong>espn_s2</strong> - Long string starting with &quot;AEB&quot;</li>
                          <li><strong>SWID</strong> - String in curly braces like &quot;{'{12345678-1234-1234-1234-123456789012}'}&quot;</li>
                        </ul>
                      </li>
                      <li>Paste these values in the fields above</li>
                    </ol>
                    <p className="text-yellow-300 text-xs mt-2">
                      💡 These cookies are only used to authenticate with ESPN and are never stored permanently.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-xl font-bold text-white mb-4">
                League Settings & Summary {espnData && <span className="text-green-400 text-sm">(Auto-imported from ESPN)</span>}
              </h2>
              
              {espnData && (
                <>
                  <div className="bg-blue-900/50 border border-blue-500 p-4 rounded-lg mb-4">
                    <p className="text-blue-200 text-sm">
                      🎯 Settings have been automatically imported from your ESPN league. You can adjust them below if needed.
                    </p>
                  </div>

                  {/* League Summary */}
                  <div className="bg-gray-700/50 border border-gray-600 p-4 rounded-lg mb-6">
                    <h3 className="text-white font-semibold mb-3 flex items-center">
                      📊 League Summary
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-gray-300"><strong className="text-white">League:</strong> {espnData.name}</p>
                        <p className="text-gray-300"><strong className="text-white">Teams:</strong> {espnData.size}</p>
                        <p className="text-gray-300"><strong className="text-white">Scoring:</strong> {espnData.scoringType.toUpperCase()}</p>
                        <p className="text-gray-300"><strong className="text-white">Season:</strong> {espnData.seasonId}</p>
                      </div>
                      <div>
                        <p className="text-gray-300"><strong className="text-white">Type:</strong> {espnData.isPrivate ? '🔒 Private' : '🌐 Public'}</p>
                        <p className="text-gray-300"><strong className="text-white">Playoff Teams:</strong> {espnData.settings.playoffTeamCount}</p>
                        <p className="text-gray-300"><strong className="text-white">Playoff Weeks:</strong> {espnData.settings.playoffWeeks}</p>
                        <p className="text-gray-300"><strong className="text-white">Regular Season:</strong> {espnData.settings.regularSeasonMatchupPeriods} weeks</p>
                      </div>
                    </div>

                    {/* Historical Data Display */}
                    {espnData.history && espnData.history.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-gray-600">
                        <h4 className="text-white font-semibold mb-2 flex items-center">
                          🏆 League Champions ({espnData.history.length} seasons found)
                        </h4>
                        <div className="space-y-2">
                          {espnData.history.map((season: any) => (
                            <div key={season.seasonId} className="flex flex-wrap items-center gap-2 text-sm">
                              <span className="font-semibold text-yellow-400">{season.seasonId}:</span>
                              <span className="text-green-400">🏆 {season.winner.teamName}</span>
                              <span className="text-gray-400">({season.winner.owner})</span>
                              {season.runnerUp && (
                                <>
                                  <span className="text-gray-500">•</span>
                                  <span className="text-gray-300">🥈 {season.runnerUp.teamName}</span>
                                  <span className="text-gray-400">({season.runnerUp.owner})</span>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-gray-300 mb-2">
                    Scoring Type {espnData && <span className="text-xs text-green-400">(from ESPN)</span>}
                  </label>
                  <select
                    value={formData.scoringType}
                    onChange={(e) =>
                      setFormData({ ...formData, scoringType: e.target.value })
                    }
                    className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
                  >
                    <option value="standard">Standard</option>
                    <option value="ppr">PPR (Point Per Reception)</option>
                    <option value="half-ppr">Half PPR</option>
                  </select>
                </div>
                <div>
                  <label className="block text-gray-300 mb-2">
                    Roster Size {espnData && <span className="text-xs text-green-400">(from ESPN)</span>}
                  </label>
                  <select
                    value={formData.rosterSize}
                    onChange={(e) =>
                      setFormData({ ...formData, rosterSize: parseInt(e.target.value) })
                    }
                    className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
                  >
                    <option value="14">14 players</option>
                    <option value="15">15 players</option>
                    <option value="16">16 players</option>
                    <option value="17">17 players</option>
                    <option value="18">18 players</option>
                    <option value="19">19 players</option>
                    <option value="20">20 players</option>
                  </select>
                </div>
                <div>
                  <label className="block text-gray-300 mb-2">
                    Playoff Weeks {espnData && <span className="text-xs text-green-400">(from ESPN)</span>}
                  </label>
                  <select
                    value={formData.playoffWeeks}
                    onChange={(e) =>
                      setFormData({ ...formData, playoffWeeks: parseInt(e.target.value) })
                    }
                    className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
                  >
                    <option value="1">1 week</option>
                    <option value="2">2 weeks</option>
                    <option value="3">3 weeks</option>
                    <option value="4">4 weeks</option>
                  </select>
                </div>

                {espnData?.settings?.rosterComposition && (
                  <div>
                    <label className="block text-gray-300 mb-2">
                      Roster Composition <span className="text-xs text-green-400">(from ESPN)</span>
                    </label>
                    <div className="bg-gray-700 p-3 rounded-lg">
                      <div className="grid grid-cols-4 gap-2 text-sm">
                        {Object.entries(espnData.settings.rosterComposition).map(([pos, count]) => (
                          <div key={pos} className="text-gray-300">
                            <span className="font-semibold text-white">{pos === 'DST' ? 'D/ST' : pos}:</span> {count as number}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-between mt-8">
            <button
              onClick={handleBack}
              disabled={step === 1}
              className="px-6 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Back
            </button>
            
            {step < 3 ? (
              <button
                onClick={handleNext}
                disabled={
                  (step === 1 && !formData.leagueName) ||
                  (step === 2 && !formData.externalId)
                }
                className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Creating League & Syncing Data..." : "Create League"}
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/dashboard"
            className="text-gray-400 hover:text-white transition-colors"
          >
            Skip setup and go to dashboard →
          </Link>
        </div>
      </main>
    </div>
  );
}