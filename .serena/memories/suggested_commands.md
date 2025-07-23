# Development Commands

## Essential Commands

### Development
```bash
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
```

### Convex (Backend)
```bash
npx convex dev       # Start Convex development server
npx convex deploy    # Deploy to Convex
```

### Task Completion Commands
Run these after completing coding tasks:
```bash
npm run lint         # Check for linting errors
npm run build        # Verify build passes
```

## Utility Commands (macOS/Darwin)
- `ls -la` - List files with details
- `find . -name "*.tsx" -type f` - Find TypeScript React files
- `grep -r "pattern" src/` - Search in source code
- `git status` - Check git status
- `git add .` - Stage all changes
- `git commit -m "message"` - Commit changes

## shadcn/ui Commands
```bash
npx shadcn@latest add button     # Add UI components
npx shadcn@latest add card       # Add specific components
```