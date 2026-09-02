/**
 * Email design tokens for the Broadcast look.
 *
 * Email clients cannot read CSS custom properties, so the `--bc-*` values from
 * `src/app/globals.css` are duplicated here as literals. The light palette is
 * inlined on every element (the base rendering); the dark palette is applied
 * through a `prefers-color-scheme: dark` block for clients that honor it
 * (Apple Mail, iOS Mail, Outlook.com via `[data-ogsc]`).
 *
 * Keep this file in sync with globals.css when the tokens change.
 */

export interface EmailPalette {
  ground: string;
  panel: string;
  panel2: string;
  hairline: string;
  borderStrong: string;
  ink: string;
  body: string;
  text2: string;
  text3: string;
  red: string;
  redText: string;
  redDeep: string;
  signal: string;
  win: string;
  plate: string;
  plateFg: string;
  /** Muted text on the name plate (~60% plate-fg over plate), pre-blended for email. */
  plateMuted: string;
}

export const LIGHT_PALETTE: EmailPalette = {
  ground: "#F4F0EC",
  panel: "#FBF9F7",
  panel2: "#FFFFFF",
  hairline: "#DCD5CF",
  borderStrong: "#C4BBB4",
  ink: "#0E0C0C",
  body: "#2A2523",
  text2: "#5E5651",
  text3: "#857C76",
  red: "#C91618",
  redText: "#B3121A",
  redDeep: "#8F1012",
  signal: "#0B7F9C",
  win: "#1E8E5A",
  plate: "#0E0C0C",
  plateFg: "#F4F0EC",
  plateMuted: "#989592",
};

export const DARK_PALETTE: EmailPalette = {
  ground: "#0E0C0C",
  panel: "#141111",
  panel2: "#1B1717",
  hairline: "#2C2727",
  borderStrong: "#3B3535",
  ink: "#F4F0EC",
  body: "#E4DED8",
  text2: "#B9B0AA",
  text3: "#7D746F",
  red: "#C91618",
  redText: "#FF4A4C",
  redDeep: "#8F1012",
  signal: "#5AD1EC",
  win: "#4BD08A",
  plate: "#F4F0EC",
  plateFg: "#0E0C0C",
  plateMuted: "#6A6766",
};

/** Brand red is identical in both themes; masthead is always the dark studio plate. */
export const BRAND_RED = "#C91618";
export const MASTHEAD_BG = "#0E0C0C";
export const MASTHEAD_TEXT = "#B9B0AA";
export const MASTHEAD_RULE = "#2C2727";
export const WHITE = "#FFFFFF";

/** Barlow Condensed (display) and Archivo (text), matching `--font-display` / `--font-sans`. */
export const FONT_DISPLAY =
  "'Barlow Condensed','Arial Narrow','Roboto Condensed','Helvetica Neue',Helvetica,Arial,sans-serif";
export const FONT_TEXT = "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif";

export const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Barlow+Condensed:ital,wght@0,700;0,800;1,700&display=swap";

export const EMAIL_WIDTH = 600;
