import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

export type PersonaAvatarVariant = "portrait" | "bust";

export interface PersonaAvatarProps {
  /** The writer's display name or slug, e.g. "Mel Diaper" or "mel-diaper". Matched loosely against the drawn personas. */
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
const SIGNAL = "var(--bc-signal)"; // neon data accents (Nina's bar chart, Dex's phone screen)
const TEXT_2 = "var(--bc-text-2)"; // muted grey (Rick's cap underside, Walt's hair)
const SCAN = "var(--bc-scan)"; // faint diagonal highlight, portrait only

type IllustrationProps = { variant: PersonaAvatarVariant };
type Illustration = (props: IllustrationProps) => ReactElement;

function DiagonalHighlight({ variant }: IllustrationProps) {
  if (variant !== "portrait") return null;
  return <path d="M0 300 L256 60 L256 300 Z" fill={SCAN} />;
}

// Shared bust geometry. Every silhouette sits on the same shoulders/neck/head so the
// lineup reads as one set and the `bust` crop (viewBox "20 30 216 216") frames them all
// identically — keep new writers on these three shapes and differentiate with props.
const SHOULDERS = "M24 300 C24 234 72 206 128 206 C184 206 232 234 232 300 Z";

function Bust() {
  return (
    <>
      <path d={SHOULDERS} fill={STRONG} />
      <rect x="110" y="156" width="36" height="56" fill={STRONG} />
      <ellipse cx="128" cy="118" rx="46" ry="55" fill={STRONG} />
    </>
  );
}

/** Mel Diaper — The Draft Disaster: headset + mic. */
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

/** Retired — Stan Deviation: glasses + a rising bar chart. */
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

/** Retired — Vinny "The Sauce" Marinara: fedora + red band. */
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

/** Retired — Chad Thunderhype: spiked hair + shades. */
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

/** Retired — Rick "Two Beers" O'Sullivan: "87" cap + two cans. */
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

/* -------------------------------------------------------------------------- */
/* Roster B — the six writers currently on air                                  */
/* -------------------------------------------------------------------------- */

/** Curtis Vaughn — Studio Anchor: earpiece coil + flagged hand mic. */
const CurtisIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <Bust />
    {/* Neat side-part anchor hair. */}
    <path d="M82 104 C82 58 174 58 174 104 C166 82 150 74 132 78 C112 82 92 88 82 104 Z" fill={INK} />
    {/* Collar and knot. */}
    <path d="M108 208 L128 228 L148 208 L142 206 L128 220 L114 206 Z" fill={INK} />
    {/* Earpiece + coil down into the collar. */}
    <circle cx="80" cy="126" r="8" fill={INK} />
    <path
      d="M80 136 C66 158 74 182 86 200"
      stroke={INK}
      strokeWidth="5"
      fill="none"
      strokeLinecap="round"
    />
    {/* Flagged hand mic: grille, red station flag, shaft. */}
    <ellipse cx="200" cy="200" rx="13" ry="14" fill={INK} />
    <path d="M191 195 L209 195" stroke={STRONG} strokeWidth="4" strokeLinecap="round" />
    <rect x="186" y="212" width="28" height="28" fill={RED} />
    <rect x="193" y="240" width="14" height="48" fill={INK} />
  </>
);

/** Simone "Sam" Ortega — Sideline Reporter: stick mic + credential lanyard. */
const SamIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <Bust />
    {/* Hair pulled back, low ponytail on the off-mic side. */}
    <path d="M80 118 C78 60 178 60 176 118 C170 86 86 86 80 118 Z" fill={INK} />
    <path d="M74 128 C58 148 58 178 70 196 C80 180 78 148 86 134 Z" fill={INK} />
    {/* Credential on a red lanyard. */}
    <path
      d="M104 208 L124 226 M152 208 L132 226"
      stroke={RED}
      strokeWidth="5"
      strokeLinecap="round"
    />
    <rect x="110" y="222" width="36" height="26" fill={INK} />
    <rect x="110" y="222" width="36" height="7" fill={RED} />
    <path
      d="M116 236 L140 236 M116 242 L131 242"
      stroke={STRONG}
      strokeWidth="3"
      strokeLinecap="round"
    />
    {/* Stick mic, no flag — the one she actually holds out. */}
    <ellipse cx="200" cy="196" rx="12" ry="13" fill={STRONG} stroke={INK} strokeWidth="4" />
    <rect x="193" y="208" width="14" height="76" fill={INK} />
    <rect x="193" y="218" width="14" height="5" fill={RED} />
  </>
);

/** Nina Sharpe — The Numbers Desk: glasses + stylus over a three-bar chart. */
const NinaIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <Bust />
    {/* Bob, drawn before the glasses so the frames sit on top. */}
    <path
      d="M78 122 C76 60 180 60 178 122 L178 152 L166 152 C170 126 168 104 160 96 C144 86 112 86 96 96 C88 104 86 126 90 152 L78 152 Z"
      fill={INK}
    />
    <rect x="88" y="106" width="34" height="24" rx="3" fill="none" stroke={INK} strokeWidth="4" />
    <rect x="134" y="106" width="34" height="24" rx="3" fill="none" stroke={INK} strokeWidth="4" />
    <path d="M122 116 L134 116" stroke={INK} strokeWidth="4" />
    {/* Three-bar chart with the stylus drawn across it. */}
    <rect x="150" y="270" width="12" height="30" fill={SIGNAL} />
    <rect x="166" y="256" width="12" height="44" fill={SIGNAL} />
    <rect x="182" y="238" width="12" height="62" fill={SIGNAL} />
    <path d="M140 292 L204 228" stroke={INK} strokeWidth="7" strokeLinecap="round" />
    <path d="M204 228 L213 219" stroke={RED} strokeWidth="7" strokeLinecap="round" />
  </>
);

/** Dex Alvarez — Insider · Transactions Desk: phone at the ear. */
const DexIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <Bust />
    <path d="M84 106 C86 62 170 62 172 106 C160 84 96 84 84 106 Z" fill={INK} />
    {/* Collar and red tie. */}
    <path d="M108 208 L128 228 L148 208 L142 206 L128 220 L114 206 Z" fill={RED} />
    {/* Hand, then the phone on top of it, held to the ear. */}
    <path
      d="M166 128 L166 156 C176 164 194 160 196 148 L196 126 Z"
      fill={STRONG}
      stroke={INK}
      strokeWidth="3"
    />
    <g transform="rotate(10 182 124)">
      <rect x="170" y="98" width="24" height="52" fill={INK} />
      <rect x="174" y="106" width="16" height="34" fill={SIGNAL} />
    </g>
    <path
      d="M202 86 C210 90 214 97 214 105"
      stroke={SIGNAL}
      strokeWidth="4"
      fill="none"
      strokeLinecap="round"
    />
    <path
      d="M208 74 C222 81 228 93 228 105"
      stroke={SIGNAL}
      strokeWidth="4"
      fill="none"
      strokeLinecap="round"
    />
  </>
);

/** Walt Brennan — The Veteran Columnist: glasses pushed up + folded newspaper. */
const WaltIllustration: Illustration = ({ variant }) => (
  <>
    <DiagonalHighlight variant={variant} />
    <Bust />
    {/* Grey hair, receding, with sideburns. */}
    <path d="M84 96 C90 62 166 62 172 96 C158 80 98 80 84 96 Z" fill={TEXT_2} />
    <path d="M82 100 C78 116 80 134 84 146 C82 124 84 108 90 98 Z" fill={TEXT_2} />
    <path d="M174 100 C178 116 176 134 172 146 C174 124 172 108 166 98 Z" fill={TEXT_2} />
    {/* Reading glasses pushed up into the hairline. */}
    <rect x="88" y="80" width="32" height="22" rx="3" fill="none" stroke={INK} strokeWidth="4" />
    <rect x="136" y="80" width="32" height="22" rx="3" fill="none" stroke={INK} strokeWidth="4" />
    <path d="M120 90 L136 90" stroke={INK} strokeWidth="4" />
    <path d="M82 88 L88 88 M168 88 L174 88" stroke={INK} strokeWidth="4" />
    <path d="M104 142 C114 134 142 134 152 142 C142 152 114 152 104 142 Z" fill={TEXT_2} />
    {/* Folded newspaper under the arm. */}
    <g transform="rotate(-12 74 236)">
      <rect x="38" y="208" width="72" height="54" fill={STRONG} stroke={INK} strokeWidth="3" />
      <path d="M74 208 L74 262" stroke={INK} strokeWidth="3" />
      <path
        d="M46 220 L66 220 M46 230 L66 230 M46 240 L66 240 M82 220 L102 220 M82 230 L102 230 M82 240 L102 240"
        stroke={TEXT_2}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </g>
  </>
);

/**
 * Slug- and name-matched illustrations. Active writers are tested first so a
 * retired pattern can never shadow one of them; the five retired entries stay
 * mapped so archived bylines keep their drawn portrait.
 */
const ILLUSTRATIONS: Array<{ test: RegExp; render: Illustration }> = [
  // Roster B (spec §3)
  { test: /curtis|vaughn/i, render: CurtisIllustration },
  { test: /sam|ortega/i, render: SamIllustration },
  { test: /nina|sharpe/i, render: NinaIllustration },
  { test: /dex|alvarez/i, render: DexIllustration },
  { test: /walt|brennan/i, render: WaltIllustration },
  { test: /mel|diaper/i, render: MelIllustration },
  // Retired — archived bylines only.
  { test: /stan|deviation/i, render: StanIllustration },
  { test: /vinny|marinara/i, render: VinnyIllustration },
  { test: /chad|thunderhype/i, render: ChadIllustration },
  { test: /rick|two-beers|o'sullivan/i, render: RickIllustration },
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
 * The drawn on-air-talent silhouettes — the six current writers (Curtis, Sam,
 * Nina, Dex, Mel, Walt) plus the five retired ones kept for archived bylines —
 * matched by slug or display name against `persona`, with an initials-plate
 * fallback for any other byline (e.g. "mike-harrison").
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
