# Task Completion Checklist

## Required Steps After Code Changes

### 1. Code Quality Checks
- [ ] Run `npm run lint` to check for ESLint errors
- [ ] Fix any linting issues that appear
- [ ] Ensure TypeScript types are properly defined

### 2. Build Verification
- [ ] Run `npm run build` to verify production build works
- [ ] Fix any build errors or warnings
- [ ] Check that all imports resolve correctly

### 3. Code Review
- [ ] Verify code follows project conventions
- [ ] Check that components use proper shadcn/ui patterns
- [ ] Ensure Tailwind classes are properly applied
- [ ] Validate TypeScript strict mode compliance

### 4. Testing (when applicable)
- [ ] Test functionality in development mode (`npm run dev`)
- [ ] Verify responsive design works
- [ ] Check authentication flows (when implemented)
- [ ] Test database operations (when implemented)

### 5. Documentation
- [ ] Update relevant comments in code
- [ ] Document any new patterns or conventions
- [ ] Update memory files if project structure changes