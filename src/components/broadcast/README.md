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
- Components that need `usePathname` or theme state (`AppHeader`, `ThemeToggle`) are Client Components.
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

## Sports/data

### `ScoreBug`
The matchup graphic: an optional strip (left text + right text/tone), then two team rows with a 6px
winner/loser color bar. `mode="final"` shows scores in ink/muted with a red caret (◀) next to the winner;
`mode="projected"` shows scores in lighter signal blue with no winner marker.

Props: `home: ScoreBugTeam`, `away: ScoreBugTeam`, `mode?: "final" | "projected"` (default `"final"`),
`strip?: ReactNode`, `stripRight?: ReactNode`, `stripRightTone?: "default" | "highlight" | "muted"`
(default `"default"`; `"highlight"` = red text, e.g. "Game of the week"), `href?: string` (wraps in a
`Link`), `className?`.

`ScoreBugTeam`: `{ name: ReactNode; sub?: ReactNode; score?: ReactNode; winner?: boolean }`.

```tsx
<ScoreBug
  mode="final"
  strip="Week 3 · Final"
  stripRight="Game of the week"
  stripRightTone="highlight"
  home={{ name: "Lamar's Army", sub: "Priya Natarajan · 2-1", score: "124.6", winner: true }}
  away={{ name: "Waddle It Be", sub: "Chris Baptiste · 1-2", score: "122.9" }}
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

### `TeamTile`
Square team monogram tile with the diagonal-split background, or a team logo image (`object-cover`) when
`src` is given.

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
illustration), a name plate + red role strip, an italic tagline, and a "Writes" beat line.

Props: `persona: string` (display name — also used to match the `PersonaAvatar` illustration), `index:
number | string` (`1` renders as `"01"`), `tagline: string`, `beat: string[]` (joined with " · "), `role:
string`, `className?`.

```tsx
<WriterPlate
  persona="Mel Diaper"
  index={1}
  role="The Draft Disaster"
  tagline="I'm never wrong, you're just not listening!"
  beat={["Mock drafts", "Draft grades", "Power rankings"]}
/>
```

### `PersonaAvatar`
The five drawn on-air-talent silhouettes — Mel (headset), Stan (glasses + bar chart), Vinny (fedora), Chad
(spiked hair + shades), Rick ("87" cap + two cans) — matched loosely (case-insensitive substring) against
`persona`, with an initials-plate fallback for any other writer (e.g. `mike-harrison`). Fills read from
`--bc-*` tokens so they invert correctly in light mode.

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
