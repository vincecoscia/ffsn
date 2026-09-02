import { cn } from "@/lib/utils";

export interface LoadingScreenProps {
  message?: string;
  className?: string;
}

/** Full-height centered loading state: a pulsing red dot over a `bc-label` message. */
export function LoadingScreen({ message = "Loading", className }: LoadingScreenProps) {
  return (
    <div
      role="status"
      className={cn("flex min-h-[60vh] flex-col items-center justify-center gap-4", className)}
    >
      <span className="bc-pulse size-3 flex-none bg-bc-red" aria-hidden="true" />
      <span className="bc-label text-bc-text-2">{message}</span>
    </div>
  );
}

export interface SpinnerProps {
  /** Overall size in px. Default 16. */
  size?: number;
  className?: string;
}

const SPINNER_DELAYS = [0, 0.15, 0.3];

/** Small inline loading indicator: three staggered pulsing squares (kept sharp-cornered, no spinning ring). */
export function Spinner({ size = 16, className }: SpinnerProps) {
  const dot = Math.max(2, Math.round(size / 4));

  return (
    <span role="status" aria-label="Loading" className={cn("inline-flex items-center gap-1", className)}>
      {SPINNER_DELAYS.map((delay) => (
        <span
          key={delay}
          className="bc-pulse bg-bc-red"
          style={{ width: dot, height: dot, animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}
