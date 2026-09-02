import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

export type PersonaAvatarVariant = "portrait" | "bust";

export interface PersonaAvatarProps {
  /** The writer's display name or slug, e.g. "Mel Diaper" or "mel-diaper". Matched loosely against the five drawn personas. */
  persona: string;
  /** Size in px. Only applies to `variant="bust"` — `"portrait"` fills its container (give the parent explicit dimensions). Default 48. */
  size?: number;
  /** `"bust"` (default) is a tight square headshot crop for bylines; `"portrait"` is the full waist-up illustration used on writer cards. */
  variant?: PersonaAvatarVariant;
  className?: string;
}

// Token-driven fills so the silhouettes read correctly in both themes.
const STRONG = "var(--bc-border-strong)"; // head / neck / shoulders base shape
const INK = "var(--bc-ink)"; // light detail linework (glasses, headset, cap text, hair)
const RED = "var(--bc-red)"; // brand red accents
const RED_DEEP = "var(--bc-red-deep)"; // deep red (cap bill underside)
const SIGNAL = "var(--bc-signal)"; // Stan's neon bar chart
const TEXT_2 = "var(--bc-text-2)"; // muted grey (Rick's cap underside)
const SCAN = "var(--bc-scan)"; // faint diagonal highlight, portrait only

type IllustrationProps = { variant: PersonaAvatarVariant };
type Illustration = (props: IllustrationProps) => ReactElement;

function DiagonalHighlight({ variant }: IllustrationProps) {
  if (variant !== "portrait") return null;
  return <path d="M0 300 L256 60 L256 300 Z" fill={SCAN} />;
}

/** 01 — Mel Diaper: headset + mic. */
const MelIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <path
      d="M24 300 C24 234 72 206 128 206 C184 206 232 234 232 300 Z"
      fill={STRONG}
    />
    <path d="M92 300 L128 236 L164 300 Z" fill={RED} />
    <rect x="110" y="156" width="36" height="56" fill={STRONG} />
    <ellipse cx="128" cy="116" rx="48" ry="56" fill={STRONG} />
    <path
      d="M76 116 C76 62 180 62 180 116"
      stroke={INK}
      strokeWidth="7"
      fill="none"
      strokeLinecap="round"
    />
    <rect x="66" y="106" width="16" height="30" rx="3" fill={INK} />
    <rect x="174" y="106" width="16" height="30" rx="3" fill={INK} />
    <path
      d="M82 134 C88 158 100 166 118 166"
      stroke={INK}
      strokeWidth="5"
      fill="none"
      strokeLinecap="round"
    />
    <circle cx="122" cy="166" r="6" fill={RED} />
    <path d="M100 106 L118 112 M156 106 L138 112" stroke={INK} strokeWidth="5" strokeLinecap="round" />
  </>
);

/** 02 — Stan Deviation: glasses + a rising bar chart. */
const StanIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <path
      d="M24 300 C24 234 72 206 128 206 C184 206 232 234 232 300 Z"
      fill={STRONG}
    />
    <rect x="110" y="156" width="36" height="56" fill={STRONG} />
    <ellipse cx="128" cy="116" rx="46" ry="56" fill={STRONG} />
    <path d="M82 84 C90 58 166 58 174 84 L174 96 L82 96 Z" fill={STRONG} />
    <rect x="88" y="104" width="34" height="24" rx="3" fill="none" stroke={INK} strokeWidth="4" />
    <rect x="134" y="104" width="34" height="24" rx="3" fill="none" stroke={INK} strokeWidth="4" />
    <path d="M122 114 L134 114" stroke={INK} strokeWidth="4" />
    <path d="M82 112 L88 112 M168 112 L174 112" stroke={INK} strokeWidth="4" />
    <rect x="150" y="270" width="12" height="30" fill={SIGNAL} />
    <rect x="166" y="256" width="12" height="44" fill={SIGNAL} />
    <rect x="182" y="238" width="12" height="62" fill={SIGNAL} />
  </>
);

/** 03 — Vinny "The Sauce" Marinara: fedora + red band. */
const VinnyIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <path
      d="M24 300 C24 234 72 206 128 206 C184 206 232 234 232 300 Z"
      fill={STRONG}
    />
    <path d="M96 208 L128 262 L160 208 L150 206 L128 236 L106 206 Z" fill={INK} />
    <rect x="110" y="156" width="36" height="56" fill={STRONG} />
    <ellipse cx="128" cy="120" rx="46" ry="54" fill={STRONG} />
    <path d="M94 90 L100 52 C112 42 144 42 156 52 L162 90 Z" fill={INK} />
    <ellipse cx="128" cy="90" rx="66" ry="11" fill={INK} />
    <path d="M96 82 L160 82 L162 90 L94 90 Z" fill={RED} />
    <path d="M150 128 L188 118" stroke={INK} strokeWidth="4" strokeLinecap="round" />
  </>
);

/** 04 — Chad Thunderhype: spiked hair + shades. */
const ChadIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <path
      d="M12 300 C12 228 66 200 128 200 C190 200 244 228 244 300 Z"
      fill={STRONG}
    />
    <path d="M118 236 L142 236 L128 262 L138 262 L112 292 L122 262 L112 262 Z" fill={RED} />
    <rect x="110" y="156" width="36" height="52" fill={STRONG} />
    <ellipse cx="128" cy="122" rx="46" ry="54" fill={STRONG} />
    <path
      d="M82 96 L92 48 L104 84 L116 34 L128 80 L140 32 L152 82 L164 44 L174 96 Z"
      fill={INK}
    />
    <path
      d="M86 118 L124 118 L124 136 C124 140 120 142 116 142 L94 142 C90 142 86 140 86 136 Z"
      fill={INK}
    />
    <path
      d="M132 118 L170 118 L170 136 C170 140 166 142 162 142 L140 142 C136 142 132 140 132 136 Z"
      fill={INK}
    />
    <path d="M124 124 L132 124" stroke={INK} strokeWidth="4" />
  </>
);

/** 05 — Rick "Two Beers" O'Sullivan: "87" cap + two cans. */
const RickIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <path
      d="M24 300 C24 234 72 206 128 206 C184 206 232 234 232 300 Z"
      fill={STRONG}
    />
    <rect x="110" y="156" width="36" height="56" fill={STRONG} />
    <ellipse cx="128" cy="122" rx="46" ry="54" fill={STRONG} />
    <path
      d="M88 144 C96 190 160 190 168 144 C154 158 102 158 88 144 Z"
      fill={TEXT_2}
    />
    <path d="M84 108 C84 60 172 60 172 108 Z" fill={RED} />
    <path d="M74 108 L182 108 L182 118 L74 118 Z" fill={RED_DEEP} />
    <text
      x="128"
      y="100"
      textAnchor="middle"
      className="font-display font-extrabold"
      fontSize="26"
      fill={INK}
    >
      87
    </text>
    <rect x="196" y="238" width="22" height="46" rx="3" fill={INK} />
    <rect x="196" y="250" width="22" height="6" fill={RED} />
    <rect x="222" y="252" width="18" height="40" rx="3" fill={INK} />
    <rect x="222" y="262" width="18" height="5" fill={RED} />
  </>
);

const ILLUSTRATIONS: Array<{ test: RegExp; render: Illustration }> = [
  { test: /mel/i, render: MelIllustration },
  { test: /stan/i, render: StanIllustration },
  { test: /vinny/i, render: VinnyIllustration },
  { test: /chad/i, render: ChadIllustration },
  { test: /rick/i, render: RickIllustration },
];

function matchIllustration(persona: string): Illustration | null {
  return ILLUSTRATIONS.find(({ test }) => test.test(persona))?.render ?? null;
}

function getInitials(value: string): string {
  const cleaned = value.replace(/["“”'‘’(][^"“”'‘’)]*["“”'‘’)]/g, " ").trim();
  const words = cleaned.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function InitialsFallback({
  persona,
  size,
  variant,
  className,
}: Required<Pick<PersonaAvatarProps, "persona" | "size" | "variant">> & { className?: string }) {
  const initials = getInitials(persona);

  if (variant === "portrait") {
    return (
      <div
        aria-hidden="true"
        className={cn(
          "flex h-full w-full items-center justify-center bg-bc-panel-2 font-display text-6xl font-extrabold text-bc-text-3",
          className
        )}
      >
        {initials}
      </div>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center bg-bc-plate font-display font-extrabold text-bc-plate-fg",
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }}
    >
      {initials}
    </span>
  );
}

/**
 * The five drawn on-air-talent silhouettes (Mel/Stan/Vinny/Chad/Rick),
 * matched loosely against `persona`, with an initials-plate fallback for
 * any other writer (e.g. "mike-harrison").
 */
export function PersonaAvatar({ persona, size = 48, variant = "bust", className }: PersonaAvatarProps) {
  const render = matchIllustration(persona);

  if (!render) {
    return <InitialsFallback persona={persona} size={size} variant={variant} className={className} />;
  }

  if (variant === "portrait") {
    return (
      <svg
        viewBox="0 0 256 300"
        preserveAspectRatio="xMidYMid slice"
        className={cn("block h-full w-full", className)}
        role="img"
        aria-label={persona}
      >
        {render({ variant })}
      </svg>
    );
  }

  return (
    <svg
      viewBox="20 30 216 216"
      preserveAspectRatio="xMidYMid slice"
      width={size}
      height={size}
      className={cn("block flex-none", className)}
      role="img"
      aria-label={persona}
    >
      {render({ variant })}
    </svg>
  );
}
