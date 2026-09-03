# Broadcast component kit

Shared, theme-aware components for the "Broadcast" redesign (primetime sports-network studio look).
Dark is the house look; light is a fully-supported daylight counterpart. Every component here is built
on the `--bc-*` tokens in `src/app/globals.css` and reuses `@/components/ui/*` primitives (Button, Badge,
Sheet, Table, Tabs, …) — never fork those, extend them with `className`.

Import from the barrel:

```tsx
import { TopBar, Panel, ScoreBug, WriterPlate } from "@/components/broadcast";
```

General rules for consumers:

- No `rounded-*` anywhere (radius is 0 by design). If you need a circular/pill shape for some reason, that's
  a deliberate exception you're introducing, not something this kit provides.
- Numeric `size`/pixel props (e.g. `TeamTile`'s `size`, `PersonaAvatar`'s `size`) are applied via inline
  `style`, not Tailwind arbitrary-value classes — Tailwind can't statically see a runtime-computed
  `w-[${n}px]` string, so don't try to override those dimensions with a `w-*`/`h-*` className.
- Components that need `usePathname`, theme state (`AppHeader`, `ThemeToggle`), or local UI state
  (`TeamTile`, to fall back to initials when a logo image fails to load) are Client Components.
  Everything else has no hooks and is server-render-safe, including when composed with Clerk's
  `SignedIn`/`SignedOut`/`UserButton` (those are Client Components internally; rendering them from a
  Server Component is fine, that's normal RSC composition).

---

## Shell

### `BrandLogo`
The `/FFSN.png` wordmark at a fixed height (`sm` 32 / `md` 44 / `lg` 58px), width auto. Links to `/` by default.

Props: `size?: "sm" | "md" | "lg"` (default `"md"`), `href?: string | null` (default `"/"`, pass `null` for a non-link mark), `className?`.

```tsx
<BrandLogo size="lg" />
```

### `ThemeToggle`
44px Sun/Moon icon button wired to the app ThemeProvider (`@/components/theme-provider`). Renders a disabled neutral placeholder until mounted
(hydration-safe — the app's `ThemeProvider` has `enableSystem={false}`, so `theme` is always `"dark"` or `"light"`).

Props: `className?`.

```tsx
<ThemeToggle />
```

### `TopBar`
The 76px header bar. Left = logo + 1px divider + title/subtitle block. Center = optional nav (desktop-only,
`bc-navlink` style, 44px tall, active items get a 3px red bottom border) that collapses into a Sheet with a
hamburger on mobile. Right = a free `children` slot.

Props: `title?: ReactNode`, `subtitle?: ReactNode`, `logoHref?: string | null` (default `"/"`),
`logoSize?: "sm" | "md" | "lg"` (default `"lg"`), `nav?: TopBarNavItem[]`, `children?: ReactNode`,
`mobileNavLabel?: string` (Sheet header text when `title` isn't a plain string), `className?`.

`TopBarNavItem`: `{ label: string; href: string; active?: boolean }`.

```tsx
<TopBar title="The Sunday Scaries" subtitle="10 teams · PPR · ESPN">
  <ThemeToggle />
</TopBar>
```

Note: plain string `title`/`subtitle` get sensible default styling; pass a pre-styled node (own
classNames) if you need something else — it isn't forced to truncate, so wrap it in your own
`truncate` span if you need strict single-line ellipsis.

### `SiteHeader`
Marketing composition of `TopBar`: Features / Writers / Pricing anchor nav, and
`SignedOut` → "Sign in" (outline) + "Get started" (glow) / `SignedIn` → "Dashboard" (outline) + `UserButton`,
plus `ThemeToggle`. No "beta" language anywhere by design.

Props: `nav?: TopBarNavItem[]` (defaults to Features/Writers/Pricing anchors), `className?`.

```tsx
<SiteHeader />
```

### `AppHeader` (Client Component)
The league shell header: row 1 = `TopBar` with the league name (links to `homeHref`) + meta line, plus
notifications/theme/user-menu and a mobile hamburger+Sheet for the nav; row 2 = 48px primary nav with
active-path detection via `usePathname` (hidden on mobile, its items live in the row-1 Sheet instead) and a
right-side `context` slot; row 3 = optional `Ticker`.

Props: `leagueName: string`, `leagueMeta?: ReactNode`, `homeHref: string`, `nav: AppHeaderNavItem[]`,
`context?: ReactNode` (e.g. week chips, desktop-only), `ticker?: TickerItem[]`, `tickerLabel?: string`,
`notifications?: ReactNode` (pass the existing `NotificationDropdown`), `className?`.

`AppHeaderNavItem`: `{ label: string; href: string; exact?: boolean }` (`exact` requires an exact pathname
match instead of the default `startsWith` prefix match).

```tsx
<AppHeader
  leagueName={league.name}
  leagueMeta={`${league.teamCount} teams · ${league.scoring} · ESPN`}
  homeHref={`/leagues/${league._id}`}
  nav={[
    { label: "Home", href: `/leagues/${league._id}`, exact: true },
    { label: "Scores", href: `/leagues/${league._id}/scores` },
    { label: "Standings", href: `/leagues/${league._id}/standings` },
  ]}
  notifications={<NotificationDropdown leagueId={league._id} />}
  ticker={tickerItems}
/>
```

### `DashboardHeader`
`TopBar` preconfigured with title "Your leagues" / subtitle "Fantasy Football Sports Network", a
"New league" action (default button ≥sm, icon-only <sm), `ThemeToggle` and `UserButton`.

Props: `newLeagueHref?: string` (default `"/setup"`), `className?`.

```tsx
<DashboardHeader />
```

### `Ticker`

The 36px scrolling feed strip. Client component: it measures one item sequence and the visible
strip, repeats the sequence enough times to always cover the strip, and sets `--bc-ticker-shift`
(one sequence width) and `--bc-ticker-duration` (width / `speed`) so the loop is seamless and the
speed is constant no matter how many items there are. Hover pauses; reduced motion makes it static.

Props: `items: TickerItem[]` (`{ k, v, n? }` = muted key, value, signal-blue stat), `label?`
(red plate, default "League feed"), `speed?` (px/s, default 90), `className?`.

League pages get their items from `useLeagueTicker` (`src/components/league/useLeagueTicker.ts`),
which follows the league phase: draft order before the draft, this week's matchups plus last
week's finals in season, the week's finals between weeks, and the final standings (champion first)
once the season is decided.

```tsx
<Ticker label="Week 4 · Upcoming" items={[{ k: "Matchup", v: "Bijan Mustard vs Kittle Me This", n: "proj 128.4–121.7" }]} />
```

### `SiteFooter`
Logo + network label + a link row (Dashboard · Features · Pricing · Terms · Privacy · Contact) + "© {year} FFSN".

Props: `links?: SiteFooterLink[]` (override the default 6), `className?`.

```tsx
<SiteFooter />
```

---

## Layout & sectioning

### `Panel`
The base cut-corner surface (`bg-bc-panel border border-bc-hairline`) every card/section sits on.

Props: `cut?: "tr" | "bl" | "none"` (default `"tr"`), `padding?: "none" | "sm" | "md" | "lg"` (default
`"none"`), `lifted?: boolean` (use `bg-bc-panel-2`), `scan?: boolean` (scanline texture), plus all native
`div` attributes.

```tsx
<Panel padding="md" scan>
  ...
</Panel>
```

### `SectionHeader`
A `bc-h-title` (red bar + condensed title) with an optional kicker line above it and a right-side actions
slot, on a 2px hairline.

Props: `title: ReactNode`, `kicker?: ReactNode`, `actions?: ReactNode`, `size?: "default" | "sm"` (`"sm"`
matches the 22px h-title used in sidebar cards), `className?`.

```tsx
<SectionHeader title="Scoreboard" actions={<span className="bc-label text-bc-text-3">The Sunday Scaries · 2026</span>} />
```

### `SegmentSlate`
The "SEG 01" red plate + muted label pair used above marketing section headings.

Props: `code: string` (e.g. `"Seg 01"`), `label: string` (e.g. `"On-air talent"`), `className?`.

```tsx
<SegmentSlate code="Seg 01" label="On-air talent" />
```

### `PageHeader`
Sub-page header: kicker label, a big responsive `bc-display` title (40px → 64px), optional description,
actions slot.

Props: `kicker?: ReactNode`, `title: ReactNode`, `description?: ReactNode`, `actions?: ReactNode`, `className?`.

```tsx
<PageHeader kicker="Weekly recap" title="Week 3 Recap" description="..." actions={<Button>Share</Button>} />
```

### `Chip`
Thin wrapper over `Badge` that adds an optional pulsing dot (`bg-current`, so it follows the badge's own
text color) — use for "On air" / "On deck" / "New" one-liners.

Props: same as `Badge` (`variant`, etc.) plus `live?: boolean`.

```tsx
<Chip variant="signal" live>On deck</Chip>
```

---

## Roster

### `personaRoster` (not a component)
Display data derived from `src/lib/ai/persona-prompts.ts`, so no screen re-states a writer's name, role
or beat. Everything here is a plain value or function — import it from the barrel like any component.

- `writerRoster: RosterWriter[]` — the selectable writers in spec §3 order, each
  `{ slug, name, role, tagline, beat, isInterviewer }`. Retired personas are excluded, so a picker built
  from this can never offer one.
- `personasForContentType(type)` — the writers for a content type, default first.
- `defaultPersonaFor(type)` — that type's default writer slug.
- `isSelectableContentType(type)` / `UNAVAILABLE_CONTENT_TYPES` — whether a content type has a template
  behind it, derived from `contentTemplates` at runtime (spec §8.5), so a type becomes selectable
  everywhere the moment its template ships and is dropped everywhere if one is removed. Filter every
  picker through this — `ContentGenerator` builds its whole rundown this way, taking each entry's label
  from `contentTypeLabel` and its credit cost from the template itself.
- `contentTypeLabel(type)` / `CONTENT_TYPE_LABELS` — display names for every type, including the renamed
  segments ("The Asking Price", "The Case For").
- `personaName(slug)` / `personaRole(slug)` — byline text for any slug, retired writers included. Use
  these instead of de-slugging a persona string.

```tsx
import { writerRoster, defaultPersonaFor, personaName } from "@/components/broadcast";
```

---

## Sports/data

### `ScoreBug`
The matchup graphic: an optional strip (left text + right text/tone), then two team rows with a 6px
winner/loser color bar. `mode="final"` shows scores in ink/muted with a red caret (◀) next to the winner;
`mode="projected"` shows scores in lighter signal blue with no winner marker.

Props: `home: ScoreBugTeam`, `away: ScoreBugTeam`, `mode?: "final" | "projected" | "live"` (`"live"`: full-weight ink scores, no winner marker or loser dimming) (default `"final"`),
`strip?: ReactNode`, `stripRight?: ReactNode`, `stripRightTone?: "default" | "highlight" | "muted"`
(default `"default"`; `"highlight"` = red text, e.g. "Game of the week"), `href?: string` (wraps in a
`Link`), `className?`.

`ScoreBugTeam`: `{ name: ReactNode; sub?: ReactNode; score?: ReactNode; winner?: boolean; leading?: ReactNode }`.
`leading` renders between the color bar and the name column — e.g. a `TeamTile` — and only changes the
row grid when given, so a bug with no `leading` on any team stays pixel-identical to before. The name
column is always `min-w-0` + `truncate`, so long team names never overflow. In `mode="projected"` each
score is preceded by a small "Proj" label so a projection can never be mistaken for a real score.

```tsx
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
    leading: <TeamTile initials="LA" src={homeTeam.logo} size={32} />,
  }}
  away={{
    name: "Waddle It Be",
    sub: "Chris Baptiste · 1-2",
    score: "122.9",
    leading: <TeamTile initials="WI" src={awayTeam.logo} size={32} />,
  }}
  href="/leagues/123/scores/week-3"
/>
```

### `RankPlate`
The 32px square rank tile used in standings and trending lists.

Props: `rank: ReactNode`, `tone?: "default" | "first" | "outline"` (`"first"` = solid red, e.g. rank #1;
`"outline"` = red border, e.g. the viewer's own row), `className?`, plus native `span` attributes.

```tsx
<RankPlate rank={1} tone="first" />
```

### `TeamTile` (Client Component)
Square team monogram tile with the diagonal-split background, or a team logo image (`object-cover`) when
`src` is given. If the image fails to load (`onError`, e.g. a hot-link-blocked ESPN logo URL), it falls
back to the initials tile — this needs local state, so it's a Client Component (see the hooks note above).

Props: `initials: string`, `src?: string`, `alt?: string`, `size?: number` (px, default 36),
`tone?: "default" | "accent"` (`"accent"` = solid red, e.g. the viewer's own team), `className?`.

```tsx
<TeamTile initials="KM" size={64} tone="accent" />
<TeamTile initials="BM" src={team.logoUrl} alt="Bijan Mustard" size={36} />
```

### `WinLossPip`
22px W/L square: red fill + white text for a win, filled `border-strong` + muted text for a loss.

Props: `result: "W" | "L"`, `className?`.

```tsx
<WinLossPip result="W" />
```

### `StatBlock`
A muted condensed key over a large `bc-num` value.

Props: `label: ReactNode`, `value: ReactNode`, `align?: "left" | "center" | "right"` (default `"left"`),
`size?: "default" | "lg"` (default `"default"`; `"lg"` is 36–40px), `className?`.

```tsx
<StatBlock label="Points for" value="389.4" />
```

Note: `StandingsRow` was intentionally not built — style standings tables directly with
`@/components/ui/table`, tokens, and the primitives above (`RankPlate`, `TeamTile`, `WinLossPip`).

---

## Editorial

### `LowerThird`
The broadcast byline: an 8px red bar + an off-white plate (avatar slot + name + role), then a 30px red
strip with a tag and optional note. `compact` collapses it to a single row (40px avatar / 18px name, no
strip) for use in lists.

Props: `name: ReactNode`, `role?: ReactNode`, `avatar?: ReactNode` (56px slot, 40px in `compact`),
`tag?: ReactNode`, `note?: ReactNode`, `compact?: boolean`, `className?`.

```tsx
<LowerThird
  name={`Rick "Two Beers" O'Sullivan`}
  role="The Drunk Uncle · FFSN Senior Recap Correspondent"
  avatar={<PersonaAvatar persona="Rick" size={56} variant="bust" />}
  tag="Weekly recap"
  note={`"Never text gg. That's rule one."`}
/>
```

### `WriterPlate`
The talent-lineup card: a 300px portrait (scanline texture + faint index number + `PersonaAvatar`
illustration), a name plate + red role strip, an italic tagline, a "Writes" beat line and an optional
footnote under it.

Props: `persona: string` (display name — also used to match the `PersonaAvatar` illustration), `index:
number | string` (`1` renders as `"01"`), `tagline: string`, `beat: string[]` (joined with " · "), `role:
string`, `footnote?: ReactNode` (small red line under the beat, e.g. "Feuding with 2 managers"),
`className?`.

Don't hand-write a lineup: `WriterLineup` (`src/components/WriterLineup.tsx`) renders one plate per
writer from the roster, in spec order, with the league's feud/favorite counts as the footnote.

```tsx
<WriterPlate
  persona="Mel Diaper"
  index={1}
  role="The Draft Disaster"
  tagline="I had him three rounds later and I have the receipts."
  beat={["Mock draft", "Draft rankings & grades"]}
  footnote="Feuding with 2 managers"
/>
```

### `PersonaAvatar`
The drawn on-air-talent silhouettes, matched by slug **or** display name (case-insensitive) against
`persona`, with an initials-plate fallback for any other byline (e.g. `mike-harrison`). Fills read from
`--bc-*` tokens so they invert correctly in light mode.

On air: Curtis Vaughn (earpiece coil + flagged hand mic), Sam Ortega (stick mic + credential lanyard),
Nina Sharpe (glasses + stylus over a three-bar chart), Dex Alvarez (phone at the ear), Mel Diaper
(headset + boom mic), Walt Brennan (glasses pushed up + folded newspaper). Retired but still drawn so
archived bylines keep their portrait: Stan (glasses + bar chart), Vinny (fedora), Chad (spiked hair +
shades), Rick ("87" cap + two cans).

Adding a writer: reuse the shared `Bust()` (shoulders / neck / head) and the `STRONG` / `INK` / `RED` /
`SIGNAL` / `TEXT_2` token fills, keep the identifying prop inside the `bust` crop (`viewBox "20 30 216
216"`, so roughly x 20–236 / y 30–246), and register the pattern ahead of the retired entries.

Props: `persona: string`, `size?: number` (px; **only** applies to `variant="bust"` — `"portrait"` fills its
container via `preserveAspectRatio="xMidYMid slice"`, so give the parent explicit dimensions instead),
`variant?: "portrait" | "bust"` (default `"bust"`; `bust` is a tight square headshot crop for bylines),
`className?`.

```tsx
<PersonaAvatar persona="Stan Deviation" size={40} />
<div className="h-[300px]">
  <PersonaAvatar persona="Chad Thunderhype" variant="portrait" />
</div>
```

### `PullQuote`
A sideline quote as it appears under an article: the verbatim line against a red rule, a `LowerThird`
naming the manager and their team, and the writer's in-voice reply (`quotes[].writerResponse`) beneath it
in the writer's own byline. Used by the "From the sideline" block on the article page.

Props: `quote: string` (without quotation marks — the component adds them), `speaker: string`, `team?:
string`, `week?: number` (red strip reads "Told FFSN Sideline · Week 7"), `writerResponse?: string`,
`writerPersona?: string` (writer slug for the reply byline), `className?`.

Also placed *inside* an article body: `MarkdownPreview` renders every `:::quote{id=…}` directive line as
one of these, resolved against the article's `quotes[]` (spec §8.3), and the page's "From the sideline"
block then carries only the quotes that weren't placed inline (`placedQuoteIds(content)` says which).
That's why its blockquote carries `!` utilities — it has to outrank the `.bc-prose blockquote` rule it
renders inside.

```tsx
<PullQuote
  quote="I'd do it again."
  speaker="Priya Natarajan"
  team="Lamar's Army"
  week={7}
  writerResponse="She would. That's the problem."
  writerPersona="mel-diaper"
/>
```

### `RelationshipMeter`
The five-stop relationship meter (Feud · Cold · Neutral · Warm · Favorite) from spec §6.5: the writer's
`PersonaAvatar` bust and name plate, a tier chip and the signed score, a marker at the score, and the most
recent evidence lines with their deltas ("Wk 7 · 'nineteen picks of air' −6"). Presentational — feed it
rows straight from `relationships.getMyRelationships` / `getTeamRelationships`.

Props: `persona: string` (slug — name and role resolve from the roster), `score: number` (−100…100),
`tier: RelationshipTier`, `events?: RelationshipMeterEvent[]` (`{ delta, evidence, week?, type? }`,
newest first), `maxEvents?: number` (default 3; `0` hides the list), `name?: string`, `className?`.

Also exported: `relationshipTierLabel(tier)` and `formatDelta(n)` (`-6` → `"−6"`).

The two mounted views live outside the kit because they query Convex:
`MyDeskRelationships` (`src/components/MyDeskRelationships.tsx`, league homepage sidebar, the signed-in
manager, most extreme writer first) and `TeamRelationships` (`src/components/TeamRelationships.tsx`, the
"The desk" tab on the teams page, any team).

```tsx
<RelationshipMeter persona="mel-diaper" score={-38} tier="cold" events={writer.recentEvents} />
```

### `DeskReview`
The verifier findings panel above the edit-before-publish editor (spec §4.5): blocks and strips first with
a red rule, warnings muted, each with its sentence, plus a "Not in the data this week" list of the FACTS
paths the writer asked for and didn't have. Renders `null` when the draft came back clean.

Props: `flags?: ReviewFlag[]` (`aiContent.reviewFlags` — `{ kind, detail, section?, severity }`),
`factsMissing?: string[]` (`aiContent.factsMissing`), `className?`.

```tsx
<DeskReview flags={article.reviewFlags} factsMissing={article.factsMissing} />
```

### `QuoteApprovalCard`
One quote awaiting the manager's sign-off (spec §8.1), as it appears under Sam's "here's what we'll quote
you saying" message: the line itself, then Looks good / Edit / Take it back while it's pending, a status
chip once it isn't ("Approved" / "Edited" / "Taken back"), and the manager's original line underneath an
edited one. Edit swaps the quote for a textarea — Esc cancels, ⌘/Ctrl+Enter saves. `locked` makes the card
read-only for a story that has already gone to print. Renders an `<li>`, so give it a `<ul>` parent.

Props: `quote: QuoteReviewEntry` (`{ original, text, status }`), `index: number`, `total?: number`,
`locked?: boolean`, `busy?: boolean`, `onApprove?`, `onEdit?: (text: string) => void`, `onWithdraw?`,
`className?`.

Presentational, like the rest of the kit. The mounted view is `QuoteApproval`
(`src/components/QuoteApproval.tsx`), which owns the `commentConversations.getQuoteReview` query and the
`reviewQuote` mutation and is dropped under the `quote_approval` message by both interview surfaces
(`CommentConversation` and the comment-request page). The other Convex-backed view from this phase lives
outside the kit for the same reason: `WaitingOnComment` / `LeagueWaitingOnComment`
(`src/components/WaitingOnComment.tsx`) — the requester's board ("3 of 6 responded", a countdown and
"Go to print now") and its league-homepage wrapper. Two more app-level pieces sit next to them:
`PrintDeadlineField` (`src/components/PrintDeadlineField.tsx`, the "We go to print at" presets that
replaced the datetime picker) and `useNow` (`src/components/useNow.ts`), the ticking clock those two use
so a countdown moves and a card locks itself at the deadline instead of reading `Date.now()` in render.

```tsx
<ul>
  <QuoteApprovalCard quote={quote} index={0} total={3} onApprove={approve} onEdit={edit} onWithdraw={pull} />
</ul>
```

### `BannerPlaceholder`
The drawn yard-line / studio football illustration used wherever an article or featured story has no
banner image. Fills its container (give the parent explicit height) and fades into the container's
background at the bottom. Theme-aware via CSS variable `fill`/`stroke` values.

Props: `text?: string` (big outlined background text, e.g. `"WK 3"` or `"3-0"`), `gradientId?: string`
(only needed if several placeholders render on the same page at once — disambiguates the internal SVG
gradient ids), `className?`.

```tsx
<div className="h-[420px]">
  <BannerPlaceholder text="WK 3" />
</div>
```

### `EmptyState`
Icon slot + condensed title + description + optional action, inside a `Panel`.

Props: `icon?: ReactNode`, `title: ReactNode`, `description?: ReactNode`, `action?: ReactNode`, `className?`.

```tsx
<EmptyState
  icon={<Inbox className="size-6" strokeWidth={1.8} />}
  title="No stories yet"
  description="Generate your first AI story for this league."
  action={<Button>Generate a story</Button>}
/>
```

### `LoadingScreen` / `Spinner`
`LoadingScreen` is a full-height centered "Loading…" state with a single pulsing red dot and a `bc-label`
message. `Spinner` is a small inline indicator — three staggered pulsing squares, deliberately not a
rounded ring (the system has no border radius).

Props (`LoadingScreen`): `message?: string` (default `"Loading"`), `className?`.
Props (`Spinner`): `size?: number` (px, default 16), `className?`.

```tsx
<LoadingScreen message="Loading your league" />
<Button disabled><Spinner size={14} className="mr-2" />Saving</Button>
```
