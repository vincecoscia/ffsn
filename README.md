# FFSN — Fantasy Football Sports Network

AI-powered fantasy football content for your league. FFSN syncs a league from
ESPN Fantasy, then uses Claude (Opus 5, falling back to Sonnet 5) and OpenAI
to generate weekly recaps, previews, trade analysis, power rankings, and
other articles written in the voice of your league. Auth is handled by
Clerk, payments and credit purchases by Stripe, and the backend is Convex
(real-time database, functions, and scheduling) behind a Next.js 15 (App
Router) frontend.

## Stack

- **Frontend**: Next.js 16 (App Router), TypeScript (strict), Tailwind CSS,
  shadcn/ui
- **Backend**: Convex — queries/mutations/actions, scheduled functions, and
  the generated `convex/_generated` API/types (checked into the repo)
- **Auth**: Clerk
- **Payments**: Stripe (checkout sessions + webhooks, with idempotent
  webhook and credit-ledger handling)
- **AI**: Anthropic (Claude) for articles and comment conversations, OpenAI
  for banner images

## Getting started

Install dependencies, then run the Next.js dev server and the Convex dev
process side by side (two terminals):

```bash
npm install

# Terminal 1 — Convex backend (schema push, function sync, log tailing)
npx convex dev

# Terminal 2 — Next.js frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

Copy `.env.local.example` to `.env.local` and fill in the values (Convex
deployment URL, Clerk keys, Anthropic/OpenAI keys, Stripe keys, SendGrid
keys, and the site URL). `npx convex dev` will populate `CONVEX_DEPLOYMENT`
and `NEXT_PUBLIC_CONVEX_URL` on first run if they're left blank.

```bash
cp .env.local.example .env.local
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm start` | Run a production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Run the test suite in watch mode |

## Testing

Tests live under `tests/` and run with [Vitest](https://vitest.dev) against
the `edge-runtime` environment (matching Convex's isolate runtime). Convex
functions are exercised with
[`convex-test`](https://docs.convex.dev/functions/testing), a mock backend
that runs the real functions in `convex/` against an in-memory database —
no `npx convex dev` deployment required. See `vitest.config.ts` and
`tests/setup.ts`.

```bash
npm test
```

## Deployment

Production runs on Vercel. Vercel's build step runs Convex's deploy command
so the Convex deployment and the Next.js build stay in sync:

```bash
npx convex deploy --cmd 'npm run build'
```

- The `beta` branch deploys to **beta.ffsn.ai**.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, and tests on every
  push to `main`/`beta` and on every pull request. It does not deploy or
  touch a Convex backend — `convex/_generated` is committed, so typechecking
  works without running `npx convex dev`/`codegen` first.
