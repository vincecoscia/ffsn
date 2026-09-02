"use client";

import Link from "next/link";
import { SignedIn, SignedOut, SignUpButton } from "@clerk/nextjs";
import { ArrowRight, Check, Play } from "lucide-react";

import {
  SiteHeader,
  SiteFooter,
  Ticker,
  type TickerItem,
  Panel,
  SegmentSlate,
  ScoreBug,
  LowerThird,
  WriterPlate,
  type WriterPlateProps,
  PersonaAvatar,
  BannerPlaceholder,
  Chip,
  writerRoster,
  personaName,
  personaRole,
} from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const NAV = [
  { label: "Writers", href: "#writers" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
];

const FOOTER_LINKS = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Writers", href: "#writers" },
  { label: "Pricing", href: "#pricing" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Contact", href: "/contact" },
];

const TICKER_ITEMS: TickerItem[] = [
  { k: "Game of the week", v: "Lamar's Army 124.6 – Waddle It Be 122.9" },
  { k: "Top score", v: "Bijan Mustard", n: "142.8" },
  { k: "Standings", v: "Bijan Mustard 3-0 · Kittle Me This 2-1 · Run CMC 2-1" },
  { k: "Winless", v: "Nacua Matata 0-3" },
  { k: "New story", v: "Bijan Mustard Is 3-0 and Mel Diaper Would Like a Word" },
  { k: "Week 4", v: "Bijan Mustard vs Kittle Me This · proj", n: "128.4 – 121.7" },
  { k: "Waiver wire", v: "Nina Sharpe on the Week 4 claims: two numbers, one caveat" },
  { k: "The Asking Price", v: "Dex Alvarez has the Week 3 log — three adds, one completed trade" },
];

// The lineup is the roster — adding or retiring a writer in persona-prompts.ts
// changes this section with no edit here.
const WRITERS: WriterPlateProps[] = writerRoster.map((writer, index) => ({
  persona: writer.name,
  index: index + 1,
  role: writer.role,
  tagline: writer.tagline,
  beat: writer.beat,
}));

const STEPS = [
  {
    num: "01",
    meta: "Commissioner · about a minute",
    title: "Connect your ESPN league",
    body: "The commissioner links the league once. FFSN pulls in teams, standings, matchups, transactions and the whole draft — every questionable pick included.",
  },
  {
    num: "02",
    meta: "Tue recaps · Thu previews",
    title: "The writers get to work",
    body: "Recaps land Tuesday, previews Thursday, power rankings from the numbers desk, and The Asking Price whenever a trade actually happens.",
  },
  {
    num: "03",
    meta: "Every week",
    title: "Your league reads, reacts and gets quoted",
    body: "Managers claim their team, react to stories and give locker-room quotes that get worked into the next article. Say something dumb, get printed.",
  },
];

// The League Pass, spelled out (spec §10.1).
const INCLUDES = [
  "Every automated story, all season",
  "100 credits for every manager",
  "Up to 12 managers included",
  "$10 per extra manager",
  "Top up 100 credits for $5",
  "ESPN sync, all six writers",
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-bc-ground">
      <SiteHeader nav={NAV} />
      <Ticker label="Sample feed" items={TICKER_ITEMS} />

      <main className="flex-1">
        {/* HERO */}
        <section className="bc-scan relative overflow-hidden border-b border-bc-hairline bg-bc-ground px-4 py-16 sm:px-6 sm:py-20 lg:px-12 lg:py-24">
          <div
            className="pointer-events-none absolute -top-24 -right-32 h-[420px] w-[420px] opacity-70 sm:h-[600px] sm:w-[600px] lg:h-[720px] lg:w-[720px]"
            style={{
              background:
                "radial-gradient(circle, rgba(201,22,24,0.22) 0%, rgba(201,22,24,0.08) 35%, rgba(14,12,12,0) 68%)",
            }}
            aria-hidden="true"
          />
          <div className="relative grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="flex flex-col gap-7 sm:gap-8">
              <h1 className="bc-display text-bc-ink text-[38px] sm:text-[54px] lg:text-[60px] xl:text-[72px] 2xl:text-[84px]">
                The sports network that only covers{" "}
                <span className="text-bc-red-text">your league.</span>
              </h1>
              <p className="max-w-xl text-[15px] leading-relaxed text-bc-text-2 sm:text-[17px]">
                FFSN syncs with your ESPN league and puts a six-writer broadcast desk on the
                beat — weekly recaps, power rankings, transactions and draft grades about your
                teams, your trades, and your bad decisions.
              </p>
              <div className="flex flex-col gap-3.5 sm:flex-row sm:items-center">
                <SignedOut>
                  <SignUpButton mode="modal">
                    <Button type="button" variant="glow" size="lg">
                      Get started
                      <ArrowRight className="size-5" strokeWidth={2} />
                    </Button>
                  </SignUpButton>
                </SignedOut>
                <SignedIn>
                  <Button asChild variant="glow" size="lg">
                    <Link href="/dashboard">
                      Go to dashboard
                      <ArrowRight className="size-5" strokeWidth={2} />
                    </Link>
                  </Button>
                </SignedIn>
                <Button asChild variant="outline" size="lg">
                  <Link href="#sample-story">
                    <Play className="size-5" strokeWidth={2} />
                    Read a sample story
                  </Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="bc-label text-bc-text-3">ESPN sync</span>
                <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                <span className="bc-label text-bc-text-3">Six writers</span>
                <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                <span className="bc-label text-bc-text-3">
                  One price covers the whole league
                </span>
              </div>
            </div>

            {/* STUDIO MONITOR */}
            <div className="flex flex-col gap-2.5">
              <Panel
                cut="tr"
                className="relative h-[300px] overflow-hidden sm:h-[420px] lg:h-[464px]"
              >
                <div className="absolute inset-0">
                  <BannerPlaceholder gradientId="hero" />
                </div>
                <div className="bc-scan absolute inset-0" aria-hidden="true" />
                <div className="absolute top-4 left-4 flex items-center gap-2.5">
                  <span className="bc-label text-bc-text-3">Cam 2</span>
                  <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                  <span className="bc-label text-bc-text-3">Studio A</span>
                </div>
                <div className="absolute top-4 right-4">
                  <Chip live>On air</Chip>
                </div>
                {/* The score bug needs room the phone frame does not have; it returns at sm. */}
                <div className="absolute top-[96px] left-4 hidden w-[240px] sm:top-[112px] sm:block sm:w-[280px]">
                  <ScoreBug
                    mode="final"
                    strip="Week 3 · Final"
                    stripRight="Game of the week"
                    stripRightTone="highlight"
                    home={{
                      name: "Lamar's Army",
                      sub: "Priya Natarajan · 2-1",
                      score: "124.6",
                      winner: true,
                    }}
                    away={{
                      name: "Waddle It Be",
                      sub: "Chris Baptiste · 1-2",
                      score: "122.9",
                    }}
                  />
                </div>
                <div className="absolute inset-x-4 bottom-4">
                  <LowerThird
                    name={personaName("sam-ortega")}
                    role={`${personaRole("sam-ortega")} · FFSN`}
                    avatar={<PersonaAvatar persona="sam-ortega" size={56} variant="bust" />}
                    tag="Sideline"
                    note={`"I asked. Here's exactly what they said."`}
                  />
                </div>
              </Panel>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="bc-label-sm text-bc-text-3">
                  Sample coverage · The Sunday Scaries, a 10-team PPR league
                </span>
                <span className="bc-label-sm hidden text-bc-text-3 sm:inline">
                  Studio monitor
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* WRITERS */}
        <section
          id="writers"
          className="border-b border-bc-hairline bg-bc-ground px-4 py-16 sm:px-6 sm:py-20 lg:px-12 lg:py-24"
        >
          <div className="flex flex-col gap-10">
            <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[1fr_420px] lg:gap-12">
              <div className="flex flex-col gap-3.5">
                <SegmentSlate code="Seg 01" label="On-air talent" />
                <h2 className="bc-display text-bc-ink text-[32px] sm:text-[44px] lg:text-[52px]">
                  Ten teams. Six writers. Zero chill.
                </h2>
              </div>
              <p className="text-[16px] leading-relaxed text-bc-text-2 sm:text-[17px]">
                No real headshots, no real credentials, no real restraint. Six AI sportswriters,
                each with a beat, an ego and a grudge against at least one manager in your league.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
              {WRITERS.map((writer) => (
                <WriterPlate key={writer.persona} {...writer} />
              ))}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS: THE RUNDOWN */}
        <section
          id="how-it-works"
          className="border-b border-bc-hairline bg-bc-panel px-4 py-16 sm:px-6 sm:py-20 lg:px-12 lg:py-24"
        >
          <div className="flex flex-col gap-10">
            <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[1fr_420px] lg:gap-12">
              <div className="flex flex-col gap-3.5">
                <SegmentSlate code="Seg 02" label="The rundown" />
                <h2 className="bc-display text-bc-ink text-[32px] sm:text-[44px] lg:text-[52px]">
                  How the show gets made.
                </h2>
              </div>
              <p className="text-[16px] leading-relaxed text-bc-text-2 sm:text-[17px]">
                Three steps between your ESPN league and a full-blown media circus. Only the
                first one is your job.
              </p>
            </div>
            <div className="grid grid-cols-1 divide-y divide-bc-hairline border border-bc-hairline bg-bc-ground sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {STEPS.map((step) => (
                <div key={step.num} className="flex flex-col gap-5 p-7 sm:p-8 lg:p-9">
                  <div className="flex items-end justify-between gap-3">
                    <span className="bc-outline-num text-[48px] sm:text-[60px] lg:text-[72px]">
                      {step.num}
                    </span>
                    <Badge variant="outline" className="text-right whitespace-normal">
                      {step.meta}
                    </Badge>
                  </div>
                  <div className="h-[3px] w-12 bg-bc-red" aria-hidden="true" />
                  <h3 className="bc-display text-bc-ink text-[24px] sm:text-[26px] lg:text-[28px]">
                    {step.title}
                  </h3>
                  <p className="text-[15px] leading-relaxed text-bc-text-2 sm:text-[16px]">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SAMPLE STORY */}
        <section
          id="sample-story"
          className="border-b border-bc-hairline bg-bc-ground px-4 py-16 sm:px-6 sm:py-20 lg:px-12 lg:py-24"
        >
          <div className="flex flex-col gap-10">
            <div className="flex flex-col gap-3.5">
              <SegmentSlate code="Seg 03" label="Segment preview" />
              <h2 className="bc-display text-bc-ink text-[32px] sm:text-[44px] lg:text-[52px]">
                This is what your league sounds like on air.
              </h2>
            </div>
            <Panel cut="tr" className="grid grid-cols-1 lg:grid-cols-2">
              <div className="relative h-[260px] overflow-hidden border-b border-bc-hairline sm:h-[340px] lg:h-auto lg:border-r lg:border-b-0">
                <BannerPlaceholder text="WK 3" gradientId="sample-story" />
                <div className="absolute top-4 left-4 flex items-center gap-2.5">
                  <span className="bc-label text-bc-text-3">Banner image</span>
                  <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                  <span className="bc-label text-bc-text-3">16:9 slot</span>
                </div>
                <div className="absolute right-4 bottom-4">
                  <Badge variant="outline">Week 3 · Final</Badge>
                </div>
              </div>
              <div className="flex flex-col justify-center gap-5 p-6 sm:p-9 lg:p-11">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge>Weekly recap</Badge>
                  <span className="bc-label text-bc-text-3">Week 3</span>
                  <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                  <span className="bc-label text-bc-text-3">Sep 29, 2026</span>
                  <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                  <span className="bc-label text-bc-text-3">8 min read</span>
                </div>
                <h3 className="bc-display text-bc-ink text-[24px] sm:text-[28px] lg:text-[32px]">
                  {"Week 3 Recap: Lamar's Army Won by 1.7, and That's the Whole Argument"}
                </h3>
                <LowerThird
                  name={personaName("walt-brennan")}
                  role={personaRole("walt-brennan")}
                  avatar={<PersonaAvatar persona="walt-brennan" size={40} variant="bust" />}
                  compact
                />
                <p className="text-[16px] leading-relaxed text-bc-body sm:text-[17px]">
                  {
                    "I have been reading this league's box scores since 2019, and I have never seen a week turn on a Monday-night kicker the way this one did. Lamar's Army won by 1.7 points. That is not a system, it is a coin landing on its edge, and the standings are going to spend the next ten weeks treating it like a system anyway."
                  }
                </p>
              </div>
            </Panel>
          </div>
        </section>

        {/* PRICING */}
        <section
          id="pricing"
          className="border-b border-bc-hairline bg-bc-panel px-4 py-16 sm:px-6 sm:py-20 lg:px-12 lg:py-24"
        >
          <div className="flex flex-col gap-10">
            <div className="flex flex-col gap-3.5">
              <SegmentSlate code="Seg 04" label="Pricing" />
              <h2 className="bc-display text-bc-ink text-[32px] sm:text-[44px] lg:text-[52px]">
                One license. The whole league.
              </h2>
            </div>
            <div className="bc-glow">
              <Panel cut="tr" className="grid grid-cols-1 border-t-4 border-t-bc-red lg:grid-cols-[440px_1fr]">
                <div className="bc-scan flex flex-col gap-5 border-b border-bc-hairline p-8 lg:border-r lg:border-b-0 lg:p-11">
                  <span className="bc-label text-bc-text-2">Per league, per season</span>
                  <div className="flex items-start gap-1.5">
                    <span className="bc-num pt-2 text-[30px] font-bold text-bc-red-text">$</span>
                    <span className="bc-num text-[68px] leading-[0.86] font-extrabold tracking-tight text-bc-ink sm:text-[88px] lg:text-[104px]">
                      100
                    </span>
                  </div>
                  <p className="text-[15px] leading-relaxed text-bc-text-2 sm:text-[16px]">
                    {
                      "One license covers every manager in the league. Split it ten ways or make the commissioner pay. We don't judge."
                    }
                  </p>
                </div>
                <div className="flex flex-col justify-center gap-7 p-8 lg:p-11">
                  <div className="grid grid-cols-1 gap-x-6 gap-y-3.5 sm:grid-cols-2">
                    {INCLUDES.map((item) => (
                      <div
                        key={item}
                        className="flex h-11 items-center gap-3 border-b border-bc-hairline"
                      >
                        <span className="flex size-6 flex-none items-center justify-center bg-bc-red text-white">
                          <Check className="size-3.5" strokeWidth={3} />
                        </span>
                        <span className="text-[16px] font-medium text-bc-ink sm:text-[17px]">
                          {item}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    <SignedOut>
                      <SignUpButton mode="modal">
                        <Button type="button" variant="glow" size="lg">
                          Get started
                        </Button>
                      </SignUpButton>
                    </SignedOut>
                    <SignedIn>
                      <Button asChild variant="glow" size="lg">
                        <Link href="/setup">Start a league</Link>
                      </Button>
                    </SignedIn>
                    <span className="text-[14px] leading-relaxed text-bc-text-3">
                      $100 per league, per season. Every manager gets 100 credits.
                      <br />
                      Extra managers are $10 a seat; credits top up at $5 per 100.
                    </span>
                  </div>
                </div>
              </Panel>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter links={FOOTER_LINKS} />
    </div>
  );
}
