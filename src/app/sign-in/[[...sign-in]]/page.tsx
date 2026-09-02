import { SignIn } from "@clerk/nextjs";

import { BrandLogo, ThemeToggle } from "@/components/broadcast";

export default function SignInPage() {
  return (
    <div className="bc-scan relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bc-ground px-4 py-12">
      <div
        className="pointer-events-none absolute -top-24 -right-24 h-[420px] w-[420px] opacity-70"
        style={{
          background:
            "radial-gradient(circle, rgba(201,22,24,0.22) 0%, rgba(201,22,24,0.08) 35%, rgba(14,12,12,0) 68%)",
        }}
        aria-hidden="true"
      />
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
        <ThemeToggle />
      </div>
      <div className="relative flex w-full max-w-md flex-col items-center gap-6">
        <BrandLogo size="lg" />
        <span className="bc-label text-bc-text-3">Sign in to the network</span>
        <SignIn
          appearance={{
            elements: {
              rootBox: "mx-auto !w-full",
              card: "shadow-none !w-full",
            },
          }}
        />
      </div>
    </div>
  );
}
