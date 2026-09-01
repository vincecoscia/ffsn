import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Default-deny: every route requires authentication EXCEPT those explicitly
// listed here. This prevents new/forgotten routes (e.g. the former
// /test-comments and /sync pages) from silently shipping without a login gate.
// The Stripe webhook must stay public because Stripe calls it unauthenticated
// (it is verified by signature instead).
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/invite(.*)',
  '/articles(.*)',
  '/api/stripe/webhook(.*)',
])

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}