import Link from "next/link";

import { BrandLogo, ThemeToggle } from "@/components/broadcast";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="bc-scan relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bc-ground px-4 py-16">
      <div
        className="pointer-events-none absolute -top-24 -right-24 h-[420px] w-[420px] opacity-70"
        style={{
          background:
            "radial-gradient(circle, rgba(201,22,24,0.22) 0%, rgba(201,22,24,0.08) 35%, rgba(14,12,12,0) 68%)",
        }}
        aria-hidden="true"
      />
      <div className="absolute top-4 left-4 sm:top-6 sm:left-6">
        <BrandLogo size="md" />
      </div>
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
        <ThemeToggle />
      </div>

      <div className="relative flex flex-col items-center gap-6 text-center">
        <span className="bc-outline-num text-[120px] sm:text-[160px] lg:text-[200px]">404</span>
        <div className="flex flex-col items-center gap-3">
          <h1 className="bc-display text-bc-ink text-[36px] sm:text-[44px]">Dead air.</h1>
          <p className="max-w-sm text-[15px] leading-relaxed text-bc-text-2">
            This page got cut for a commercial break and never came back. Let&apos;s get you back
            to the broadcast.
          </p>
        </div>
        <Button asChild variant="glow" size="lg">
          <Link href="/">Back to home</Link>
        </Button>
      </div>
    </div>
  );
}
