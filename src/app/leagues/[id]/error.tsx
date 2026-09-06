"use client";

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/broadcast";
import { Button } from "@/components/ui/button";

/**
 * League-segment error boundary. Before this existed, one throwing query on a hard load replaced
 * the whole document with Next's built-in "This page couldn't load" page (prod, 2026-09-06). Now a
 * failure inside a league route stays inside the league shell with a retry.
 */
export default function LeagueError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("League route error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <EmptyState
        icon={<TriangleAlert className="size-6" strokeWidth={1.8} />}
        title="The desk lost the signal"
        description="Something went wrong loading this league page. Try again, or head back to your leagues."
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={() => reset()}>Try again</Button>
            <Button asChild variant="outline">
              <Link href="/dashboard">Your leagues</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
