"use client";

import { useState, useSyncExternalStore } from "react";
import { useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Check, CreditCard, KeyRound } from "lucide-react";

import { TopBar, ThemeToggle, Panel, SectionHeader, TeamTile } from "@/components/broadcast";
import { TimezoneSelect } from "@/components/content-schedule/TimezoneSelect";
import { resolveBrowserTimeZone } from "@/components/content-schedule/timezones";

interface EspnTeam {
  id: string;
  name: string;
  abbreviation: string;
  owner: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
}

interface EspnSettings {
  scoringType: string;
  rosterComposition: Record<string, number>;
  playoffTeamCount: number;
  playoffWeeks: number;
  regularSeasonMatchupPeriods: number;
}

interface HistoricalSeason {
  seasonId: number;
  winner: {
    teamId: string;
    teamName: string;
    owner: string;
  };
  runnerUp: {
    teamId: string;
    teamName: string;
    owner: string;
  };
  regularSeasonChampion?: {
    teamId: string;
    teamName: string;
    owner: string;
  };
}

interface EspnData {
  id: string;
  name: string;
  size: number;
  scoringType: string;
  rosterSize: number;
  playoffWeeks: number;
  seasonId: number;
  currentScoringPeriod: number;
  isPrivate: boolean;
  espnS2?: string;
  swid?: string;
  teams: EspnTeam[];
  settings: EspnSettings;
  draftSettings: unknown;
  draftPicks: unknown[];
  history: HistoricalSeason[];
}

const STEPS = [
  { code: "Seg 01", label: "Connect ESPN" },
  { code: "Seg 02", label: "League details" },
  { code: "Seg 03", label: "Confirm league" },
  { code: "Seg 04", label: "License" },
];

/** The viewer's timezone never changes mid-session, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};

/** The server has no clock of its own; the picker shows its placeholder until hydration. */
const getServerTimeZone = () => "";

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {STEPS.map((s, i) => {
          const num = i + 1;
          const done = num < step;
          const current = num === step;
          return (
            <div key={s.code} className="flex items-center gap-2 sm:gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={
                    "bc-label inline-flex h-[26px] flex-none items-center px-2.5 " +
                    (done || current
                      ? "bg-bc-red text-white"
                      : "border border-bc-border-strong text-bc-text-3")
                  }
                >
                  {s.code}
                </span>
                <span
                  className={
                    "bc-label-sm " +
                    (current ? "text-bc-ink" : done ? "text-bc-text-2" : "text-bc-text-3")
                  }
                >
                  {s.label}
                </span>
              </div>
              {num < STEPS.length && (
                <span className="hidden h-px w-6 bg-bc-hairline sm:block" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
      <span className="bc-label-sm text-bc-text-3">
        Step {step} of {STEPS.length}
      </span>
    </div>
  );
}

export default function SetupPage() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    leagueName: "",
    platform: "espn" as const,
    externalId: "",
    scoringType: "standard",
    rosterSize: 16,
    playoffWeeks: 3,
    // Empty until the commissioner picks one; the browser's own zone is the default.
    timezone: "",
  });
  const [authData, setAuthData] = useState({
    espnS2: "",
    swid: "",
  });
  const [espnData, setEspnData] = useState<EspnData | null>(null);
  const [isLoadingEspnData, setIsLoadingEspnData] = useState(false);
  const [espnError, setEspnError] = useState<string | null>(null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const { user } = useUser();
  const createLeague = useMutation(api.leagues.create);

  // The league prints on one clock (spec §9.1). The browser's zone is the default, read
  // through useSyncExternalStore so the server renders a placeholder and the client fills
  // it in on hydration — no mismatch, and no wrong zone flashing on screen first.
  const detectedTimeZone = useSyncExternalStore(
    subscribeToNothing,
    resolveBrowserTimeZone,
    getServerTimeZone,
  );
  const timezone = formData.timezone || detectedTimeZone;

  const fetchEspnData = useAction(api.espn.fetchLeagueData);
  const createLeagueCheckout = useAction(api.stripe.createLeagueCheckoutSession);

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
        setFormData((prev) => ({
          ...prev,
          leagueName: prev.leagueName || result.data.name,
          scoringType: result.data.scoringType,
          rosterSize: result.data.rosterSize,
          playoffWeeks: result.data.playoffWeeks,
        }));
      } else {
        setEspnError(result.error || "Failed to load ESPN data");
      }
    } catch {
      setEspnError("Failed to connect to ESPN. Please check your League ID.");
    } finally {
      setIsLoadingEspnData(false);
    }
  };

  const handleNext = async () => {
    if (step === 2 && formData.externalId && !espnData) {
      await loadEspnData();
    }
    if (step < 4) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handlePayment = async () => {
    if (!user?.primaryEmailAddress?.emailAddress || !user?.id) {
      setPaymentError("User information not available. Please sign in again.");
      return;
    }

    setIsProcessingPayment(true);
    setPaymentError(null);

    try {
      // Step 1: Create the league with all ESPN data BEFORE payment
      const leagueId = await createLeague({
        name: formData.leagueName,
        platform: formData.platform,
        externalId: formData.externalId,
        // The clock every scheduled story prints on.
        timezone: timezone || resolveBrowserTimeZone(),
        settings: {
          scoringType: formData.scoringType,
          rosterSize: formData.rosterSize,
          playoffWeeks: formData.playoffWeeks,
          categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
          rosterComposition: espnData?.settings?.rosterComposition,
          playoffTeamCount: espnData?.settings?.playoffTeamCount,
          regularSeasonMatchupPeriods: espnData?.settings?.regularSeasonMatchupPeriods,
        },
        espnData: espnData
          ? {
              seasonId: espnData.seasonId,
              currentScoringPeriod: espnData.currentScoringPeriod,
              size: espnData.size,
              lastSyncedAt: Date.now(),
              isPrivate: espnData.isPrivate || false,
              espnS2: authData.espnS2 || undefined,
              swid: authData.swid || undefined,
            }
          : undefined,
        history: espnData?.history,
      });

      // Step 2: Create Stripe checkout session with the league ID
      const result = await createLeagueCheckout({
        leagueId: leagueId,
        leagueName: formData.leagueName,
        userEmail: user.primaryEmailAddress.emailAddress,
      });

      if (result.success && result.url) {
        // Redirect to Stripe Checkout
        window.location.href = result.url;
      } else {
        setPaymentError(result.error || "Failed to create payment session");
        // TODO: Consider deleting the created league if payment fails
      }
    } catch (error) {
      console.error("Payment error:", error);
      setPaymentError("Failed to process payment. Please try again.");
    } finally {
      setIsProcessingPayment(false);
    }
  };

  return (
    <div className="min-h-screen bg-bc-ground">
      <TopBar title="New league" subtitle="Pre-production">
        <ThemeToggle />
        <UserButton />
      </TopBar>

      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
        <div className="flex flex-col gap-3">
          <h1 className="bc-display text-bc-ink text-[32px] sm:text-[40px]">Welcome to FFSN</h1>
          <p className="text-[15px] leading-relaxed text-bc-text-2">
            Let&apos;s set up your first fantasy football league to get started with AI-generated
            content.
          </p>
        </div>

        <StepIndicator step={step} />

        <Panel padding="lg" className="flex flex-col gap-8">
          {step === 1 && (
            <div className="flex flex-col gap-6">
              <SectionHeader kicker="Seg 01" title="Basic league information" />
              <div className="flex flex-col gap-5">
                <div>
                  <Label className="text-bc-ink">League name *</Label>
                  <Input
                    type="text"
                    value={formData.leagueName}
                    onChange={(e) => setFormData({ ...formData, leagueName: e.target.value })}
                    className="mt-2"
                    placeholder="My Fantasy League"
                  />
                </div>
                <div>
                  <Label className="text-bc-ink">Platform</Label>
                  <Select
                    value={formData.platform}
                    onValueChange={(value) =>
                      setFormData({ ...formData, platform: value as "espn" })
                    }
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="espn">ESPN</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1.5 text-[13px] text-bc-text-3">
                    Currently only ESPN leagues are supported.
                  </p>
                </div>
                <div>
                  <Label htmlFor="league-timezone" className="text-bc-ink">
                    League timezone
                  </Label>
                  <TimezoneSelect
                    id="league-timezone"
                    value={timezone}
                    onChange={(zone) => setFormData({ ...formData, timezone: zone })}
                    placeholder="Detecting your timezone..."
                    className="mt-2"
                  />
                  <p className="mt-1.5 text-[13px] text-bc-text-3">
                    Stories print on this clock.
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-6">
              <SectionHeader kicker="Seg 02" title="ESPN league connection" />
              <div className="flex flex-col gap-5">
                <div>
                  <Label className="text-bc-ink">ESPN league ID *</Label>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="text"
                      value={formData.externalId}
                      onChange={(e) => {
                        setFormData({ ...formData, externalId: e.target.value });
                        setEspnData(null);
                        setEspnError(null);
                      }}
                      className="flex-1"
                      placeholder="123456789"
                    />
                    <Button
                      onClick={loadEspnData}
                      disabled={!formData.externalId || isLoadingEspnData}
                      variant="secondary"
                    >
                      {isLoadingEspnData ? "Loading data..." : "Fetch data"}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[13px] text-bc-text-3">
                    You can find your League ID in your ESPN league URL.
                  </p>
                </div>

                {espnError && (
                  <div className="border border-bc-red bg-bc-red/10 p-4">
                    <p className="text-[14px] text-bc-red-text">{espnError}</p>
                    {espnError.includes("401") && (
                      <div className="mt-3 border-t border-bc-red/30 pt-3">
                        <p className="bc-label text-bc-red-text">Private league detected</p>
                        <p className="mt-1 text-[13px] text-bc-red-text/80">
                          Your league is private. Please provide your ESPN authentication cookies
                          below to access it.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {(espnError?.includes("401") || authData.espnS2 || authData.swid) && (
                  <div className="border border-bc-signal/40 bg-bc-signal/10 p-4">
                    <h3 className="bc-label flex items-center gap-2 text-bc-signal">
                      <KeyRound className="size-4" strokeWidth={1.8} />
                      Private league authentication
                    </h3>
                    <p className="mt-2 text-[14px] leading-relaxed text-bc-text-2">
                      For private leagues, you need to provide your ESPN cookies. These are safe
                      to use and only allow read access to your league.
                    </p>

                    <div className="mt-4 flex flex-col gap-3">
                      <div>
                        <Label className="text-bc-ink">ESPN S2 cookie</Label>
                        <Input
                          type="text"
                          value={authData.espnS2}
                          onChange={(e) => setAuthData({ ...authData, espnS2: e.target.value })}
                          className="mt-1.5"
                          placeholder="AEB..."
                        />
                      </div>
                      <div>
                        <Label className="text-bc-ink">SWID cookie</Label>
                        <Input
                          type="text"
                          value={authData.swid}
                          onChange={(e) => setAuthData({ ...authData, swid: e.target.value })}
                          className="mt-1.5"
                          placeholder="{...}"
                        />
                      </div>
                      <Button
                        onClick={loadEspnData}
                        disabled={
                          !formData.externalId ||
                          !authData.espnS2 ||
                          !authData.swid ||
                          isLoadingEspnData
                        }
                        variant="signal"
                      >
                        {isLoadingEspnData ? "Loading data..." : "Fetch private league data"}
                      </Button>
                    </div>
                  </div>
                )}

                {espnData && (
                  <div className="border border-bc-win/40 bg-bc-win/10 p-4">
                    <h3 className="bc-label text-bc-win">ESPN league found</h3>
                    <div className="mt-2 flex flex-col gap-1 text-[14px] text-bc-text-2">
                      <p>
                        <strong className="text-bc-ink">Name:</strong> {espnData.name}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Teams:</strong> {espnData.size}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Scoring:</strong>{" "}
                        {espnData.scoringType.toUpperCase()}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Season:</strong> {espnData.seasonId}
                      </p>
                      <p>
                        <strong className="text-bc-ink">League type:</strong>{" "}
                        {espnData.isPrivate ? "Private" : "Public"}
                      </p>
                      {espnData.history && espnData.history.length > 0 && (
                        <div className="mt-3 border border-bc-win/30 bg-bc-win/10 p-3">
                          <p className="bc-label-sm text-bc-win">
                            League history found ({espnData.history.length} seasons)
                          </p>
                          <div className="mt-2 flex flex-col gap-1 text-[13px]">
                            {espnData.history.slice(0, 3).map((season) => (
                              <div key={season.seasonId}>
                                <span className="font-semibold text-bc-ink">
                                  {season.seasonId}:
                                </span>
                                <span className="ml-1">
                                  {season.winner.teamName} ({season.winner.owner})
                                </span>
                                {season.runnerUp && (
                                  <span className="ml-2 text-bc-text-3">
                                    runner-up {season.runnerUp.teamName} ({season.runnerUp.owner})
                                  </span>
                                )}
                              </div>
                            ))}
                            {espnData.history.length > 3 && (
                              <p className="mt-1 text-[12px] text-bc-text-3">
                                + {espnData.history.length - 3} more seasons found
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                      {espnData.isPrivate && (
                        <p className="mt-2 border-t border-bc-win/30 pt-2 text-[12px] text-bc-text-3">
                          Authentication credentials will be securely stored for daily data
                          syncing.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="border border-bc-hairline bg-bc-panel-2 p-4">
                  <h3 className="bc-label text-bc-ink">How to find your ESPN league ID</h3>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-[14px] text-bc-text-2">
                    <li>Go to your ESPN Fantasy Football league</li>
                    <li>Look at the URL in your browser</li>
                    <li>Find the number after &quot;leagueId=&quot; in the URL</li>
                    <li>Copy that number and paste it above</li>
                  </ol>
                </div>

                {(espnError?.includes("401") || authData.espnS2 || authData.swid) && (
                  <div className="border border-bc-hairline bg-bc-panel-2 p-4">
                    <h3 className="bc-label text-bc-ink">How to find your ESPN cookies</h3>
                    <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[14px] text-bc-text-2">
                      <li>Go to your ESPN Fantasy league in your browser</li>
                      <li>Right-click and select &quot;Inspect Element&quot; or press F12</li>
                      <li>Go to the &quot;Application&quot; or &quot;Storage&quot; tab</li>
                      <li>Click on &quot;Cookies&quot; in the left sidebar</li>
                      <li>Click on &quot;https://fantasy.espn.com&quot;</li>
                      <li>
                        Find and copy the values for:
                        <ul className="mt-1 ml-4 list-disc space-y-1">
                          <li>
                            <strong>espn_s2</strong> — long string starting with &quot;AEB&quot;
                          </li>
                          <li>
                            <strong>SWID</strong> — string in curly braces like &quot;
                            {"{12345678-1234-1234-1234-123456789012}"}&quot;
                          </li>
                        </ul>
                      </li>
                      <li>Paste these values in the fields above</li>
                    </ol>
                    <p className="mt-2 text-[12px] text-bc-text-3">
                      These cookies are only used to authenticate with ESPN and are never stored
                      permanently.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-6">
              <SectionHeader
                kicker="Seg 03"
                title="League settings & summary"
                actions={
                  espnData && <Badge variant="win">Auto-imported from ESPN</Badge>
                }
              />

              {espnData && (
                <>
                  <div className="border border-bc-signal/40 bg-bc-signal/10 p-4">
                    <p className="text-[14px] text-bc-signal">
                      Settings have been automatically imported from your ESPN league. You can
                      adjust them below if needed.
                    </p>
                  </div>

                  <div className="border border-bc-hairline bg-bc-panel-2 p-5">
                    <h3 className="bc-label text-bc-ink">League summary</h3>
                    <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[14px] text-bc-text-2 sm:grid-cols-2">
                      <p>
                        <strong className="text-bc-ink">League:</strong> {espnData.name}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Type:</strong>{" "}
                        {espnData.isPrivate ? "Private" : "Public"}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Teams:</strong> {espnData.size}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Playoff teams:</strong>{" "}
                        {espnData.settings.playoffTeamCount}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Scoring:</strong>{" "}
                        {espnData.scoringType.toUpperCase()}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Playoff weeks:</strong>{" "}
                        {espnData.settings.playoffWeeks}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Season:</strong> {espnData.seasonId}
                      </p>
                      <p>
                        <strong className="text-bc-ink">Regular season:</strong>{" "}
                        {espnData.settings.regularSeasonMatchupPeriods} weeks
                      </p>
                    </div>

                    {espnData.teams && espnData.teams.length > 0 && (
                      <div className="mt-4 border-t border-bc-hairline pt-4">
                        <h4 className="bc-label-sm text-bc-text-3">
                          Teams ({espnData.teams.length})
                        </h4>
                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                          {espnData.teams.map((team) => (
                            <div key={team.id} className="flex items-center gap-2.5">
                              <TeamTile initials={team.abbreviation || team.name.slice(0, 2)} size={32} />
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate text-[13px] font-medium text-bc-ink">
                                  {team.name}
                                </span>
                                <span className="bc-num text-[12px] text-bc-text-3">
                                  {team.wins}-{team.losses}
                                  {team.ties ? `-${team.ties}` : ""}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {espnData.history && espnData.history.length > 0 && (
                      <div className="mt-4 border-t border-bc-hairline pt-4">
                        <h4 className="bc-label-sm text-bc-text-3">
                          League champions ({espnData.history.length} seasons found)
                        </h4>
                        <div className="mt-2 flex flex-col gap-1.5">
                          {espnData.history.map((season) => (
                            <div
                              key={season.seasonId}
                              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
                            >
                              <span className="bc-num text-bc-red-text">{season.seasonId}:</span>
                              <span className="text-bc-ink">{season.winner.teamName}</span>
                              <span className="text-bc-text-3">({season.winner.owner})</span>
                              {season.runnerUp && (
                                <>
                                  <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                                  <span className="text-bc-text-2">
                                    {season.runnerUp.teamName}
                                  </span>
                                  <span className="text-bc-text-3">
                                    ({season.runnerUp.owner})
                                  </span>
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

              <div className="flex flex-col gap-5">
                <div>
                  <Label className="text-bc-ink">
                    Scoring type{" "}
                    {espnData && <span className="text-[12px] text-bc-win">(from ESPN)</span>}
                  </Label>
                  <Select
                    value={formData.scoringType}
                    onValueChange={(value) => setFormData({ ...formData, scoringType: value })}
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="ppr">PPR (point per reception)</SelectItem>
                      <SelectItem value="half-ppr">Half PPR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-bc-ink">
                    Roster size{" "}
                    {espnData && <span className="text-[12px] text-bc-win">(from ESPN)</span>}
                  </Label>
                  <Select
                    value={formData.rosterSize.toString()}
                    onValueChange={(value) =>
                      setFormData({ ...formData, rosterSize: parseInt(value) })
                    }
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="14">14 players</SelectItem>
                      <SelectItem value="15">15 players</SelectItem>
                      <SelectItem value="16">16 players</SelectItem>
                      <SelectItem value="17">17 players</SelectItem>
                      <SelectItem value="18">18 players</SelectItem>
                      <SelectItem value="19">19 players</SelectItem>
                      <SelectItem value="20">20 players</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-bc-ink">
                    Playoff weeks{" "}
                    {espnData && <span className="text-[12px] text-bc-win">(from ESPN)</span>}
                  </Label>
                  <Select
                    value={formData.playoffWeeks.toString()}
                    onValueChange={(value) =>
                      setFormData({ ...formData, playoffWeeks: parseInt(value) })
                    }
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 week</SelectItem>
                      <SelectItem value="2">2 weeks</SelectItem>
                      <SelectItem value="3">3 weeks</SelectItem>
                      <SelectItem value="4">4 weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {espnData?.settings?.rosterComposition && (
                  <div>
                    <Label className="text-bc-ink">
                      Roster composition{" "}
                      <span className="text-[12px] text-bc-win">(from ESPN)</span>
                    </Label>
                    <div className="mt-2 border border-bc-hairline bg-bc-panel-2 p-3">
                      <div className="grid grid-cols-3 gap-2 text-[14px] text-bc-text-2 sm:grid-cols-4">
                        {Object.entries(espnData.settings.rosterComposition).map(
                          ([pos, count]) => (
                            <div key={pos}>
                              <span className="font-semibold text-bc-ink">
                                {pos === "DST" ? "D/ST" : pos}:
                              </span>{" "}
                              {count as number}
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col gap-6">
              <SectionHeader kicker="Seg 04" title="Payment & league creation" />

              <div className="flex flex-col gap-6">
                <div className="bc-glow">
                  <Panel cut="tr" className="border-t-4 border-t-bc-red p-6">
                    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
                      <div>
                        <h3 className="bc-display text-bc-ink text-[24px]">
                          {formData.leagueName || "Your league"}
                        </h3>
                        <p className="mt-1 text-[14px] text-bc-text-2">
                          League Pass &middot; every automated story for the{" "}
                          {new Date().getFullYear()} season.
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="bc-num text-[36px] font-extrabold text-bc-ink">
                          $100
                        </div>
                        <div className="text-[13px] text-bc-text-3">per season, one payment</div>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-1 gap-2.5 border-t border-bc-hairline pt-5 sm:grid-cols-2">
                      {[
                        "Every automated story, all season long",
                        "100 credits for every manager",
                        "Up to 12 managers included",
                        "$10 per extra manager seat",
                        "Credits top up at $5 per 100",
                        "Weekly recaps, previews, power rankings",
                      ].map((item) => (
                        <div key={item} className="flex items-center gap-2.5">
                          <span className="flex size-5 flex-none items-center justify-center bg-bc-red text-white">
                            <Check className="size-3" strokeWidth={3} />
                          </span>
                          <span className="text-[14px] text-bc-text-2">{item}</span>
                        </div>
                      ))}
                    </div>

                    <p className="mt-5 border-t border-bc-hairline pt-4 text-[12px] text-bc-text-3">
                      Secure payment processed by Stripe &middot; Credits run through the end of
                      the season
                    </p>
                  </Panel>
                </div>

                {paymentError && (
                  <div className="flex items-start gap-3 border border-bc-red bg-bc-red/10 p-4">
                    <AlertCircle className="mt-0.5 size-5 flex-none text-bc-red-text" strokeWidth={1.8} />
                    <div>
                      <p className="text-[14px] font-medium text-bc-red-text">Payment error</p>
                      <p className="mt-1 text-[14px] text-bc-red-text/80">{paymentError}</p>
                    </div>
                  </div>
                )}

                <div className="border border-bc-signal/40 bg-bc-signal/10 p-4">
                  <p className="text-[14px] leading-relaxed text-bc-signal">
                    <strong>What happens next?</strong> After payment we&apos;ll create your
                    league, sync all ESPN data, and give every manager &mdash; you included &mdash;
                    100 credits. Managers past the included 12 are a $10 seat you can buy any time
                    from league settings.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-bc-hairline pt-6">
            <Button
              onClick={handleBack}
              disabled={step === 1 || isProcessingPayment}
              variant="secondary"
            >
              Back
            </Button>

            {step < 4 ? (
              <Button
                onClick={handleNext}
                disabled={
                  (step === 1 && !formData.leagueName) ||
                  (step === 2 && !formData.externalId) ||
                  (step === 3 && !espnData)
                }
                variant="glow"
              >
                Next
              </Button>
            ) : (
              <Button
                onClick={handlePayment}
                disabled={isProcessingPayment || !user}
                variant="glow"
                size="lg"
              >
                <CreditCard className="size-5" strokeWidth={1.8} />
                {isProcessingPayment ? "Processing payment..." : "Pay $100 & create league"}
              </Button>
            )}
          </div>
        </Panel>

        <div className="text-center">
          <Link href="/dashboard" className="bc-label-sm text-bc-text-3 hover:text-bc-ink">
            Skip setup and go to dashboard →
          </Link>
        </div>
      </main>
    </div>
  );
}
