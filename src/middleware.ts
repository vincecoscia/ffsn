import { NextRequest, NextResponse } from "next/server";

// Default-deny UX gate: everything except the public paths below redirects to
// /sign-in when there is no Better Auth session cookie. This is a fast redirect
// layer only — the real authorization boundary is in the Convex functions, each
// of which verifies ctx.auth.getUserIdentity() and membership. The Stripe
// webhook and the Better Auth routes must stay public.
const PUBLIC_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/sign-in(?:\/|$)/,
  /^\/sign-up(?:\/|$)/,
  /^\/invite(?:\/|$)/,
  /^\/articles(?:\/|$)/,
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/stripe\/webhook(?:\/|$)/,
];

function hasSessionCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some(
      (c) =>
        c.name === "better-auth.session_token" ||
        c.name === "__Secure-better-auth.session_token"
    );
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATTERNS.some((re) => re.test(pathname))) {
    return NextResponse.next();
  }
  if (!hasSessionCookie(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
