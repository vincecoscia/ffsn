# FFSN "The Wire" — implementation spec (owner-approved 2026-09-05; P1 built the same day, dev deployment only)

The Wire is the live desk: a league-scoped timeline of short posts from the Broadcast Desk writers
reacting to NFL injuries, news, transactions, scores and league events as they happen. It ships with
the League Pass, costs no credits, and is built so the expensive part (a writer's take) is written
once for every league and the league-specific part is filled in without a model call.

Companion to `ffsn-broadcast-desk-spec.md` (roster, FACTS, verifier, relationships, pricing, quality
gates). Everything below reuses those systems rather than inventing parallel ones. §1 lists the calls
the owner has to make; §12 the sources research, including what "real time" actually costs.

---

## 1. Decisions (owner-approved 2026-09-05)

| # | Decision | Default in this spec |
|---|---|---|
| 1 | Name | **The Wire**. Posts are "posts" in code and copy. The sidebar's ESPN headline widget (`ESPNNewsWidget`, titled "NFL wire") is renamed **"Around the NFL"** so "wire" means one thing; the header ticker keeps its phase labels. |
| 2 | Entitlement | Included in the League Pass, no credit charge ever. **Global wire visible to every league**, pass or not, shown explicitly as the upsell (a `LeaguePassCard` under the free view says what a pass adds); league overlays, writer takes on league events and routine league posts are pass-only. |
| 3 | Where the model runs | One call per *global* event, batched in 10-minute windows, Sonnet 5 low effort. **Zero model calls per league** for overlays and routine posts. Rare per-league calls only for a league-only event above the interest bar (a trade, a record). |
| 4 | Language | Global posts are written **clean**. League-tier stock lines and per-league takes follow the league's `languageRating` and every manager's `cleanLanguage` opt-down, exactly as articles do. One clean global take is shareable across every league; a salty one is not. |
| 5 | Live source | ESPN's public endpoints, polled (free, no key, ~1–5 min latency, unofficial), for P1 **and** P2. Owner call: no paid feed until the product makes money. See §12 for the paid push options and why polling matches their latency. |
| 6 | Push later | Adapter interface so a paid push feed (BALLDONTLIE webhooks, Sportradar push) can replace polling without touching detectors. Deferred; revisit per §12.4 once revenue covers it. |
| 7 | Notifications | Off by default except **"my roster, high severity"** in-app. Email is a Sunday-night digest, opt-in. Push stays "future" as the schema says today. |
| 8 | Budget | Global wire spend has its own daily cap (env `WIRE_GLOBAL_DAILY_CAP_USD`, default $3) and is reported in the operator digest as a global line. Per-league wire calls count toward the league's existing $60 automation cap. |
| 9 | Writer banter | Writers replying to writers is rationed to **one thread per league per week** (P3). |

---

## 2. What the reader sees

- **`/leagues/[id]/wire`** — the timeline. Newest first, infinite scroll, live via Convex subscription.
  Each post: writer plate (avatar, name, role), timestamp, one to three sentences, a tag chip
  (`REPORTED` / `STATED` / `OPINION` / `LIVE` / `FINAL`), a source chip linking to the ESPN item, and
  for a global post that touches this league a **"quote" block underneath** with the league impact
  ("Kittle Me This loses Burrow for 6–8 weeks. $31 FAAB left, Jake Browning is the top QB on waivers.").
  Reactions: the article set (fire / lol / salty / respect).
- **League homepage** — a "The Wire" panel (last 6 posts) in the main column above the article list;
  the sidebar's ESPN headline widget stays as the raw list, retitled "Around the NFL" (§1.1).
- **Header ticker** — the last 8 wire posts replace the single "Latest story" item in
  `useLeagueTicker`; the phase/label logic (Draft order, Week N · Live, …) is unchanged.
- **Dashboard** (P3) — a cross-league wire: global posts plus the league posts about the teams this
  user has claimed, across all their leagues.
- **Nav** — "The Wire" added to the league nav in `src/app/leagues/[id]/layout.tsx` after "Home".
- **Empty states** — pre-season: "The Wire opens with the first injury report of the year"; a league
  without a pass sees the global wire and a `LeaguePassCard` beneath explaining what it is missing.

---

## 3. Architecture: three tiers, one of them paid for

```
 sources (ESPN, Sleeper, our own syncs)
   │  poll / diff                      ── deterministic, no model
   ▼
 wireEvents        one row per real-world event, global, fact card + interest score
   │
   ├─► tier 1  wirePosts (scope: global)    ONE Sonnet call per event (batched) → take + slot variants
   │
   ├─► tier 2  wireLeaguePosts (overlay)    per league: ownership lookup → fill a variant, no model
   │
   └─► tier 3  wireLeaguePosts (routine)    per league: stock lines seeded per persona/kind, no model
```

### 3.1 Tier 1 — global wire

A detector (§5) writes a `wireEvents` row with a **fact card**: player(s) by ESPN id, NFL team,
kind, before/after status, ESPN's short comment, the extracted timetable (if any, §8.3), percent
owned, trending adds, source ref. The generator turns the card into one JSON result:

```json
{
  "global":    "Burrow: broken leg, 6–8 weeks per ESPN. REPORTED. Stand by.",
  "owner":     "{team} loses {player} for {timetable}. {faab} FAAB left; {bestFA} is the best {pos} on waivers.",
  "opponent":  "{team} draws {ownerTeam} the week {player} goes down. Take the gift.",
  "freeAgent": "{backup} is the add. {trendingAdds} leagues grabbed him in the last day.",
  "tags": ["REPORTED"]
}
```

Rules: each string ≤ 280 characters; the model may only use slot tokens from the card's allowed list;
any number or proper noun not in the card fails verification (§8); a timetable phrase appears only
when the card has one. Persona per kind is fixed (§5). Sonnet 5, effort low, `cache_control` on the
persona system prompt, `GENERATION_ROUTES`-style override via env `WIRE_ROUTE_OVERRIDES`. Events
collected in a 10-minute window go out as **one call with a JSON array in and out**, so the long
persona prompt is paid once per window, not per event. The plain fact card posts immediately as a
`REPORTED` wire item with no take; the take is patched onto the same post when the batch returns
(the post shows "Dex is on it…" for those minutes). Below the interest bar (§7), the card posts
without ever calling the model.

### 3.2 Tier 2 — league overlay (no model)

For every league with an active pass, and for every global event with interest ≥ 25:

1. `leaguePlayerStatus` by (league, player): owned → owner variant; free agent → candidate for the
   free-agent variant.
2. If owned: this week's `matchups` row gives the opponent → opponent variant for that team.
3. Slots: `{team}`, `{ownerTeam}`, `{manager}` from `teams`; `{faab}` from
   `settings.faabBudget − transactionCounter.acquisitionBudgetSpent` (FAAB leagues only, else the
   sentence containing it is dropped); `{bestFA}` = highest `ownership.percentOwned` among this
   league's `free_agent` rows at the position, `trendingAdds` as tiebreak; `{backup}` from Sleeper
   depth chart order +1 on the same NFL team when that player is unrostered here; `{timetable}`,
   `{player}`, `{pos}` from the card.
4. A variant is emitted only if every slot it uses resolves; otherwise the unresolved sentence is
   dropped, and if nothing is left the overlay is skipped. Never a blank or a raw token.
5. Free-agent variant only when `{backup}` or `{bestFA}` resolves **and** the player was rostered in
   ≥ 30% of leagues (ESPN `percentOwned`) or trending ≥ 500 adds; otherwise no overlay.
6. Language: the filled sentence is then decorated by the league's language allowance exactly like a
   stock line (§3.3); the base text is clean.
7. **Draft phase (owner, 2026-09-05).** A REDRAFT league before its draft (`draftInfo.drafted === false`,
   no keeper slots, the `isPreDraftRedraft` rule) has no rosters and no waiver wire: it sees the global
   wire only, no overlays. A KEEPER league before its draft keeps owner notes for players already
   kept (FAAB and best-free-agent sentences drop, no opponent note), and an unrostered but
   high-profile player gets a **draftBoard** variant instead of freeAgent: "{player} is still on the
   board in this league. ADP {adp}, {adpRank} before this. Draft accordingly." (ADP from the FFC intel
   boards; the sentence drops when there is none). An unsynced draft state counts as drafted so real
   rosters are never hidden.

Overlay rows carry `impact: { teamId, variant, slots }` so the UI can render the team tile and the
verifier can re-check the fill.

### 3.3 Tier 3 — routine league posts (no model)

Hand-written stock lines per persona per event kind, ≥ 20 per (persona, kind), with slot tokens and
a language floor tag like the voice samples. Chosen by `fnv1a(leagueId:week:kind:seq)` so the same
line is never used twice in a week in one league and different leagues see different lines. Kinds:
week final, game of the week, top score, low score, bench points, waiver claim processed (with bid),
add/drop, IR move, lineup lock warning, streak, clinch, elimination, league record. Lines respect
`languageRating` (floor/ceiling) and `cleanLanguage` for the mentioned manager.

---

## 4. Data model (`convex/schema.ts`)

```ts
wireEvents: defineTable({
  kind: v.string(),                    // "injury_status" | "injury_note" | "news" | "depth_chart" | "trending"
                                       // | "game_started" | "score" | "scoring_play" | "game_final" | ...
  scope: v.literal("global"),
  dedupeKey: v.string(),               // e.g. "injury_status:3116389:2026-09-04T20:24Z"
  observedAt: v.number(),              // the source's own timestamp when it has one
  detectedAt: v.number(),
  players: v.array(v.object({ espnId: v.string(), name: v.string(), position: v.optional(v.string()), nflTeam: v.optional(v.string()) })),
  nflTeam: v.optional(v.string()),
  facts: v.any(),                      // the fact card (validated by src/lib/ai/wire/card.ts)
  interest: v.number(),                // 0–100, §7
  source: v.object({ type: v.string(), id: v.optional(v.string()), url: v.optional(v.string()), fetchedAt: v.number() }),
  coalescedInto: v.optional(v.id("wireEvents")),
})
  .index("by_dedupe", ["dedupeKey"])
  .index("by_detected", ["detectedAt"])
  .index("by_player_detected", ["players", "detectedAt"]),   // see note: implement as by_kind_detected + in-memory filter if arrays index poorly

wirePosts: defineTable({                 // global tier
  eventId: v.id("wireEvents"),
  persona: v.string(),
  text: v.string(),                    // the global take, or the plain card rendering
  tags: v.array(v.string()),
  variants: v.optional(v.object({ owner: v.optional(v.string()), opponent: v.optional(v.string()), freeAgent: v.optional(v.string()) })),
  status: v.union(v.literal("card"), v.literal("take_pending"), v.literal("take"), v.literal("held")),
  interest: v.number(),
  generationStats: v.optional(v.object({ costUsd: v.number(), model: v.string(), effort: v.string(), batchId: v.optional(v.string()), flags: v.array(v.string()) })),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_created", ["createdAt"])
  .index("by_event", ["eventId"])
  .index("by_interest_created", ["interest", "createdAt"]),

wireLeaguePosts: defineTable({           // league tier: overlays and routine posts
  leagueId: v.id("leagues"),
  seasonId: v.number(),
  week: v.optional(v.number()),
  kind: v.string(),
  persona: v.string(),
  text: v.string(),
  tags: v.array(v.string()),
  globalPostId: v.optional(v.id("wirePosts")),     // set for overlays; the UI nests this under the global post
  impact: v.optional(v.object({ teamId: v.id("teams"), variant: v.string(), slots: v.record(v.string(), v.string()) })),
  featuredTeams: v.array(v.id("teams")),
  dedupeKey: v.string(),
  generationStats: v.optional(v.object({ costUsd: v.number(), model: v.string(), effort: v.string() })),
  createdAt: v.number(),
})
  .index("by_league_created", ["leagueId", "createdAt"])
  .index("by_league_dedupe", ["leagueId", "dedupeKey"])
  .index("by_global_post", ["globalPostId"]),

wireReactions: defineTable({             // P3, mirrors articleReactions
  postId: v.union(v.id("wirePosts"), v.id("wireLeaguePosts")),
  leagueId: v.id("leagues"),
  userId: v.string(),
  reaction: v.union(v.literal("fire"), v.literal("lol"), v.literal("salty"), v.literal("respect")),
  createdAt: v.number(),
}).index("by_post", ["postId"]).index("by_post_user", ["postId", "userId"]),

wireSourceState: defineTable({           // one row per source: cursor + health (the intelSyncRuns idea, with a cursor)
  source: v.string(),                  // "espn_injuries" | "espn_news" | "espn_scoreboard" | "espn_summary:<eventId>" | ...
  cursor: v.optional(v.any()),         // last-seen ids/dates so a poll diffs instead of re-reading
  lastRunAt: v.number(),
  ok: v.boolean(),
  summary: v.string(),
  error: v.optional(v.string()),
}).index("by_source", ["source"]),
```

Additions to existing tables: `leagueContentPreferences.wireEnabled?: boolean` (absent = on),
`users.preferences.wireAlerts?: "off" | "my_roster" | "all"` (absent = `my_roster`),
`userNotifications.type` gains `"wire_alert"`, `relatedEntityType` gains `"wire_post"`.
`convex/lib/feedFreshness.ts`'s `FeedName` gains `"espn_injuries"` and `"espn_scoreboard"`.

**Reading a league's wire.** Two paginated reactive queries merged in the client hook
(`useLeagueWire`): `wire.getGlobalPosts({ minInterest })` on `by_created` and
`wire.getLeaguePosts({ leagueId })` on `by_league_created`; overlays are attached to their global
post by `globalPostId`. No per-league copy of global posts is stored. Pass check in the league query
via `credits.hasActivePass`; the global query is open to any signed-in league member.

---

## 5. Event catalogue

Cadence "existing" means the detector hangs off a sync that already runs. Persona is fixed per kind.

### 5.1 Global (tier 1 / plain card)

| Kind | Detector | Source, cadence | Persona | Take? |
|---|---|---|---|---|
| `injury_status` | `type.abbreviation` changed for an athlete (A→Q/O/IR/D, or back) | ESPN injuries feed (§12.1), every 5 min in season, 30 min otherwise | Dex | interest ≥ 50 |
| `injury_note` | new `date` on an entry with unchanged status (practice report, coach quote, timetable) | same | Dex | ≥ 50 |
| `news` | new `espnNews` row tagged to ≤ 3 athletes (listicle filter as in `intel.ts`) | ESPN news, poll moves from hourly to every 5 min in season | Dex | ≥ 50 |
| `depth_chart` | Sleeper `depth_chart_order` change into slot 1 | existing 4-hourly Sleeper sync | Dex | ≥ 50 |
| `trending` | `trendingAdds` ≥ 1,000 or top 5 movers | existing 6-hourly trending sync | Nina | ≥ 50 |
| `game_started` / `game_final` | `status.type.state` pre→in / in→post | ESPN scoreboard (§9) | Curtis | card only; Curtis's stock rundown line |
| `scoring_play` | new `scoringPlays[]` item | ESPN summary per live game (§9) | Reggie (TD ≥ 40 yds or 3rd+ TD of the day), else card | ≥ 60 |
| `big_line` | a player crosses 100 rush/rec yds, 300 pass yds, 3 TD | ESPN summary boxscore | Reggie | ≥ 60 |
| `bust_watch` | a top-24 ADP player finishes a game under 5 fantasy points | ESPN summary + FFC ADP | Mel | ≥ 60, max 3 per Sunday |
| `weather` | wind ≥ 20 mph or precipitation at kickoff | `weatherData` when populated (not P1) | Nina | card |

### 5.2 League (tier 2 overlay / tier 3 routine)

| Kind | Detector | Source, cadence | Persona | Post type |
|---|---|---|---|---|
| overlay of any global kind | §3.2 | on global event | inherits | overlay |
| `waiver_processed` | new `transactions` rows with `outcome` executed/failed, type WAIVER | existing 4-hourly transaction-log sync (Wed morning) | Dex | stock line with bid, losing bids, FAAB left |
| `add_drop` | new ADD/DROP transaction | same | Dex | stock line |
| `trade` | `tradesSync` inserted a trade | existing (`trade_occurred`) | Dex | per-league take (one call, Opus low) — the trade_analysis article follows 30 min later as today |
| `ir_move` | lineup slot → IR | existing roster sync | Dex | stock line |
| `lineup_lock_warning` | a starter is O/IR/D 60 min before his kickoff | game clock (§9) + `teams.roster.lineupSlotId` + injury status | Dex → the manager only (§10) | stock line, DM-level |
| `matchup_live` | lead change / margin > 40 / comeback from −25 | per-league live pull (§9) | Curtis | stock line |
| `monday_needs` | Sunday night: trailing team's Monday players vs deficit | same | Nina | stock line with the number |
| `week_final` | all matchups have `winner` | existing + live | Curtis | stock lines: finals, game of the week |
| `top_score` / `low_score` / `bench_points` | after `week_final` | existing | Reggie / Walt / Nina | stock lines |
| `streak` / `clinch` / `elimination` | standings diff after `week_final` | existing (`playoffs.ts`) | Curtis | stock line |
| `league_record` | new all-time high/low (`getTopScoresAllTime`) | after `week_final` | Reggie | stock line |
| `article_published` | `finalizeGeneratedArticle` published | existing | the byline | stock line + link |
| `claim_settled` | `resolveOpenClaims` | existing Tuesday cron | Nina | stock line ("Nina called it", record) |
| `relationship_tier` | tier crossed in `writerRelationships` | existing | the writer | stock line |
| `quote_approved` | manager approved a pull quote | existing | Sam | stock line with the quote |

Retired personas never post. Sam posts only quotes and "asked, no comment yet" lines. Walt posts at
most once per league per Sunday evening. Mel posts only draft-anchored items.

---

## 6. Detection mechanics

- **Diff, don't infer.** Every source keeps a cursor in `wireSourceState` (ESPN injuries: entry `id`
  → `date`; scoreboard: event id → `status.type.name` + score; summary: last `scoringPlays[].id`;
  news: newest `published`). A poll emits events only for changed keys. Replays never double-post
  because `wireEvents.by_dedupe` is checked in the same mutation that inserts.
- **Coalesce.** A second event for the same player within 60 minutes updates the first
  (`coalescedInto`), and the global post is edited with an "UPDATE:" line rather than a new post. A
  status *change* always wins over a note.
- **Player identity.** ESPN's injuries feed omits `athlete.id` in the site API payload; parse it from
  `athlete.links[].href` (`/nfl/player/_/id/{id}/…`), which matches `playersEnhanced.espnId`. News
  already carries athlete ids. Sleeper and nflverse map through `playerIdMap` as today.
- **Sleeper players dump stays daily-ish.** Its docs ask for at most one call a day; the existing
  4-hourly cadence is already generous. It is never a live source.
- **Game windows come from the scoreboard**, never a hard-coded Thursday/Sunday/Monday. (2026's week
  1 opens on Wednesday, 9 September, per the scoreboard probe.)

---

## 7. Interest score

`interest = base(kind, transition) + min(50, percentOwned / 2) + bonuses`, clamped 0–100.

| Component | Value |
|---|---|
| base: status → OUT / IR / season-ending | 60 |
| base: status → Doubtful | 45 |
| base: status → Questionable | 30 |
| base: status → Active (return) | 35 |
| base: note with a timetable, status unchanged | 40 |
| base: note without a timetable | 15 |
| base: news headline | 20 |
| base: depth chart into slot 1 | 30 |
| base: trending spike | 20 |
| bonus: multi-week timetable | +15 |
| bonus: QB / top-12 ADP at position | +10 |
| penalty: same player already posted within 6 h | −20 |

Thresholds: ≥ 50 → tier-1 take; 25–49 → plain card; < 25 → stored event, not posted. A league
overlay adds a local bonus (+20 if the player is in a starting slot in that league) before the ≥ 25
check, so a bench-level global card can still surface for the one league where he starts.

---

## 8. Generation, verification, language

### 8.1 Prompt layer (`src/lib/ai/wire/`)

- `card.ts` — `WireFactCard` type + `buildFactCard(event)`; the only object the model sees.
- `take.ts` — `prepareWireTakeRequest(cards[], persona)` and `parseWireTakes(message)`; system prompt
  = persona voice block (from `persona-prompts.ts`, same bytes as articles → cache hit) + a short
  Wire contract: length, slot tokens, "only what is on the card", tag vocabulary, clean language.
- `fill.ts` — pure `fillVariant(template, slots)`; refuses unresolved tokens; unit-tested.
- `stock-lines.ts` — the tier-3 library with `pickStockLine(persona, kind, seed, rating)`.
- `verify.ts` — reuses `fact-verifier.ts`: `findRegisterLeaks` (no "FACTS", ids, ISO dates), plus a
  numbers-and-names check against the card, plus `cleanTeamViolations` / `countProfanity` from
  `language.ts` on the filled league text. A failed take falls back to the plain card
  (`status: "card"`, flag recorded); it never holds for review — the Wire is too fast for a queue.
- `interest.ts` — §7 as a pure function.
- `timetable.ts` — §8.3.

### 8.2 Convex (`convex/wire*.ts`)

- `wireSources.ts` (actions; `fetch` only, no Node): `pollEspnInjuries`, `pollEspnNews`,
  `pollScoreboard`, `pollGameSummary`, `pollLeagueLive`. Each returns a result object, never throws
  (the `intelSync.ts` contract), and records `wireSourceState`.
- `wireDetect.ts` (mutations): `ingestInjuryEntries`, `ingestScoreboard`, … → `wireEvents` +
  immediate plain-card `wirePosts`; enqueue for the take batch when interest ≥ 50.
- `wireGenerate.ts` (`"use node"`): `flushTakeBatch` every 10 minutes (cron) — one Anthropic call per
  persona with all pending cards; `computeCostUsd` as articles; patches posts.
- `wireOverlay.ts` (mutations): `fanOutGlobalPost(postId)` → per pass-holding league, §3.2.
- `wireRoutine.ts` (mutations): hooks called from the existing syncs (`upsertTransactions`,
  `updateMatchups`, `finalizeGeneratedArticle`, `resolveOpenClaims`, relationship tier change).
- `wireLive.ts`: the game clock (§9).
- `wire.ts` (public queries/mutations): `getGlobalPosts`, `getLeaguePosts`, `react`, `setWireEnabled`.
- `http.ts` (P2+, only if a push source is bought): `POST /wire/webhook/<source>` with signature
  verification; body treated as `unknown` and narrowed.

### 8.3 Timetables

Only from ESPN text (`shortComment`, `longComment`, news `description`). Patterns:
`(\d+)\s*(?:-|–|to)\s*(\d+)\s*weeks?`, `(\d+)\s*weeks?`, `(?:rest of|remainder of) the season|season[- ]ending|out for the (?:year|season)`,
`week[- ]to[- ]week`, `day[- ]to[- ]day`, `multiple weeks`. The card stores the matched phrase
verbatim and the model may only repeat it. No match → the card has no timetable and the take must
say so or say nothing about it. Never a medical guess.

### 8.4 Cost (estimate; measure with `computeCostUsd` before P1 ships)

| Item | Estimate |
|---|---|
| One take set (Sonnet 5 low, cached persona prompt, ~400 in / ~250 out) | about half a cent |
| Global events clearing the take bar per in-season week | ~150 (57 ESPN injury-feed updates in the 24 h before this spec was written, pre-season) |
| Global wire per week, shared by every league | ≈ $1 |
| Per-league overlay + routine posts | $0 |
| Per-league trade takes (Opus low) | ≈ 2¢ each, a few per season |
| Live game engine | ESPN calls, not tokens (§9.3) |

Compared with the measured $0.206 per article, the Wire is noise on the pass margin.

---

## 9. Live game engine (P2)

### 9.1 Game clock

`internal.wireLive.tick` is a self-rescheduling action, not a cron:

1. Fetch the scoreboard. Update `wireSourceState:espn_scoreboard`, emit `game_started` /
   `game_final` / score events.
2. For every game with `state === "in"`: fetch `summary?event=` (scoring plays, boxscore) and emit
   `scoring_play` / `big_line` / `bust_watch` events.
3. Every 5th tick while any game is live: per pass-holding league, one ESPN fantasy pull with
   `view=mMatchupScore&view=mBoxscore&scoringPeriodId=N`, diffed against the last snapshot → league
   live events (`matchup_live`, `monday_needs`, `lineup_lock_warning` uses the pre-kickoff tick).
4. Reschedule itself: 60 s while any game is live; otherwise at the next kickoff − 5 min from the
   scoreboard; otherwise (no games this week) exit. A singleton `wireSourceState:clock` row holds the
   scheduled function id so two clocks never run; a daily cron `ensureWireClock` re-arms it if it
   died. Env `WIRE_LIVE=0` stops the clock at the next tick.

### 9.2 Latency

ESPN's scoreboard and summary update within seconds of the broadcast; a 60-second tick gives ~1–2 min
end-to-end including the Convex write and the client subscription. That is the same order as the
paid webhook option's own stated delay (§12.2). Injuries and news poll every 5 minutes in season.

### 9.3 ESPN call budget (per Sunday, ~10 live hours)

Scoreboard 600 + summaries ~14 games × ~200 ticks ≈ 2,800 + per-league fantasy pulls
~120 × leagues. At 50 leagues that is ~9,400 unauthenticated calls in a day, spread over 10 hours.
Well under what the ESPN app itself does per user, but unofficial — see §12.5 for the failure plan.

---

## 10. Notifications

- New notification type `wire_alert`. Created only for an **owner-variant overlay with interest ≥ 70**
  (a starter goes OUT/IR/season-ending, a lock warning) for the users who have claimed that team
  (`teamClaims`), respecting `users.preferences.wireAlerts` (`my_roster` default, `all`, `off`) and the
  league's `wireEnabled`.
- `dedupeKey = "wire:<eventId>:<teamId>"` through `notifications.createNotification`; `groupKey`
  `wire-digest:<leagueId>:<yyyy-mm-dd>` so the email path can fold a day into one message.
- Email: a Sunday-night "Your wire" digest (Broadcast email shell in `src/lib/email`), opt-in via the
  existing `emailNotifications` preference plus `wireAlerts !== "off"`. No per-post emails.
- `lineup_lock_warning` is the one post delivered to the manager **before** it is visible to the
  league: it posts to the league feed at kickoff ("X started Y, who was inactive") only if the lineup
  was not fixed — the warning itself is private.

---

## 11. Guardrails and operations

- **Rate limits.** Global: at most 40 takes per hour (overflow posts as cards). Per league: at most
  15 posts per hour and 80 per day; overflow dropped lowest-interest first; `week_final` and its
  follow-ups are exempt (they happen together by design).
- **Gambling.** ESPN payloads carry odds and win probability; the card never includes them and the
  Wire never posts them.
- **Accuracy.** Register-leak + card check on every take; stock lines and fills are template-checked
  in tests; a `held` status exists only for operator inspection, never for the reader.
- **Kill switches.** League `wireEnabled` (settings page toggle, commissioner); user `wireAlerts`;
  env `WIRE_ENABLED`, `WIRE_LIVE`, `WIRE_GLOBAL_DAILY_CAP_USD`; reaching the cap posts cards only.
- **Operator digest** gains a Wire line: events / posts / takes / fallbacks-to-card / global cost /
  source health (`formatFeedFreshness` with the two new feeds), plus per-league post counts.
- **Dev tool.** `internal.devTools.runWireEventNow({ kind, espnId, leagueId?, statusTo? })`
  synthesizes an event and runs detect → take → overlay on the dev deployment only (same guard as
  `runScheduledPipelineNow`).
- **Eval.** `scripts/eval-wire.ts` (`npm run eval:wire [--live]`): offline mode runs detectors and
  fills against fixtures in `tests/fixtures/wire/` (trimmed ESPN injuries, news, scoreboard, summary
  and fantasy boxscore payloads captured at build time); live mode generates takes for the fixture
  cards and scores facts / voice / slot-correctness 1–5 with the existing rubric harness. Gate to
  ship Sonnet: facts ≥ 4, zero card violations; otherwise the route falls to Opus low.
- **Tests.** `tests/wireDetectors.test.ts`, `wireInterest.test.ts`, `wireFill.test.ts`,
  `wireStockLines.test.ts` (every line parses, every token known, rating tags valid),
  `wireTimetable.test.ts`, `wireRateLimit.test.ts`, `wireOverlay.test.ts` (convex-test: pass gating,
  FAAB math, best-FA choice, unresolved-slot drop), `wireQueries.test.ts` (authz: non-member refused).

---

## 12. Sources: what is free, what is real time, what it costs

Probed 2026-09-05 from this machine; prices from vendor pages the same day. Nothing here is an
endorsement of an unofficial endpoint's stability — see §12.5.

### 12.1 Free, no key, polled (P1 and P2 run on these)

| Source | What it gives the Wire | Freshness | Notes |
|---|---|---|---|
| ESPN injuries `site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` | every team's injury/notes entries: `status`, `type.abbreviation` (A/Q/O/IR/D), `date` (update time), `shortComment`, `longComment`, athlete name/position/team, player id in `links[].href` | entries timestamped to the minute; 800 entries, 57 updated in the prior 24 h | **~9 MB per call** → poll every 5 min in season, not every minute. The per-team variant returns `{}`; the `sports.core` per-team list returns `$ref`s only. |
| ESPN news `…/nfl/news?limit=100` | headlines tagged to athletes and teams | minutes | already synced hourly (`espnNews.ts`); the Wire polls it every 5 min in season. Use `site.web.api.espn.com` to avoid the 403 the codebase already documents. |
| ESPN scoreboard `…/nfl/scoreboard` (`?dates=YYYYMMDD`, `?seasontype=2&week=N`) | game state (`pre`/`in`/`post`), clock, period, scores, linescores, `playByPlayAvailable`, kickoff times | seconds | 16 events, ~250 KB. Week 1 2026 opens Wed 9 Sep 20:20 ET (Patriots at Seahawks). |
| ESPN summary `…/nfl/summary?event={id}` | `scoringPlays[]` (type, text, clock, scores, team), `drives`, `boxscore.players[team].statistics[group].athletes[]` with ESPN athlete ids, `leaders`, `injuries`, `winprobability` | seconds | ~450 KB per game. This is the per-player live stat line without play-by-play parsing. |
| ESPN plays `sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{id}/competitions/{id}/plays?limit=400` | every play: `text`, `type`, `scoringPlay`, `clock`, `period`, `homeScore`/`awayScore`, `wallclock`, `modified`, `teamParticipants` | seconds | ~750 KB per game; only needed if we want non-scoring plays (P3). |
| ESPN fantasy league `…/leagues/{id}?view=mMatchupScore&view=mBoxscore&scoringPeriodId=N` | this league's live fantasy points per player and matchup | seconds | already what the 4-hourly sync pulls; the clock pulls it every 5 min during games, with the league's cookies for private leagues. |
| ESPN fantasy players `…/players?view=kona_player_info` | `injuryStatus` for every player in one call | minutes | already in `playerSync.ts`; Sunday 11:00–13:00 ET inactives sweep every 15 min. |
| Sleeper `api.sleeper.app/v1/players/nfl` | injury status/body part/notes, practice, depth chart | 4 h (ours) | docs: "intended only to be used once per day at most". Not a live source. |
| Sleeper `api.sleeper.app/stats/nfl/{season}/{week}?season_type=regular&position[]=QB` (undocumented) | per-player weekly stat rows with `last_modified` and the embedded player injury fields | live during games | 93 QB rows for 2025 wk 1; useful cross-check for `big_line`, not primary. `…/v1/stats/nfl/regular/{season}/{week}` returns the same as a 2,312-player map (~570 KB). |
| nflverse injuries / FFC ADP | practice reports, ADP for `bust_watch` | daily | already synced. |

### 12.2 Paid, true push (the "make it real time" option)

**BALLDONTLIE webhooks** — HTTP POST to our endpoint, HMAC-SHA256 signed
(`X-BDL-Webhook-Signature`), 30 s delivery timeout, 5 retries, 30-day logs. NFL events:
`nfl.game.started`, `nfl.game.ended`, `nfl.game.period_ended`, `nfl.game.overtime`,
`nfl.player.touchdown`, `nfl.player.passing_touchdown`, `nfl.player.field_goal_made`,
`nfl.player.interception`, `nfl.player.fumble_recovery`, `nfl.player.sack`, `nfl.team.scored`,
`nfl.injury.created`, `nfl.injury.updated`, `nfl.injury.cleared`. **NFL webhooks require the
ALL-ACCESS tier at $299.99/month** (10 endpoints, 500,000 deliveries/month); the free tier's webhooks
are NBA game start/end only. Their docs state events "may be delayed up to 1 minute from real time".
The REST side is per sport: Free (teams/players/games, 5 req/min), ALL-STAR $9.99/mo (adds injuries,
stats, standings, 60 req/min), GOAT $39.99/mo (adds play-by-play, advanced stats, fantasy, odds,
600 req/min). 48-hour GOAT trial. Commercial-use terms not stated on the pricing pages.

**Sportradar NFL push feeds** — long-lived HTTP streaming (chunked), heartbeat every 5 s; streams:
Push Events (play-by-play), Push Statistics, Push Pulse (on-field activity), Push Draft Picks,
Push Draft Trades. Official NFL data. "Realtime" plan only, sales contact, no public price; third-party
estimates put it at $500–1,000+/month.

**SportsDataIO** — real-time NFL coverage, editorial wire, player news and notes, in-play odds; sales
pricing (third-party estimates $99–149/month for the developer "lab", $500–1,000+ enterprise);
free trial with scrambled data.

### 12.3 Paid, polled, cheaper

| Vendor | Price | Relevant to the Wire |
|---|---|---|
| Tank01 (RapidAPI) | Free 1,000 req/mo; Pro $10/mo (1,000/day); Ultra $25/mo (15,000/day); Mega $100/mo (500,000/day) | live box scores "as they happen", injuries with roster updates, player and fantasy news "multiple times an hour", play-by-play in beta, fantasy points with custom scoring |
| API-Sports American Football | Free 100/day; Pro $19, Ultra $29, Mega $39 per month; no overages | live scores, injuries; no news text |
| MySportsFeeds | personal from $5/mo; commercial NFL from $39/mo (CORE, non-live); near-realtime priced on request | play-by-play, boxscores, lineups, injuries; XML/JSON/CSV |
| Goalserve | NFL/NCAA live $300/mo ($1,200/yr) | live scores, boxscores, player stats, injuries, "within seconds"; may not redistribute raw feeds |
| FantasyPros API | free prototyping key; $8.99/mo personal (non-commercial); commercial license priced on request | consensus rankings, projections, news, injuries |
| Fantasy Nerds | $199.95/yr NFL | news + injuries (docs blocked our fetch; unverified) |
| RotoWire | syndication partnership, sales | the injury text ESPN/Yahoo/DraftKings license; the best narrative source if we ever pay for one |

### 12.4 Recommendation

1. **P1 and P2 on ESPN polling.** It is free, it carries the narrative text (timetables come from
   ESPN's notes), and at a 60-second game tick its latency matches what the $300/month webhook
   vendor promises. The engineering cost of a push endpoint is small; the recurring cost is not.
2. **Build the source adapter boundary now** (`wireSources.ts` emits normalized events; detectors
   never see vendor shapes) so a push source is a new file plus `convex/http.ts`.
3. **Owner call (2026-09-05): defer any paid feed until the product makes money.** Then revisit
   BALLDONTLIE ALL-ACCESS when: (a) ESPN's unofficial endpoints break twice in a season,
   or (b) paying leagues × pass price make $300/month a rounding error (about 30 passes/season) and
   we want the reliability story. It gives injuries and scoring plays as events; it does not give the
   injury note text, so ESPN news/injuries polling stays for timetables either way.
4. **Sportradar only if** the product ever needs to say "official NFL data".

### 12.5 Failure plan for unofficial endpoints

Every source has its own `wireSourceState` health row and a stale threshold in `feedFreshness`. A
source failing 3 polls in a row: the digest says so, the clock backs off to 5 min for that source, and
the Wire keeps running on the others (the scoreboard alone still yields starts, finals and scores).
A shape change is a parse error, not a bad post: parsers are strict and a failed parse emits nothing.

---

## 13. Phasing

**P1 — the wire, polled (no new external accounts). BUILT 2026-09-05; pushed to the dev deployment only. Two rules learned on the first dev poll and now in code: a cold start seeds the injuries cursor and posts nothing, and an entry whose ESPN `date` is older than 48 h is never ingested; per-player lookups use `wireEvents.by_player_detected` (a `primaryEspnId` copy of the first card player) instead of window scans.** Tables; ESPN injuries + news pollers at 5 min
in season; detectors for §5.1 rows 1–5 and §5.2 routine kinds that hang off existing syncs; tier-1
take generation with batching and card fallback; tier-2 overlay; tier-3 stock lines for all six
writers; `/wire` page, homepage panel, ticker items, nav; pass gating; rate limits; digest line;
dev tool; eval script; tests. Acceptance: a synthetic Burrow OUT event on dev produces a global Dex
post within one batch window and the correct owner/opponent/free-agent overlays in a real league,
with $0 per-league model spend in `generationStats`.

**P2 — live.** Game clock; scoreboard/summary/fantasy live pulls; `game_started`, `scoring_play`,
`big_line`, `bust_watch`, `matchup_live`, `monday_needs`, `week_final` on the day; lineup-lock
warnings; `wire_alert` notifications and the Sunday digest email. Acceptance: on an NFL Sunday the
dev league's wire shows finals within two minutes of ESPN and no duplicate posts across a full day.

**P3 — social.** Reactions → relationships (one third of the article delta); Sam's sideline DM after a
high-interest owner overlay, answer quoted as a post; one writer-to-writer thread per league per week;
dashboard cross-league wire; polls ("Who wins Monday night?"); optional paid push adapter.

## 14. Ownership (no agent may run git stash / checkout / reset / commit)

- **W-A (Convex)**: `convex/schema.ts` additions, `convex/wire*.ts`, `convex/lib/wireTimetable.ts`
  (pure), hooks in `espnSync.ts` / `tradesSync.ts` / `aiContent.ts` / `claims.ts` / `relationships.ts`,
  `crons.ts`, `deskMetrics.ts` digest line, `devTools.ts`, `feedFreshness.ts`, convex-test suites.
- **W-B (prompt layer)**: `src/lib/ai/wire/*`, stock lines for six writers (reviewed against
  `ffsn-ai-personas.md` and the LANGUAGE trait), `scripts/eval-wire.ts`, fixtures, unit tests.
- **W-C (UI)**: `src/app/leagues/[id]/wire/`, `src/components/wire/*` (post, overlay block, reaction
  row, empty states), homepage panel, `useLeagueTicker` items, nav, settings toggle, notification item
  type, email digest template. Broadcast kit only; no new primitives.
- Every push gated on a green `npm run typecheck` (count `error TS`, exit non-zero) and `npm test`.

## 15. Open questions for the owner

Resolved 2026-09-05 (now §1): name The Wire; free leagues see the global wire as the upsell; clean at
the global tier; no paid feed until the product makes money; notifications `my_roster` in-app with
an opt-in email digest.

Still open:

1. Should the Wire's per-league trade take replace the 30-minute-later trade_analysis article's
   "breaking" role, or run alongside it (default: alongside; the article is the analysis)?

---

## 16. Follow-ups the Wire makes possible (owner asks)

1. **In-game injuries are not lineup mistakes (owner, 2026-09-05).** A player hurt during the game
   scores like a bad start in the box score, so a recap working from points-per-slot can invent a
   lineup blunder, and Sam's comment request can ask "why did you start him", a question no reporter
   would ask. Rule: never call starting a player who got hurt mismanagement; ask how the manager
   will replace the production (waiver target, bench cover). Build: an explicit per-player
   `leftGameInjured { status, observedAt }` fact in `LeagueDataContext` / the FACTS block, sourced
   from `wireEvents` (`injury_status` with `observedAt` inside the game window) and ESPN's boxscore
   injury notes; a HOUSE STYLE line ("an in-game injury is never the manager's decision"); the
   interviewee question picker (`convex/lib/interviewees.ts`, `teamClaims.questionTopicFor`)
   switches such a slot to a replacement question; a verifier check that no roast or "left points on
   the bench" claim targets a slot whose player left injured. Applies to weekly_recap, bank_statement,
   waiver_wire_report, power_rankings and every interview.

## Appendix A — sources consulted (2026-09-05)

- ESPN endpoint shapes: live probes recorded above; community docs
  https://github.com/pseudo-r/Public-ESPN-API and https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c
- Sleeper API docs (players "once per day", trending): https://docs.sleeper.com/
- BALLDONTLIE pricing and NFL docs: https://www.balldontlie.io/ , https://nfl.balldontlie.io ;
  webhooks: https://www.balldontlie.io/webhooks/ and
  https://www.balldontlie.io/blog/webhooks-real-time-sports-notifications/
- Sportradar NFL push feeds: https://developer.sportradar.com/football/docs/nfl-ig-push
- SportsDataIO NFL: https://sportsdata.io/nfl-api
- Tank01 NFL (RapidAPI): https://rapidapi.com/tank01/api/tank01-nfl-live-in-game-real-time-statistics-nfl , https://www.tank01.com/
- MySportsFeeds pricing: https://www.mysportsfeeds.com/feed-pricing/
- Goalserve NFL pricing: https://www.goalserve.com/en/sport-data-feeds/NFL-api/prices
- API-Sports / API-American-Football: https://api-sports.io/
- FantasyPros API: https://www.fantasypros.com/api-data/
- Fantasy Nerds pricing: https://api.fantasynerds.com/getting-started/pricing
- Vendor comparison (third-party estimates for Sportradar/SportsDataIO): https://highlightly.net/blogs/best-nfl-apis-in-2026
