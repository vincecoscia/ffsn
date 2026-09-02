import { cn } from "@/lib/utils";

export interface BannerPlaceholderProps {
  /** Big outlined background text, e.g. "WK 3" or "3-0". */
  text?: string;
  /**
   * Disambiguates the internal gradient ids when multiple instances render
   * on the same page at once. Only needed if you see a gradient render
   * incorrectly with several placeholders visible together.
   */
  gradientId?: string;
  className?: string;
}

/**
 * The drawn yard-line / studio football illustration used wherever an
 * article or featured story has no banner image. Fills its container
 * (give the parent explicit height) via `preserveAspectRatio="xMidYMid
 * slice"`, and fades into the container's background at the bottom.
 */
export function BannerPlaceholder({ text, gradientId = "default", className }: BannerPlaceholderProps) {
  const bgId = `bc-banner-bg-${gradientId}`;
  const fadeId = `bc-banner-fade-${gradientId}`;

  return (
    <svg
      viewBox="0 0 1440 480"
      preserveAspectRatio="xMidYMid slice"
      className={cn("block h-full w-full", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--bc-panel-2)" />
          <stop offset="1" stopColor="var(--bc-ground)" />
        </linearGradient>
        <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--bc-ground)" stopOpacity="0" />
          <stop offset="0.6" stopColor="var(--bc-ground)" stopOpacity="0.25" />
          <stop offset="1" stopColor="var(--bc-ground)" stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <rect width="1440" height="480" fill={`url(#${bgId})`} />
      <g stroke="var(--bc-border-strong)" strokeWidth="1.5">
        <path d="M0 120 H1440 M0 180 H1440 M0 250 H1440 M0 335 H1440 M0 430 H1440" />
      </g>
      <g stroke="var(--bc-border-strong)" strokeWidth="1">
        <path d="M560 120 L360 480 M880 120 L1080 480 M720 120 V480 M640 120 L560 480 M800 120 L880 480" />
      </g>
      <circle cx="720" cy="335" r="90" fill="none" stroke="var(--bc-border-strong)" strokeWidth="1.5" />
      <circle cx="1080" cy="290" r="140" fill="var(--bc-red)" opacity="0.1" />
      <g transform="translate(1080 290) rotate(-32)">
        <ellipse cx="0" cy="0" rx="112" ry="66" fill="var(--bc-red-deep)" />
        <ellipse cx="0" cy="0" rx="112" ry="66" fill="none" stroke="var(--bc-red)" strokeWidth="3" />
        <path d="M-40 0 H40" stroke="var(--bc-ink)" strokeWidth="4" strokeLinecap="round" />
        <path
          d="M-26 -9 V9 M-9 -9 V9 M9 -9 V9 M26 -9 V9"
          stroke="var(--bc-ink)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M-80 -34 C-48 -56 48 -56 80 -34"
          stroke="var(--bc-ink)"
          strokeWidth="2"
          fill="none"
          opacity="0.5"
        />
        <path
          d="M-80 34 C-48 56 48 56 80 34"
          stroke="var(--bc-ink)"
          strokeWidth="2"
          fill="none"
          opacity="0.5"
        />
      </g>
      {text && (
        <text
          x="1392"
          y="200"
          textAnchor="end"
          className="font-display font-extrabold"
          fontSize="200"
          fill="none"
          stroke="var(--bc-border-strong)"
          strokeWidth="1.5"
          letterSpacing="-4"
        >
          {text}
        </text>
      )}
      <rect width="1440" height="480" fill={`url(#${fadeId})`} />
    </svg>
  );
}
