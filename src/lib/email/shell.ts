/**
 * The Broadcast email shell and its primitives.
 *
 * Everything here returns HTML strings built from nested tables with inline
 * styles (the only layout that survives Gmail, Outlook and Apple Mail alike).
 * The vocabulary mirrors the broadcast component kit in
 * `src/components/broadcast/`: masthead + red strip (TopBar), slate
 * (SegmentSlate), headline (bc-display), lower third (LowerThird), stats row
 * (StatBlock), red block quote (bc-prose blockquote) and the flat red button.
 *
 * Light palette values are inlined; the matching dark values are emitted once
 * in a `prefers-color-scheme: dark` block keyed on the `em-*` classes.
 */

import {
  BRAND_RED,
  DARK_PALETTE,
  EMAIL_WIDTH,
  FONT_DISPLAY,
  FONT_TEXT,
  GOOGLE_FONTS_HREF,
  LIGHT_PALETTE,
  MASTHEAD_BG,
  MASTHEAD_RULE,
  MASTHEAD_TEXT,
  WHITE,
} from "./theme";

const L = LIGHT_PALETTE;

/** SendGrid substitutes this with the recipient's group-unsubscribe link on send. */
export const SENDGRID_UNSUBSCRIBE_TAG = "<%asm_group_unsubscribe_raw_url%>";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape, then turn line breaks into `<br>` so multi-line questions keep their shape. */
export function escapeMultiline(value: string): string {
  return escapeHtml(value.trim()).replace(/\r?\n/g, "<br>");
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/* -------------------------------------------------------------------------- */
/* Style fragments                                                            */
/* -------------------------------------------------------------------------- */

const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

function labelStyle(color: string, size = 11): string {
  return `font-family:${FONT_DISPLAY};font-size:${size}px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;line-height:1;color:${color};`;
}

function textStyle(color: string, size = 16, lineHeight = 1.65): string {
  return `font-family:${FONT_TEXT};font-size:${size}px;line-height:${lineHeight};color:${color};`;
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Red plate + muted label, e.g. `REQUEST FOR COMMENT` · `THE SUNDAY SCARIES · WEEK 3`. */
export function slate(code: string, label?: string): string {
  const labelCell = label
    ? `<td class="em-text3" valign="middle" style="padding-left:12px;${labelStyle(L.text3)}">${escapeHtml(label)}</td>`
    : "";
  return `<table ${TABLE}><tr>
<td valign="middle" style="background-color:${BRAND_RED};padding:7px 10px 6px;white-space:nowrap;${labelStyle(WHITE)}">${escapeHtml(code)}</td>
${labelCell}
</tr></table>`;
}

/** The big condensed uppercase headline (bc-display). */
export function headline(text: string, opts: { size?: number } = {}): string {
  const size = opts.size ?? 38;
  return `<h1 class="em-ink em-headline" style="margin:18px 0 22px;font-family:${FONT_DISPLAY};font-size:${size}px;font-weight:800;line-height:0.95;letter-spacing:-0.005em;text-transform:uppercase;color:${L.ink};">${escapeHtml(text)}</h1>`;
}

export interface LowerThirdOptions {
  initials: string;
  name: string;
  role: string;
  /** Left text in the red strip, e.g. "Sideline desk". */
  tag?: string;
  /** Right text in the red strip, e.g. "For Curtis Vaughn's Weekly Recap". */
  note?: string;
}

/** The broadcast byline: red bar + dark plate (initials tile, name, role) + red strip. */
export function lowerThird({ initials, name, role, tag, note }: LowerThirdOptions): string {
  const strip =
    tag || note
      ? `<tr><td colspan="2" style="background-color:${BRAND_RED};padding:9px 16px 8px 20px;${labelStyle(WHITE)}">${
          tag ? `<span>${escapeHtml(tag)}</span>` : ""
        }${tag && note ? `<span style="color:${WHITE};opacity:0.45;padding:0 10px;">|</span>` : ""}${
          note ? `<span style="color:${WHITE};opacity:0.85;letter-spacing:0.1em;font-weight:600;">${escapeHtml(note)}</span>` : ""
        }</td></tr>`
      : "";

  return `<table ${TABLE} width="100%" style="margin:0 0 24px;">
<tr>
<td width="8" style="width:8px;background-color:${BRAND_RED};font-size:0;line-height:0;">&nbsp;</td>
<td class="em-plate" style="background-color:${L.plate};padding:10px 16px;">
<table ${TABLE}><tr>
<td width="48" height="48" align="center" valign="middle" style="width:48px;height:48px;background-color:${BRAND_RED};font-family:${FONT_DISPLAY};font-size:20px;font-weight:800;letter-spacing:0.02em;color:${WHITE};line-height:48px;text-align:center;">${escapeHtml(initials)}</td>
<td valign="middle" style="padding-left:14px;">
<div class="em-plate-fg" style="font-family:${FONT_DISPLAY};font-size:21px;font-weight:800;letter-spacing:0.01em;text-transform:uppercase;line-height:1;color:${L.plateFg};">${escapeHtml(name)}</div>
<div class="em-plate-muted" style="margin-top:6px;${labelStyle(L.plateMuted)}">${escapeHtml(role)}</div>
</td>
</tr></table>
</td>
</tr>
${strip}
</table>`;
}

/** Body copy. Pass pre-escaped HTML (use `escapeHtml` on user data). */
export function paragraph(html: string, opts: { size?: number; last?: boolean } = {}): string {
  return `<p class="em-body" style="margin:0 0 ${opts.last ? 0 : 16}px;${textStyle(L.body, opts.size ?? 16)}">${html}</p>`;
}

/** A small muted kicker above a block, e.g. "Here's what I'm asking". */
export function kicker(text: string): string {
  return `<div class="em-text3" style="margin:4px 0 10px;${labelStyle(L.text3)}">${escapeHtml(text)}</div>`;
}

/** The red block quote from bc-prose: white italic condensed type on brand red. */
export function quoteBlock(text: string): string {
  return `<table ${TABLE} width="100%" style="margin:0 0 24px;"><tr>
<td style="background-color:${BRAND_RED};padding:20px 24px;font-family:${FONT_DISPLAY};font-style:italic;font-weight:700;font-size:21px;line-height:1.2;color:${WHITE};">&ldquo;${escapeMultiline(text)}&rdquo;</td>
</tr></table>`;
}

export interface StatItem {
  label: string;
  value: string;
}

/** A row of StatBlocks between two hairlines. Stacks on narrow screens. */
export function statsRow(items: StatItem[]): string {
  const cells = items
    .map(
      (item, i) =>
        `<td class="em-stat" valign="top" style="padding:14px ${i === items.length - 1 ? 0 : 18}px 14px 0;">
<div class="em-text3" style="${labelStyle(L.text3)}">${escapeHtml(item.label)}</div>
<div class="em-ink" style="margin-top:7px;font-family:${FONT_DISPLAY};font-size:19px;font-weight:700;line-height:1.05;letter-spacing:0.01em;color:${L.ink};">${escapeHtml(item.value)}</div>
</td>`,
    )
    .join("");
  return `<table ${TABLE} width="100%" class="em-hairline" style="margin:0 0 24px;border-top:1px solid ${L.hairline};border-bottom:1px solid ${L.hairline};"><tr>${cells}</tr></table>`;
}

/** The flat red primary action. */
export function button(label: string, href: string): string {
  return `<table ${TABLE} style="margin:4px 0 22px;"><tr>
<td style="background-color:${BRAND_RED};">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:17px 30px 15px;font-family:${FONT_DISPLAY};font-size:16px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;line-height:1;color:${WHITE};text-decoration:none;">${escapeHtml(label)}</a>
</td>
</tr></table>`;
}

/** Small secondary copy under the action. Pass pre-escaped HTML. */
export function finePrint(html: string, opts: { last?: boolean } = {}): string {
  return `<p class="em-text2" style="margin:0 0 ${opts.last ? 0 : 10}px;${textStyle(L.text2, 13, 1.55)}">${html}</p>`;
}

/** A signal-blue callout, e.g. "You're quoted". */
export function callout(label: string, text: string): string {
  return `<table ${TABLE} width="100%" style="margin:0 0 22px;"><tr>
<td width="6" class="em-signal-bg" style="width:6px;background-color:${L.signal};font-size:0;line-height:0;">&nbsp;</td>
<td class="em-panel2 em-hairline" style="background-color:${L.panel2};border:1px solid ${L.hairline};border-left:0;padding:12px 16px;">
<span class="em-signal" style="${labelStyle(L.signal)}">${escapeHtml(label)}</span>
<span class="em-body" style="display:block;margin-top:6px;${textStyle(L.body, 14, 1.5)}">${escapeHtml(text)}</span>
</td>
</tr></table>`;
}

/** A hairline rule. */
export function rule(): string {
  return `<table ${TABLE} width="100%" style="margin:0 0 22px;"><tr><td class="em-hairline" style="border-top:1px solid ${L.hairline};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

export interface ShellOptions {
  /** `<title>`; most clients ignore it, some screen readers read it. */
  title: string;
  /** Hidden inbox preview text. */
  preheader?: string;
  siteUrl: string;
  preferencesUrl: string;
  /** Defaults to SendGrid's group-unsubscribe substitution tag. */
  unsubscribeUrl?: string;
  /** Right-hand masthead label, e.g. "The Sunday Scaries". */
  mastheadLabel?: string;
  /** Why the recipient got this, shown in the footer. */
  reason?: string;
  year?: number;
  /** Inner HTML of the main panel. */
  content: string;
}

function darkRules(prefix: string): string {
  const d = DARK_PALETTE;
  const rules: Array<[string, string[]]> = [
    ["em-ground", [`background-color:${d.ground}`]],
    ["em-panel", [`background-color:${d.panel}`, `border-color:${d.hairline}`]],
    ["em-panel2", [`background-color:${d.panel2}`, `border-color:${d.hairline}`]],
    ["em-hairline", [`border-color:${d.hairline}`]],
    ["em-ink", [`color:${d.ink}`]],
    ["em-body", [`color:${d.body}`]],
    ["em-text2", [`color:${d.text2}`]],
    ["em-text3", [`color:${d.text3}`]],
    ["em-red-text", [`color:${d.redText}`]],
    ["em-signal", [`color:${d.signal}`]],
    ["em-signal-bg", [`background-color:${d.signal}`]],
    ["em-plate", [`background-color:${d.plate}`]],
    ["em-plate-fg", [`color:${d.plateFg}`]],
    ["em-plate-muted", [`color:${d.plateMuted}`]],
  ];
  return rules
    .map(([cls, decls]) => `${prefix}.${cls}{${decls.map((x) => `${x} !important`).join(";")}}`)
    .join("\n");
}

function styles(): string {
  return `<style>
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
body{margin:0 !important;padding:0 !important;width:100% !important;}
a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;}
.em-footer-link:hover{text-decoration:underline !important;}
@media only screen and (max-width:620px){
.em-container{width:100% !important;max-width:100% !important;}
.em-pad{padding-left:20px !important;padding-right:20px !important;}
.em-headline{font-size:31px !important;}
.em-stat{display:block !important;width:100% !important;padding:10px 0 !important;}
.em-hide-sm{display:none !important;}
}
@media (prefers-color-scheme:dark){
${darkRules("")}
}
${darkRules("[data-ogsc] ")}
${darkRules("[data-ogsb] ")}
</style>`;
}

function masthead(siteUrl: string, label?: string): string {
  const right = label
    ? `<td align="right" valign="middle" class="em-hide-sm" style="padding-left:16px;${labelStyle(MASTHEAD_TEXT)}">${escapeHtml(label)}</td>`
    : "";
  return `<table ${TABLE} width="100%" style="background-color:${MASTHEAD_BG};">
<tr><td class="em-pad" style="padding:16px 32px;">
<table ${TABLE} width="100%"><tr>
<td width="66" valign="middle" style="width:66px;"><a href="${escapeHtml(siteUrl)}" style="display:inline-block;"><img src="${escapeHtml(siteUrl)}/email/FFSN.png" width="66" height="44" alt="FFSN" style="display:block;width:66px;height:44px;border:0;"></a></td>
<td valign="middle" style="padding-left:16px;border-left:1px solid ${MASTHEAD_RULE};white-space:nowrap;${labelStyle(MASTHEAD_TEXT)}">Fantasy Football<br><span style="display:inline-block;margin-top:5px;">Sports Network</span></td>
${right}
</tr></table>
</td></tr>
<tr><td height="6" style="height:6px;background-color:${BRAND_RED};font-size:0;line-height:0;">&nbsp;</td></tr>
</table>`;
}

function footer(opts: ShellOptions): string {
  const year = opts.year ?? new Date().getFullYear();
  const unsubscribe = opts.unsubscribeUrl ?? SENDGRID_UNSUBSCRIBE_TAG;
  // SendGrid only substitutes the tag when it appears verbatim, so it must not be escaped.
  const unsubscribeHref = unsubscribe === SENDGRID_UNSUBSCRIBE_TAG ? unsubscribe : escapeHtml(unsubscribe);
  const linkStyle = `display:inline-block;white-space:nowrap;font-family:${FONT_DISPLAY};font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;line-height:1.8;color:${L.text2};text-decoration:none;`;
  const sep = `<span class="em-text3" style="color:${L.text3};padding:0 10px;">&middot;</span>`;
  const links = [
    `<a class="em-footer-link em-text2" href="${escapeHtml(opts.siteUrl)}/dashboard" style="${linkStyle}">Dashboard</a>`,
    `<a class="em-footer-link em-text2" href="${escapeHtml(opts.preferencesUrl)}" style="${linkStyle}">Notification settings</a>`,
    `<a class="em-footer-link em-text2" href="${unsubscribeHref}" style="${linkStyle}">Unsubscribe</a>`,
  ].join(sep);
  const reason = opts.reason
    ? `<div class="em-text3" style="margin-top:14px;${textStyle(L.text3, 12, 1.5)}">${escapeHtml(opts.reason)}</div>`
    : "";

  return `<table ${TABLE} width="100%" class="em-ground" style="background-color:${L.ground};">
<tr><td class="em-pad em-hairline" style="padding:22px 36px 26px;border-top:1px solid ${L.hairline};">
<div style="margin:0 0 14px;">${links}</div>
<div class="em-text3" style="${labelStyle(L.text3)}">&copy; ${year} FFSN &nbsp;&middot;&nbsp; Fantasy Football Sports Network</div>
${reason}
</td></tr>
</table>`;
}

/** Wraps rendered panel content in the full HTML document: masthead, panel, footer. */
export function renderShell(opts: ShellOptions): string {
  const siteUrl = trimTrailingSlash(opts.siteUrl);
  const preheader = opts.preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`
    : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<!--[if !mso]><!--><link href="${GOOGLE_FONTS_HREF}" rel="stylesheet"><style>@import url("${GOOGLE_FONTS_HREF}");</style><!--<![endif]-->
${styles()}
<!--[if mso]><style>td,th,p,a,span,div,h1{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body class="em-ground" style="margin:0;padding:0;background-color:${L.ground};">
${preheader}
<table ${TABLE} width="100%" class="em-ground" style="background-color:${L.ground};">
<tr><td align="center" style="padding:28px 12px 36px;">
<!--[if mso]><table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table ${TABLE} class="em-container" width="${EMAIL_WIDTH}" style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;">
<tr><td>${masthead(siteUrl, opts.mastheadLabel)}</td></tr>
<tr><td class="em-panel" style="background-color:${L.panel};border:1px solid ${L.hairline};border-top:0;">
<table ${TABLE} width="100%"><tr><td class="em-pad" style="padding:30px 36px 34px;">
${opts.content}
</td></tr></table>
</td></tr>
<tr><td>${footer({ ...opts, siteUrl })}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Plain-text helpers                                                         */
/* -------------------------------------------------------------------------- */

export const TEXT_RULE = "------------------------------------------------------------";

/** Joins non-empty blocks with a blank line between them. */
export function textDocument(blocks: Array<string | undefined | null | false>): string {
  return blocks
    .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    .map((b) => b.trim())
    .join("\n\n");
}

export function textFooter(opts: Pick<ShellOptions, "siteUrl" | "preferencesUrl" | "unsubscribeUrl" | "reason" | "year">): string {
  const year = opts.year ?? new Date().getFullYear();
  return textDocument([
    TEXT_RULE,
    opts.reason,
    `Notification settings: ${opts.preferencesUrl}\nUnsubscribe: ${opts.unsubscribeUrl ?? SENDGRID_UNSUBSCRIBE_TAG}`,
    `© ${year} FFSN · Fantasy Football Sports Network · ${trimTrailingSlash(opts.siteUrl)}`,
  ]);
}
