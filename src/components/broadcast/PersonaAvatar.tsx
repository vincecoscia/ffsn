import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

export type PersonaAvatarVariant = "portrait" | "bust";

export interface PersonaAvatarProps {
  /** The writer's display name or slug, e.g. "Mel Diaper" or "mel-diaper". Matched loosely against the drawn personas. */
  persona: string;
  /** Size in px. Only applies to `variant="bust"` — `"portrait"` fills its container (give the parent a 3:2 box). Default 48. */
  size?: number;
  /** `"bust"` (default) is a tight square headshot crop for bylines; `"portrait"` is the full 3:2 waist-up illustration used on writer cards. */
  variant?: PersonaAvatarVariant;
  className?: string;
}

/* -------------------------------------------------------------------------- */
/* Palette — every fill is a `--bc-*` token so the set inverts with the theme  */
/* -------------------------------------------------------------------------- */

const STRONG = "var(--bc-border-strong)"; // skin: head, neck, hands, jacket
const MID = "var(--bc-text-3)"; // hair, shirts, soft garments — one step off the skin tone
const SILVER = "var(--bc-text-2)"; // Walt's hair, newsprint
const INK = "var(--bc-ink)"; // hard props: glasses, headsets, mics, phones, chains
const RED = "var(--bc-red)";
const RED_DEEP = "var(--bc-red-deep)";
const SIGNAL = "var(--bc-signal)"; // screens and chart bars
const CUT = "var(--bc-panel-2)"; // the card background, used as negative-space outlines (a hand over a torso)
const SCAN = "var(--bc-scan)"; // faint diagonal highlight, portrait only

/* -------------------------------------------------------------------------- */
/* Frame                                                                       */
/* -------------------------------------------------------------------------- */

// Everything is drawn in one 384×256 landscape frame — the same 3:2 box `WriterPlate`
// gives the portrait, so nothing is ever cropped there. The bust is a square crop of
// that frame around the head; keep a writer's identifying prop inside it.
const PORTRAIT_VIEWBOX = "0 0 384 256";
const BUST = { x: 112, y: 36, size: 160 }; // x 112–272, y 36–196
const BUST_VIEWBOX = `${BUST.x} ${BUST.y} ${BUST.size} ${BUST.size}`;

type IllustrationProps = { variant: PersonaAvatarVariant };
type Illustration = (props: IllustrationProps) => ReactElement;

/* -------------------------------------------------------------------------- */
/* Shared anatomy — head at (192,104) rx40 ry46, neck to y184, shoulders x92–292 */
/* -------------------------------------------------------------------------- */

function Highlight({ variant }: IllustrationProps) {
  if (variant !== "portrait") return null;
  return <path d="M0 256 L384 40 L384 256 Z" fill={SCAN} />;
}

function Torso({ fill = STRONG }: { fill?: string }) {
  return (
    <path
      d="M92 256 C92 224 108 204 140 192 C150 188 160 186 172 184 L212 184 C224 186 234 188 244 192 C276 204 292 224 292 256 Z"
      fill={fill}
    />
  );
}

function Neck() {
  return <path d="M178 134 L206 134 L210 184 L174 184 Z" fill={STRONG} />;
}

function Head() {
  return <ellipse cx="192" cy="104" rx="40" ry="46" fill={STRONG} />;
}

/** A hand: a skin disc with a background-coloured ring so it separates from the torso behind it. */
function Hand({ x, y, r = 13 }: { x: number; y: number; r?: number }) {
  return (
    <>
      <circle cx={x} cy={y} r={r + 3} fill={CUT} />
      <circle cx={x} cy={y} r={r} fill={STRONG} />
    </>
  );
}

/** A forearm as a thick rounded stroke, outlined in the background colour for the same reason. */
function Forearm({ d, width = 24 }: { d: string; width?: number }) {
  return (
    <>
      <path d={d} stroke={CUT} strokeWidth={width + 6} fill="none" strokeLinecap="round" />
      <path d={d} stroke={STRONG} strokeWidth={width} fill="none" strokeLinecap="round" />
    </>
  );
}

/** The shirt showing through a jacket's V, from the collar down `depth` units. */
function ShirtV({ fill = MID, depth = 40 }: { fill?: string; depth?: number }) {
  return <path d={`M170 184 L192 ${184 + depth} L214 184 Z`} fill={fill} />;
}

function Tie({ rotate = 0, fill = RED }: { rotate?: number; fill?: string }) {
  return (
    <g transform={rotate ? `rotate(${rotate} 192 184)` : undefined}>
      <path d="M184 180 L200 180 L202 190 L182 190 Z" fill={fill} />
      <path d="M184 190 L200 190 L205 238 L192 250 L179 238 Z" fill={fill} />
    </g>
  );
}

function Glasses({ y = 94, h = 20 }: { y?: number; h?: number }) {
  const mid = y + h / 2;
  return (
    <g fill="none" stroke={INK} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round">
      <rect x="158" y={y} width="30" height={h} rx="4" />
      <rect x="196" y={y} width="30" height={h} rx="4" />
      <path d={`M188 ${mid} L196 ${mid}`} />
      <path d={`M151 ${y + 6} L158 ${y + 6} M226 ${y + 6} L233 ${y + 6}`} />
    </g>
  );
}

// Hair sits on an ellipse a touch larger than the head (rx43 ry49) so it has volume;
// the arcs below run from temple to temple over the crown.
const HAIR_ARC_HIGH = "M151.6 87.2 A43 49 0 0 1 232.4 87.2"; // tight crop
const HAIR_ARC = "M149.7 95.5 A43 49 0 0 1 234.3 95.5"; // regular
const HAIR_ARC_LOW = "M149.2 99.7 A43 49 0 0 1 234.8 99.7"; // pulled back / capped

/* -------------------------------------------------------------------------- */
/* Roster B — the seven writers on air (spec §3)                                */
/* -------------------------------------------------------------------------- */

/** Curtis Vaughn — Studio Anchor: suit and tie, earpiece coil, flagged hand mic. */
const CurtisIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <ShirtV depth={76} />
    <Tie />
    <Neck />
    <Head />
    {/* Neat anchor hair with a side part. */}
    <path
      d={`${HAIR_ARC} C230 86 220 78 204 76 C188 75 166 80 158 86 C153 89 150.5 92 149.7 95.5 Z`}
      fill={MID}
    />
    {/* Earpiece and the coiled cable down into the collar. */}
    <circle cx="150" cy="108" r="6" fill={INK} />
    <path
      d="M150 114 C142 119 142 128 151 132 C143 137 143 146 154 152 C146 158 148 168 160 176 L168 184"
      stroke={INK}
      strokeWidth="4.5"
      fill="none"
      strokeLinecap="round"
    />
    {/* Flagged hand mic: grille, station flag, shaft. */}
    <circle cx="256" cy="160" r="13" fill={INK} />
    <path d="M247 156 L265 156 M247 164 L265 164" stroke={CUT} strokeWidth="2" />
    <rect x="243" y="174" width="26" height="22" fill={RED} />
    <rect x="249" y="182" width="14" height="4" fill={INK} />
    <rect x="250" y="196" width="12" height="50" fill={INK} />
    <Forearm d="M258 224 L290 258" />
    <Hand x={256} y={218} />
  </>
);

/** Simone "Sam" Ortega — Sideline Reporter: hair pulled back, credential lanyard, stick mic held out. */
const SamIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    {/* Ponytail swings out behind the off-mic shoulder. */}
    <path d="M160 88 C130 98 126 142 138 178 C144 160 148 146 160 132 Z" fill={MID} />
    <Torso />
    <ShirtV depth={30} />
    <Neck />
    <Head />
    <path d={`${HAIR_ARC_LOW} C230 88 214 80 192 80 C170 80 154 88 149.2 99.7 Z`} fill={MID} />
    {/* Credential on a red lanyard. */}
    <path d="M176 178 L188 210 M208 178 L196 210" stroke={RED} strokeWidth="4" strokeLinecap="round" />
    <rect x="174" y="208" width="36" height="26" fill={INK} />
    <rect x="174" y="208" width="36" height="7" fill={RED} />
    <path d="M180 222 L204 222 M180 228 L196 228" stroke={CUT} strokeWidth="2.5" strokeLinecap="round" />
    {/* Stick mic — the one she actually holds out. */}
    <rect x="256" y="156" width="12" height="70" fill={INK} />
    <rect x="256" y="166" width="12" height="6" fill={RED} />
    <circle cx="262" cy="148" r="13" fill={INK} />
    <path d="M253 144 L271 144 M253 152 L271 152" stroke={CUT} strokeWidth="2" />
    <Forearm d="M264 208 L290 256" />
    <Hand x={262} y={202} />
  </>
);

/** Nina Sharpe — The Numbers Desk: bob, glasses, rolled collar, tablet with a three-bar chart and stylus. */
const NinaIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <Neck />
    {/* Rolled collar at the base of the neck. */}
    <path d="M170 172 C170 165 214 165 214 172 L216 186 L168 186 Z" fill={MID} />
    <Head />
    {/* Bob, then the face back on top with straight bangs. */}
    <path
      d="M147 100 A45 50 0 0 1 237 100 L237 138 C237 146 231 148 226 146 L158 146 C153 148 147 146 147 138 Z"
      fill={MID}
    />
    <path d="M156 84 A40 46 0 1 0 228 84 C216 90 168 90 156 84 Z" fill={STRONG} />
    <Glasses y={94} />
    {/* Tablet: three rising bars, stylus across the top corner. */}
    <rect x="146" y="204" width="92" height="60" rx="4" fill={INK} />
    <rect x="152" y="210" width="80" height="50" fill={CUT} />
    <rect x="162" y="238" width="14" height="22" fill={SIGNAL} />
    <rect x="183" y="226" width="14" height="34" fill={SIGNAL} />
    <rect x="204" y="212" width="14" height="48" fill={SIGNAL} />
    <path d="M270 236 L238 200" stroke={INK} strokeWidth="6" strokeLinecap="round" />
    <circle cx="238" cy="200" r="4" fill={RED} />
    <Forearm d="M150 240 L118 260" />
    <Hand x={150} y={236} r={12} />
    <Forearm d="M272 242 L298 260" />
    <Hand x={272} y={238} r={12} />
  </>
);

/** Dex Alvarez — Insider · Transactions Desk: tight crop, loosened tie, phone at the ear. */
const DexIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <ShirtV depth={36} />
    <Tie rotate={-7} />
    <Neck />
    <Head />
    <path d={`${HAIR_ARC_HIGH} C226 80 210 76 192 76 C174 76 158 80 151.6 87.2 Z`} fill={MID} />
    {/* Arm up, phone to the ear, signal bars. */}
    <Forearm d="M242 132 L276 200" />
    <g transform="rotate(12 238 106)">
      <rect x="225" y="80" width="26" height="50" rx="4" fill={INK} />
      <rect x="229" y="86" width="18" height="34" fill={SIGNAL} />
    </g>
    <Hand x={241} y={130} />
    <path d="M250 70 C256 74 260 80 260 88" stroke={SIGNAL} strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M258 60 C266 66 271 76 271 88" stroke={SIGNAL} strokeWidth="4" fill="none" strokeLinecap="round" />
  </>
);

/** Mel Diaper — The Draft Disaster: suit and a loud tie, a towering swept-back hairdo, a failing draft grade in hand. */
const MelIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <ShirtV depth={76} />
    <Tie fill={SIGNAL} />
    <Neck />
    <Head />
    {/* The hair: a tall, swept-back mass, wider than the head, with a wave at the front and soft ridges. */}
    <path
      d="M150 112 C130 96 132 44 170 30 C186 24 204 26 216 30 C238 36 248 68 244 92 C242 102 238 108 234 112 L230 104 C224 84 212 76 192 78 C172 76 160 84 154 104 Z"
      fill={MID}
    />
    <path
      d="M170 82 C160 66 162 46 178 34 M192 80 C186 62 188 44 200 32 M214 82 C218 64 214 48 224 38"
      stroke={CUT}
      strokeWidth="5"
      fill="none"
      strokeLinecap="round"
      opacity="0.3"
    />
    {/* The grade card. */}
    <g transform="rotate(-8 268 226)">
      <rect x="246" y="198" width="44" height="58" fill={STRONG} stroke={INK} strokeWidth="3" />
      <path d="M258 210 L258 244 M258 210 L280 210 M258 226 L276 226" stroke={RED} strokeWidth="7" strokeLinecap="square" />
    </g>
    <Forearm d="M270 252 L298 264" />
    <Hand x={268} y={248} />
  </>
);

/** Walt Brennan — The Veteran Columnist: receding silver hair, reading glasses, bow tie, folded paper. */
const WaltIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <ShirtV depth={32} />
    {/* Bow tie and cardigan buttons. */}
    <path d="M178 178 L192 184 L206 178 L206 194 L192 188 L178 194 Z" fill={INK} />
    <rect x="189" y="182" width="6" height="8" fill={INK} />
    <circle cx="192" cy="222" r="2.5" fill={CUT} />
    <circle cx="192" cy="238" r="2.5" fill={CUT} />
    <circle cx="192" cy="254" r="2.5" fill={CUT} />
    <Neck />
    <Head />
    {/* Receding silver hair with sideburns. */}
    <path
      d="M151.6 120.8 A43 49 0 1 1 232.4 120.8 L226 122 C224 108 226 92 222 82 C216 72 204 74 192 78 C180 74 168 72 162 82 C158 92 160 108 158 122 Z"
      fill={SILVER}
    />
    <Glasses y={94} />
    {/* Folded paper with a red masthead. */}
    <g transform="rotate(-10 124 226)">
      <rect x="94" y="196" width="60" height="70" fill={STRONG} stroke={INK} strokeWidth="3" />
      <path d="M124 196 L124 266" stroke={INK} strokeWidth="3" />
      <rect x="99" y="202" width="20" height="6" fill={RED} />
      <path
        d="M100 214 L118 214 M100 222 L118 222 M100 230 L118 230 M100 238 L118 238 M130 204 L148 204 M130 212 L148 212 M130 220 L148 220 M130 228 L148 228 M130 236 L148 236"
        stroke={SILVER}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </g>
    <Forearm d="M126 248 L102 268" />
    <Hand x={124} y={246} />
  </>
);

/** Reggie Banks — The Results Desk: backwards snapback, chain, box score in hand. */
const ReggieIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    {/* Bill sticks out behind the head. */}
    <path d="M226 80 C248 76 268 80 276 92 C268 100 248 102 226 98 Z" fill={RED_DEEP} />
    <Torso />
    <path d="M168 178 C168 202 216 202 216 178 Z" fill={MID} />
    <Neck />
    <Head />
    {/* Crown, then the snapback opening and strap facing front. */}
    <path d="M148.2 99.6 A44 50 0 0 1 235.8 99.6 C230 92 208 88 192 88 C176 88 154 92 148.2 99.6 Z" fill={RED} />
    <path d="M183 88 A9 9 0 0 1 201 88 Z" fill={MID} />
    <rect x="180" y="86" width="24" height="6" fill={INK} />
    {/* Chain with a pendant. */}
    <path d="M168 184 C176 212 208 212 216 184" stroke={INK} strokeWidth="6" fill="none" strokeLinecap="round" />
    <path d="M192 204 L200 212 L192 222 L184 212 Z" fill={INK} />
    {/* Sunday's box score. */}
    <g transform="rotate(8 278 230)">
      <rect x="254" y="196" width="48" height="68" fill={STRONG} stroke={INK} strokeWidth="3" />
      <path
        d="M262 208 L294 208 M262 218 L294 218 M262 238 L294 238 M262 248 L294 248"
        stroke={SILVER}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="260" y="224" width="36" height="8" fill={RED} />
    </g>
    <Forearm d="M280 254 L304 266" />
    <Hand x={278} y={250} />
  </>
);

/* -------------------------------------------------------------------------- */
/* Retired — kept so archived bylines keep their drawn portrait                */
/* -------------------------------------------------------------------------- */

/** Stan Deviation: glasses + a rising bar chart. */
const StanIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <ShirtV depth={30} />
    <Neck />
    <Head />
    <path d={`${HAIR_ARC} C228 84 212 78 192 78 C172 78 156 84 149.7 95.5 Z`} fill={MID} />
    <Glasses y={94} />
    <rect x="262" y="236" width="12" height="20" fill={SIGNAL} />
    <rect x="278" y="222" width="12" height="34" fill={SIGNAL} />
    <rect x="294" y="204" width="12" height="52" fill={SIGNAL} />
  </>
);

/** Vinny "The Sauce" Marinara: fedora with a red band, open collar, toothpick. */
const VinnyIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <path d="M166 180 L192 226 L218 180 L208 180 L192 208 L176 180 Z" fill={INK} />
    <Neck />
    <Head />
    <path d="M160 74 L166 46 C176 38 208 38 218 46 L224 74 Z" fill={INK} />
    <ellipse cx="192" cy="76" rx="62" ry="10" fill={INK} />
    <path d="M162 66 L222 66 L224 74 L160 74 Z" fill={RED} />
    <path d="M212 136 L246 128" stroke={INK} strokeWidth="4" strokeLinecap="round" />
  </>
);

/** Chad Thunderhype: spiked hair, shades, a bolt on the chest. */
const ChadIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <path d="M186 196 L206 196 L194 218 L204 218 L180 248 L188 224 L178 224 Z" fill={RED} />
    <Neck />
    <Head />
    <path d="M154 90 L162 44 L172 76 L182 32 L192 72 L202 30 L212 74 L222 40 L230 90 Z" fill={INK} />
    <path d="M156 96 L188 96 L188 112 C188 116 184 118 180 118 L164 118 C160 118 156 116 156 112 Z" fill={INK} />
    <path d="M196 96 L228 96 L228 112 C228 116 224 118 220 118 L204 118 C200 118 196 116 196 112 Z" fill={INK} />
    <path d="M188 101 L196 101" stroke={INK} strokeWidth="4" />
  </>
);

/** Rick "Two Beers" O'Sullivan: "87" cap, beard, two cans. */
const RickIllustration: Illustration = ({ variant }) => (
  <>
    <Highlight variant={variant} />
    <Torso />
    <Neck />
    <Head />
    <path d="M158 120 C164 158 220 158 226 120 C214 132 170 132 158 120 Z" fill={SILVER} />
    <path d="M154 92 C154 50 230 50 230 92 Z" fill={RED} />
    <rect x="146" y="92" width="92" height="9" fill={RED_DEEP} />
    <text
      x="192"
      y="86"
      textAnchor="middle"
      className="font-display font-extrabold"
      fontSize="24"
      fill={INK}
    >
      87
    </text>
    <rect x="256" y="200" width="20" height="40" rx="3" fill={INK} />
    <rect x="256" y="210" width="20" height="5" fill={RED} />
    <rect x="280" y="212" width="16" height="34" rx="3" fill={INK} />
    <rect x="280" y="220" width="16" height="4" fill={RED} />
  </>
);

/**
 * Slug- and name-matched illustrations. Active writers are tested first so a
 * retired pattern can never shadow one of them; the retired entries stay
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
  { test: /reggie|banks/i, render: ReggieIllustration },
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
 * The drawn on-air-talent silhouettes — the seven current writers (Curtis, Sam,
 * Nina, Dex, Mel, Reggie, Walt) plus the four retired ones kept for archived
 * bylines — matched by slug or display name against `persona`, with an
 * initials-plate fallback for any other byline (e.g. "mike-harrison").
 */
export function PersonaAvatar({ persona, size = 48, variant = "bust", className }: PersonaAvatarProps) {
  const render = matchIllustration(persona);

  if (!render) {
    return <InitialsFallback persona={persona} size={size} variant={variant} className={className} />;
  }

  if (variant === "portrait") {
    return (
      <svg
        viewBox={PORTRAIT_VIEWBOX}
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
      viewBox={BUST_VIEWBOX}
      preserveAspectRatio="xMidYMid slice"
      width={size}
      height={size}
      className={cn("block flex-none", className)}
      role="img"
      aria-label={persona}
    >
      {/* The bust carries its own card-toned ground so light props still read on the off-white LowerThird plate. */}
      <rect x={BUST.x} y={BUST.y} width={BUST.size} height={BUST.size} fill={CUT} />
      {render({ variant })}
    </svg>
  );
}
