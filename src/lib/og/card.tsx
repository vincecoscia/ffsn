/**
 * Link-preview cards in the Broadcast look (owner ask, 2026-09-05: the iMessage preview was the
 * old logo on a pink card). Rendered by `next/og`'s ImageResponse (satori), which draws a
 * flexbox subset of CSS, so everything here is explicit: absolute colors from the Broadcast
 * palette (src/app/globals.css `--bc-*`, dark house look), Barlow Condensed for display,
 * Archivo for body, no Tailwind.
 *
 * Two cards share one frame: the site card (root opengraph-image) and the article card
 * (articles/[id]/opengraph-image), which puts the headline, league, week and byline on the
 * same plate and, when the story has banner art, dims it behind the type.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CSSProperties, ReactElement } from "react";

export const CARD_SIZE = { width: 1200, height: 630 } as const;

// Broadcast palette, dark house look.
const INK = "#F4F0EC";
const BODY = "#E4DED8";
const TEXT_2 = "#B9B0AA";
const TEXT_3 = "#7D746F";
const GROUND = "#0E0C0C";
const PANEL = "#141111";
const HAIRLINE = "#2C2727";
const RED = "#C91618";
const RED_DEEP = "#8F1012";
const SIGNAL = "#5AD1EC";

const DISPLAY = "Barlow Condensed";
const TEXT = "Archivo";

/** The on-air roster, in desk order; the ticker on the site card. */
export const ROSTER_TICKER = [
  "Curtis Vaughn",
  "Sam Ortega",
  "Nina Sharpe",
  "Dex Alvarez",
  "Mel Diaper",
  "Reggie Banks",
  "Walt Brennan",
];

export interface CardFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600 | 700;
  style: "normal";
}

let fontsPromise: Promise<CardFont[]> | undefined;
let logoPromise: Promise<string> | undefined;

/**
 * The FFSN mark (the real artwork, footballs and all) as a data URL, read once per process.
 * `src/app/og-assets/ffsn-logo.png` is public/FFSN.png with its white background knocked
 * out so it sits on the dark plate.
 */
export function loadLogoDataUrl(): Promise<string> {
  logoPromise ??= readFile(join(process.cwd(), "src/app/og-assets/ffsn-logo.png")).then(
    (buffer) => `data:image/png;base64,${buffer.toString("base64")}`
  );
  return logoPromise;
}

/** The four faces the cards set in, read once per process from src/app/og-fonts. */
export function loadCardFonts(): Promise<CardFont[]> {
  fontsPromise ??= (async () => {
    const dir = join(process.cwd(), "src/app/og-fonts");
    const read = async (file: string): Promise<ArrayBuffer> => {
      const buffer = await readFile(join(dir, file));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    };
    return [
      { name: DISPLAY, data: await read("BarlowCondensed-Bold.ttf"), weight: 700, style: "normal" },
      { name: DISPLAY, data: await read("BarlowCondensed-SemiBold.ttf"), weight: 600, style: "normal" },
      { name: TEXT, data: await read("Archivo-Regular.ttf"), weight: 400, style: "normal" },
      { name: TEXT, data: await read("Archivo-SemiBold.ttf"), weight: 600, style: "normal" },
    ];
  })();
  return fontsPromise;
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

const eyebrow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontFamily: DISPLAY,
  fontWeight: 600,
  fontSize: 24,
  letterSpacing: 3.5,
  textTransform: "uppercase",
  color: SIGNAL,
};

/** src/app/og-assets/ffsn-logo.png is 840x482; the box keeps that ratio so no renderer has to crop or stretch it. */
const LOGO_ASPECT = 482 / 840;

/** The real FFSN mark. `width` in px. */
function Logo({ src, width }: { src: string; width: number }): ReactElement {
  const height = Math.round(width * LOGO_ASPECT);
  return (
    <img
      src={src}
      width={width}
      height={height}
      alt="FFSN"
      style={{ width, height, objectFit: "contain" }}
    />
  );
}

/** The FFSN badge set in type; the fallback when the artwork cannot be read. */
function Badge({ scale = 1 }: { scale?: number }): ReactElement {
  const width = 300 * scale;
  const height = 150 * scale;
  return (
    <div
      style={{
        display: "flex",
        width,
        height,
        transform: "skewX(-8deg)",
        backgroundColor: RED,
        borderRadius: 6 * scale,
        boxShadow: `0 ${18 * scale}px ${40 * scale}px rgba(201,22,24,0.35)`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          width: width - 22 * scale,
          height: height - 22 * scale,
          border: `${3 * scale}px solid ${INK}`,
          borderRadius: 4 * scale,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 112 * scale,
            lineHeight: 1,
            letterSpacing: 2 * scale,
            color: INK,
            transform: "skewX(8deg)",
            marginTop: -6 * scale,
          }}
        >
          FFSN
        </span>
      </div>
    </div>
  );
}

/** The lower third: red plate with the domain, then the ticker. */
function LowerThird({ ticker }: { ticker: string[] }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 68,
        borderTop: `1px solid ${HAIRLINE}`,
        backgroundColor: PANEL,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 34px",
          backgroundColor: RED,
          color: INK,
          fontFamily: DISPLAY,
          fontWeight: 700,
          fontSize: 30,
          letterSpacing: 1,
        }}
      >
        ffsn.ai
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexGrow: 1,
          overflow: "hidden",
          padding: "0 28px",
          fontFamily: DISPLAY,
          fontWeight: 600,
          fontSize: 20,
          letterSpacing: 2.4,
          textTransform: "uppercase",
          color: TEXT_3,
          whiteSpace: "nowrap",
          position: "relative",
        }}
      >
        {ticker.join("  ·  ")}
        {/* A ticker runs off the edge on purpose; fade it rather than chop a name. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 120,
            height: 68,
            backgroundImage: `linear-gradient(90deg, rgba(20,17,17,0) 0%, ${PANEL} 85%)`,
          }}
        />
      </div>
    </div>
  );
}

function Frame({ children, background }: { children: ReactElement | ReactElement[]; background?: string }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: CARD_SIZE.width,
        height: CARD_SIZE.height,
        backgroundColor: GROUND,
        color: INK,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {background ? (
        <img
          src={background}
          width={CARD_SIZE.width}
          height={CARD_SIZE.height}
          alt=""
          style={{ position: "absolute", top: 0, left: 0, width: CARD_SIZE.width, height: CARD_SIZE.height, objectFit: "cover", opacity: 0.55 }}
        />
      ) : null}
      {/* Studio light: a red wash from the top right, a dark floor toward the type. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: CARD_SIZE.width,
          height: CARD_SIZE.height,
          backgroundImage: background
            ? `linear-gradient(90deg, rgba(14,12,12,0.96) 0%, rgba(14,12,12,0.88) 55%, rgba(14,12,12,0.45) 100%)`
            : `radial-gradient(circle at 92% 8%, rgba(201,22,24,0.32) 0%, rgba(201,22,24,0) 42%)`,
        }}
      />
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

export function SiteCard({ logo }: { logo?: string }): ReactElement {
  return (
    <Frame>
      <div style={{ display: "flex", flexGrow: 1, alignItems: "center", padding: "0 56px 0 40px", gap: 40 }}>
        <div style={{ display: "flex", flexShrink: 0 }}>
          {logo ? <Logo src={logo} width={420} /> : <div style={{ display: "flex", transform: "rotate(-4deg)" }}><Badge scale={1.15} /></div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, width: 660, flexShrink: 0 }}>
          <div style={eyebrow}>
            <span style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: RED, marginRight: 14 }} />
            On air · Fantasy Football Sports Network
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: DISPLAY,
              fontWeight: 700,
              fontSize: 70,
              lineHeight: 0.98,
              letterSpacing: -0.5,
              textTransform: "uppercase",
              color: INK,
              width: 660,
            }}
          >
            The sports network that only covers your league.
          </div>
          <div style={{ display: "flex", fontFamily: TEXT, fontWeight: 400, fontSize: 23, lineHeight: 1.4, color: TEXT_2, width: 640 }}>
            Seven AI sportswriters. Recaps, power rankings, waiver reports and on-the-record interviews, written from your league&apos;s own numbers every week.
          </div>
        </div>
      </div>
      <LowerThird ticker={ROSTER_TICKER} />
    </Frame>
  );
}

export interface ArticleCardProps {
  title: string;
  leagueName: string;
  /** e.g. "Weekly Recap" */
  storyLabel: string;
  week?: number;
  writerName: string;
  writerRole: string;
  /** Absolute URL of the story's banner art, dimmed behind the headline when present. */
  bannerUrl?: string;
  /** The mark as a data URL (`loadLogoDataUrl`); the typed badge stands in without it. */
  logo?: string;
}

function headlineSize(title: string): number {
  const length = title.length;
  if (length <= 34) return 86;
  if (length <= 60) return 72;
  if (length <= 90) return 60;
  return 50;
}

export function ArticleCard(props: ArticleCardProps): ReactElement {
  const kicker = [props.leagueName, props.week ? `Week ${props.week}` : null, props.storyLabel].filter(Boolean).join("   ·   ");
  return (
    <Frame background={props.bannerUrl}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, padding: "56px 72px 0", gap: 22 }}>
        {/* The kicker alone up top: a messaging app's rounded corner mask (large on iOS) shaved the
            mark when it sat in the top-right corner (owner, 2026-09-06). Nothing lives in a corner now. */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={eyebrow}>
            <span style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: RED, marginRight: 14 }} />
            <span style={{ display: "flex", maxWidth: 1000, overflow: "hidden", whiteSpace: "nowrap" }}>{kicker}</span>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: headlineSize(props.title),
            lineHeight: 1.0,
            letterSpacing: -0.5,
            color: INK,
            maxWidth: 1000,
            lineClamp: 3,
            textWrap: "balance",
          }}
        >
          {props.title}
        </div>
        {/* The byline row: writer left, the mark right - the network bug where a broadcast puts it,
            mid-height on the right edge and well clear of every corner. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto", marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", width: 6, height: 44, backgroundColor: RED_DEEP }} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 30, letterSpacing: 1, textTransform: "uppercase", color: BODY }}>
                {props.writerName}
              </span>
              <span style={{ fontFamily: TEXT, fontWeight: 400, fontSize: 20, color: TEXT_2 }}>{props.writerRole}</span>
            </div>
          </div>
          <div style={{ display: "flex", flexShrink: 0 }}>
            {props.logo ? <Logo src={props.logo} width={176} /> : <div style={{ display: "flex", transform: "rotate(-4deg)" }}><Badge scale={0.44} /></div>}
          </div>
        </div>
      </div>
      <LowerThird ticker={["The sports network that only covers your league", ...ROSTER_TICKER]} />
    </Frame>
  );
}
