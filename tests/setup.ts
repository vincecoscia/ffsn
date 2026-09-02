// Global test setup, loaded once before the test files run (see
// `setupFiles` in vitest.config.ts).
//
// convex/stripe.ts constructs a `Stripe` client at module load time
// (`new Stripe(process.env.STRIPE_SECRET_KEY!, ...)`), which throws
// immediately if the key is missing. Tests never talk to the real Stripe
// API (only the idempotency-tracking internal mutations are exercised), so
// a dummy key is enough to let the module load under convex-test.
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy_for_tests";
