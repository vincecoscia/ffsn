# Code Style & Conventions

## TypeScript Configuration
- **Target**: ES2017
- **Strict mode**: Enabled
- **Path aliases**: `@/*` points to `./src/*`
- **JSX**: Preserve (handled by Next.js)

## Component Structure
- **UI Components**: Located in `@/components/ui` (shadcn/ui)
- **Custom Components**: Located in `@/components`
- **Utils**: Located in `@/lib/utils`
- **Hooks**: Located in `@/hooks`

## Styling Approach
- **Primary**: Tailwind CSS with utility classes
- **Component Variants**: Class Variance Authority (CVA)
- **CSS Variables**: Enabled for theming
- **Base Color**: Neutral
- **Style**: New York (shadcn/ui style)

## File Naming
- React components: PascalCase (e.g., `LeagueCard.tsx`)
- Utilities: camelCase (e.g., `utils.ts`)
- API routes: kebab-case following Next.js conventions

## Import Organization
- External packages first
- Internal components and utilities
- Relative imports last