# Project Structure

## Root Directory
```
ffsn/
├── src/                    # Source code
├── convex/                 # Convex backend functions
├── public/                 # Static assets (includes FFSN.png)
├── .serena/               # Serena configuration
├── .claude/               # Claude configuration
├── components.json        # shadcn/ui configuration
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── eslint.config.mjs      # ESLint configuration
├── next.config.ts         # Next.js configuration
├── postcss.config.mjs     # PostCSS configuration
├── ffsn-design-docs.md    # Design documentation
├── ffsn-implementation-guide.md # Implementation guide
├── PLAYER_SYNC_IMPLEMENTATION.md # Player sync documentation
├── espn_fantasy_api_schemas.md # ESPN API schemas
├── ffsn-ai-personas.md    # AI persona definitions
├── ffsn-content-types.md  # Content type specifications
├── ffsn-content-generation-plan.md # Content generation planning
├── README-espn-news.md    # ESPN news integration docs
└── sync-example.md        # Sync example documentation
```

## Source Code Structure (`src/`)
```
src/
├── app/                   # Next.js App Router
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Home page
│   ├── globals.css        # Global styles
│   ├── favicon.ico        # Favicon
│   ├── articles/          # Article viewing
│   │   └── [id]/
│   │       ├── page.tsx
│   │       └── ArticleClient.tsx
│   ├── dashboard/         # User dashboard
│   │   └── page.tsx
│   ├── invite/            # Team invitation flow
│   │   └── [token]/
│   │       └── page.tsx
│   ├── leagues/           # League management
│   │   └── [id]/
│   │       ├── page.tsx
│   │       ├── layout.tsx
│   │       └── settings/
│   │           └── page.tsx
│   ├── setup/             # Initial setup
│   │   └── page.tsx
│   ├── sign-in/           # Authentication
│   │   ├── page.tsx
│   │   └── sso-callback/
│   │       └── page.tsx
│   ├── sign-up/           # User registration
│   │   └── page.tsx
│   └── sync/              # Data synchronization
│       ├── page.tsx
│       └── actions.ts
├── components/            # Reusable components
│   ├── ui/               # shadcn/ui components
│   │   ├── ArticleSkeleton.tsx
│   │   ├── badge.tsx
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── form.tsx
│   │   ├── label.tsx
│   │   ├── pagination.tsx
│   │   ├── progress.tsx
│   │   ├── radio-group.tsx
│   │   ├── select.tsx
│   │   ├── separator.tsx
│   │   ├── sonner.tsx
│   │   ├── tabs.tsx
│   │   └── textarea.tsx
│   ├── ArticleList.tsx
│   ├── CommissionerTeamSelection.tsx
│   ├── ContentGenerator.tsx
│   ├── DraftDataViewer.tsx
│   ├── DraftOrderDisplay.tsx
│   ├── HistoricalDataSync.tsx
│   ├── HistoricalRosterManager.tsx
│   ├── LeagueHomepage.tsx
│   ├── LeagueSettingsPage.tsx
│   ├── LeagueWeeklySection.tsx
│   ├── MarkdownPreview.tsx
│   ├── MatchupDisplay.tsx
│   ├── PlayerManagement.tsx
│   ├── TeamInviteManager.tsx
│   ├── auth-sync.tsx
│   ├── convex-client-provider.tsx
│   ├── create-league-form.tsx
│   └── league-card.tsx
├── hooks/                 # Custom React hooks
│   ├── use-auth-sync.ts
│   └── use-draft-status.ts
├── lib/                   # Utility functions
│   ├── ai/               # AI content generation
│   │   ├── content-generation-service.ts
│   │   ├── content-templates.ts
│   │   ├── persona-prompts.ts
│   │   └── prompt-builder.ts
│   ├── convex.ts
│   ├── suspense-data.ts
│   └── utils.ts
├── types/                 # TypeScript type definitions
└── middleware.ts          # Next.js middleware
```

## Convex Backend Structure (`convex/`)
```
convex/
├── _generated/           # Auto-generated files
│   ├── api.d.ts
│   ├── api.js
│   ├── dataModel.d.ts
│   ├── server.d.ts
│   └── server.js
├── aiContent.ts          # AI content generation functions
├── auth.config.js        # Authentication configuration
├── crons.ts              # Scheduled tasks
├── espn.ts               # ESPN API integration
├── espnNews.ts           # ESPN news integration
├── espnSync.ts           # ESPN data synchronization
├── leagues.ts            # League management functions
├── matchups.ts           # Matchup management
├── news.ts               # News management
├── playerSync.ts         # Player synchronization
├── playerSyncInternal.ts # Internal player sync helpers
├── schema.ts             # Database schema
├── teamClaims.ts         # Team claiming functionality
├── teamInvitations.ts    # Team invitation system
├── teams.ts              # Team management
├── users.ts              # User management
├── README.md             # Convex documentation
└── tsconfig.json         # Convex TypeScript config
```

## Key Features
- **Authentication**: Clerk-based authentication with SSO support
- **League Management**: Create, join, and manage fantasy football leagues
- **ESPN Integration**: Sync data from ESPN Fantasy Football
- **AI Content Generation**: Generate articles and content using AI personas
- **Team Management**: Claim teams, send invitations, manage rosters
- **Historical Data**: Track and display historical league data
- **Real-time Updates**: Convex-powered real-time data synchronization