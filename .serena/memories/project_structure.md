# Project Structure

## Root Directory
```
ffsn/
├── src/                    # Source code
├── convex/                 # Convex backend functions
├── public/                 # Static assets
├── .serena/               # Serena configuration
├── .claude/               # Claude configuration
├── components.json        # shadcn/ui configuration
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── eslint.config.mjs      # ESLint configuration
├── next.config.ts         # Next.js configuration
├── postcss.config.mjs     # PostCSS configuration
├── ffsn-design-docs.md    # Design documentation
└── ffsn-implementation-guide.md # Implementation guide
```

## Source Code Structure (`src/`)
```
src/
├── app/                   # Next.js App Router
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Home page
│   ├── globals.css        # Global styles
│   └── favicon.ico        # Favicon
└── lib/
    └── utils.ts           # Utility functions
```

## Planned Structure (As Development Progresses)
```
src/
├── app/                   # Next.js App Router pages
├── components/            # Reusable components
│   └── ui/               # shadcn/ui components
├── lib/                   # Utility functions
├── hooks/                 # Custom React hooks
└── types/                 # TypeScript type definitions
```

## Convex Structure
```
convex/
├── _generated/           # Auto-generated files
├── README.md            # Convex documentation
└── tsconfig.json        # Convex TypeScript config
```