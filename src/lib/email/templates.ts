/**
 * FFSN transactional email templates, rendered in code so they share the
 * Broadcast design system and the writer roster with the app.
 *
 * Every renderer is a pure function: data in, `{ subject, html, text }` out.
 * Nothing here touches Convex or SendGrid; `convex/emailService.ts` calls
 * `renderLocalTemplate` at send time for any queued email whose template id
 * starts with `ffsn:`.
 */

import { DIGEST_MAX_HEADLINES, DIGEST_MAX_YOUR_TEAM, type WireDigestData, type WireDigestLeague } from "../ai/wire/types";
import { firstName, personaInitials, shortName, writerDisplay, type EmailPersona } from "./labels";
import {
  button,
  callout,
  escapeHtml,
  finePrint,
  headline,
  kicker,
  lowerThird,
  paragraph,
  quoteBlock,
  renderShell,
  rule,
  slate,
  statsRow,
  textDocument,
  textFooter,
  trimTrailingSlash,
  TEXT_RULE,
} from "./shell";
import { FONT_DISPLAY, FONT_TEXT, LIGHT_PALETTE } from "./theme";

export type { EmailPersona } from "./labels";

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** Display name for the From header; the address is always the verified sender. */
  fromName: string;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export const DEFAULT_TIME_ZONE = "America/New_York";

/** "Thu, Sep 3, 8:00 PM EDT" in the recipient's zone (falls back to Eastern, then UTC). */
export function formatDeadline(timestamp: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const date = new Date(timestamp);
  for (const zone of [timeZone, DEFAULT_TIME_ZONE, "UTC"]) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
    } catch {
      // invalid zone id; try the next one
    }
  }
  return date.toUTCString();
}

/** 30 -> "30 minutes", 90 -> "1 hour 30 minutes", 1440 -> "1 day". */
export function humanizeMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (hours < 24) {
    const h = `${hours} hour${hours === 1 ? "" : "s"}`;
    return rest ? `${h} ${rest} minute${rest === 1 ? "" : "s"}` : h;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function leagueLine(leagueName: string, week?: number): string {
  return typeof week === "number" ? `${leagueName} · Week ${week}` : leagueName;
}

function greeting(recipientName?: string): string {
  const first = firstName(recipientName);
  return first ? `Hi ${first}.` : "Hello.";
}

/** A small square team logo, shown above the invite copy when the team has one. */
function logoBlock(url: string, alt: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;"><tr>
<td><img src="${escapeHtml(url)}" width="64" height="64" alt="${escapeHtml(alt)}" style="display:block;width:64px;height:64px;border-radius:4px;object-fit:cover;"></td>
</tr></table>`;
}

/* -------------------------------------------------------------------------- */
/* Comment request (and its reminders) from the sideline desk                 */
/* -------------------------------------------------------------------------- */

export type CommentRequestVariant = "request" | "reminder" | "final_reminder";

export interface CommentRequestEmailData {
  variant?: CommentRequestVariant;
  recipientName?: string;
  leagueName: string;
  /** Display name of the story type, e.g. "Weekly Recap" (see `contentTypeLabel`). */
  contentTypeLabel: string;
  week?: number;
  /** The opener the interviewer is asking, shown verbatim. */
  question?: string;
  /** The writer whose story the quotes are for. */
  writer: EmailPersona;
  /** The sideline reporter conducting the interview (always Sam Ortega). */
  interviewer: EmailPersona;
  /** When the window closes (article generation time), ms since epoch. */
  deadline?: number;
  /** For reminders: minutes left in the window. Takes precedence over `deadline` in copy. */
  minutesRemaining?: number;
  /** IANA zone for formatting `deadline`; defaults to Eastern. */
  timeZone?: string;
  commentRequestUrl: string;
  preferencesUrl: string;
  siteUrl: string;
}

function windowPhrase(data: CommentRequestEmailData): string {
  if (typeof data.minutesRemaining === "number") return `in ${humanizeMinutes(data.minutesRemaining)}`;
  if (typeof data.deadline === "number") return `at ${formatDeadline(data.deadline, data.timeZone)}`;
  return "soon";
}

function windowValue(data: CommentRequestEmailData): string {
  if (typeof data.deadline === "number") return formatDeadline(data.deadline, data.timeZone);
  if (typeof data.minutesRemaining === "number") return `In ${humanizeMinutes(data.minutesRemaining)}`;
  return "Soon";
}

export function renderCommentRequestEmail(data: CommentRequestEmailData): RenderedEmail {
  const variant = data.variant ?? "request";
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const sam = shortName(data.interviewer.name);
  const writer = data.writer;
  const story = data.contentTypeLabel;
  const league = leagueLine(data.leagueName, data.week);
  const closes = windowPhrase(data);

  const copy = {
    request: {
      subject: `${sam} wants you on the record · ${league}`,
      slate: "Request for comment",
      headline: "I'd like to get you on the record.",
      body: `${greeting(data.recipientName)} ${writer.name} (${writer.role}) is writing the ${story} for ${data.leagueName}${
        typeof data.week === "number" ? `, Week ${data.week}` : ""
      }, and your team is part of the story. I have one question for you, maybe a follow-up, and I close the window on time.`,
      questionKicker: "Here's what I'm asking",
      cta: "Go on the record",
    },
    reminder: {
      subject: `Still hoping to get you on the record · ${league}`,
      slate: "Reminder",
      headline: "Still hoping to get you on the record.",
      body: `${greeting(data.recipientName)} The window for ${writer.name}'s ${story} closes ${closes}. One answer is enough; the follow-up is optional.`,
      questionKicker: "Still on the table",
      cta: "Answer now",
    },
    final_reminder: {
      subject: `Last call from the sideline · ${league}`,
      slate: "Final call",
      headline: "Last call from the sideline.",
      body: `${greeting(data.recipientName)} This is the last note I'll send. The window for ${writer.name}'s ${story} closes ${closes}. After that, the story runs with a line that you did not respond to a request for comment.`,
      questionKicker: "Still on the table",
      cta: "Answer before it closes",
    },
  }[variant];

  const preheader =
    variant === "request"
      ? `${writer.name} is writing the ${story}. One question, maybe a follow-up. Window closes ${closes}.`
      : `${writer.name}'s ${story} closes ${closes}.`;

  const onTheRecord =
    "Everything you say in the conversation is on the record and may be quoted word for word in the story. Prefer to sit this one out? Open the request and choose No comment; nothing gets attributed to you.";
  const noReply =
    variant === "request"
      ? "If the window closes without a reply, the story runs with a line that you did not respond to a request for comment."
      : undefined;

  const content = [
    slate(copy.slate, league),
    headline(copy.headline),
    lowerThird({
      initials: personaInitials(data.interviewer.name),
      name: data.interviewer.name,
      role: data.interviewer.role,
      tag: "Sideline desk",
      note: `For ${writer.name}'s ${story}`,
    }),
    paragraph(escapeHtml(copy.body)),
    data.question ? kicker(copy.questionKicker) + quoteBlock(data.question) : "",
    statsRow([
      { label: "Story", value: story },
      { label: "Writer", value: writer.name },
      { label: "Window closes", value: windowValue(data) },
    ]),
    button(copy.cta, data.commentRequestUrl),
    finePrint(escapeHtml(onTheRecord), { last: !noReply }),
    noReply ? finePrint(escapeHtml(noReply), { last: true }) : "",
  ].join("\n");

  const reason = `You're getting this because you manage a team in ${data.leagueName} on FFSN.`;

  const html = renderShell({
    title: copy.subject,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    mastheadLabel: data.leagueName,
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · ${copy.slate.toUpperCase()} · ${league.toUpperCase()}`,
    copy.headline,
    `${data.interviewer.name}, ${data.interviewer.role}\nFor ${writer.name}'s ${story}`,
    copy.body,
    data.question ? `${copy.questionKicker}:\n"${data.question.trim()}"` : undefined,
    `Story: ${story}\nWriter: ${writer.name}, ${writer.role}\nWindow closes: ${windowValue(data)}`,
    `${copy.cta}: ${data.commentRequestUrl}`,
    onTheRecord,
    noReply,
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl, reason }),
  ]);

  return { subject: copy.subject, preheader, html, text, fromName: `${sam} · FFSN` };
}

/* -------------------------------------------------------------------------- */
/* Article published                                                          */
/* -------------------------------------------------------------------------- */

export interface ArticlePublishedEmailData {
  title: string;
  summary: string;
  articleUrl: string;
  leagueName: string;
  contentTypeLabel: string;
  week?: number;
  writer: EmailPersona;
  recipientName?: string;
  /** True when the recipient's own quotes made it into the story. */
  quoted?: boolean;
  preferencesUrl: string;
  siteUrl: string;
}

export function renderArticlePublishedEmail(data: ArticlePublishedEmailData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const league = leagueLine(data.leagueName, data.week);
  const subject = data.quoted ? `You're quoted · ${data.title}` : `${data.writer.name} · ${data.title}`;
  const summary = data.summary.trim();
  const preheader = summary.length > 140 ? `${summary.slice(0, 137).trimEnd()}…` : summary;

  const content = [
    slate("New on FFSN", league),
    headline(data.title),
    lowerThird({
      initials: personaInitials(data.writer.name),
      name: data.writer.name,
      role: data.writer.role,
      tag: data.contentTypeLabel,
      note: typeof data.week === "number" ? `Week ${data.week}` : data.leagueName,
    }),
    data.quoted
      ? callout("You're quoted", "Your words are in this story, on the record, exactly as you said them.")
      : "",
    summary ? paragraph(escapeHtml(summary)) : "",
    button("Read the story", data.articleUrl),
    finePrint(escapeHtml("Reactions are open on the story page."), { last: true }),
  ].join("\n");

  const reason = `You're getting this because you're a member of ${data.leagueName} on FFSN.`;

  const html = renderShell({
    title: subject,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    mastheadLabel: data.leagueName,
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · NEW ON FFSN · ${league.toUpperCase()}`,
    data.title,
    `${data.writer.name}, ${data.writer.role}\n${data.contentTypeLabel}${typeof data.week === "number" ? ` · Week ${data.week}` : ""}`,
    data.quoted ? "You're quoted: your words are in this story, on the record, exactly as you said them." : undefined,
    summary,
    `Read the story: ${data.articleUrl}`,
    "Reactions are open on the story page.",
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl, reason }),
  ]);

  return { subject, preheader, html, text, fromName: "FFSN" };
}

/* -------------------------------------------------------------------------- */
/* Team invitation                                                            */
/* -------------------------------------------------------------------------- */

export interface TeamInvitationEmailData {
  leagueName: string;
  teamName: string;
  teamAbbreviation?: string;
  teamLogo?: string;
  /** Commissioner's display name, when known. The invite still works without it. */
  invitedByName?: string;
  inviteUrl: string;
  /** ms since epoch - when the invite link stops working. */
  expiresAt: number;
  preferencesUrl: string;
  siteUrl: string;
}

export function renderTeamInvitationEmail(data: TeamInvitationEmailData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const subject = `You're invited to claim ${data.teamName} in ${data.leagueName} on FFSN`;
  const expires = formatDeadline(data.expiresAt);
  const invitedBy = data.invitedByName
    ? `${data.invitedByName}, the commissioner of ${data.leagueName},`
    : `The commissioner of ${data.leagueName}`;
  const body = `${invitedBy} invited you to take over ${data.teamName}. Claim it to start managing your roster, get the weekly recaps, and step into the stories FFSN writes about your league.`;
  const preheader = `${invitedBy} invited you to run ${data.teamName}. This link expires ${expires}.`;

  const content = [
    slate("You're invited", data.leagueName),
    headline(`Claim ${data.teamName}`),
    data.teamLogo ? logoBlock(data.teamLogo, data.teamName) : "",
    paragraph(escapeHtml(body)),
    statsRow([
      { label: "League", value: data.leagueName },
      { label: "Team", value: data.teamAbbreviation ? `${data.teamName} (${data.teamAbbreviation})` : data.teamName },
      { label: "Expires", value: expires },
    ]),
    button("Claim your team", data.inviteUrl),
    finePrint(escapeHtml(`This link expires ${expires}.`)),
    finePrint(`If the button doesn't work, paste this link into your browser: ${escapeHtml(data.inviteUrl)}`, { last: true }),
  ].join("\n");

  const reason = `You're getting this because ${data.invitedByName ?? "a commissioner"} invited you to a team in ${data.leagueName} on FFSN.`;

  const html = renderShell({
    title: subject,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    mastheadLabel: data.leagueName,
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · YOU'RE INVITED · ${data.leagueName.toUpperCase()}`,
    `Claim ${data.teamName}`,
    body,
    `League: ${data.leagueName}\nTeam: ${data.teamName}${data.teamAbbreviation ? ` (${data.teamAbbreviation})` : ""}\nExpires: ${expires}`,
    `Claim your team: ${data.inviteUrl}`,
    `This link expires ${expires}.`,
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl, reason }),
  ]);

  return { subject, preheader, html, text, fromName: "FFSN" };
}

/* -------------------------------------------------------------------------- */
/* ESPN connection lifecycle (broken / expiring / restored)                   */
/*                                                                             */
/* Commissioner-only, private leagues only. `espn_connection_broken` fires    */
/* the moment ESPN starts rejecting the stored cookies (and again every few   */
/* days while it stays broken); `espn_connection_expiring` fires up to 14     */
/* days ahead of a commissioner-entered expiry date; `espn_connection_        */
/* restored` fires once the connection works again. See                      */
/* convex/espnCredentialLifecycle.ts for the triggers.                       */
/* -------------------------------------------------------------------------- */

/** How to find a fresh espn_s2/SWID pair, shared by the broken and expiring emails. */
const ESPN_COOKIE_STEPS = [
  "Open your league on ESPN.com and make sure you're signed in.",
  "Right-click anywhere on the page and choose Inspect (or press F12), then open the Application tab (Storage in Firefox).",
  "Under Cookies, click fantasy.espn.com.",
  "Copy the values for espn_s2 and SWID — SWID includes the curly braces.",
  "In FFSN, open League Settings → ESPN Connection and paste both in.",
];

function stepsHtml(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join("<br>");
}

function stepsText(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

export interface EspnConnectionBrokenEmailData {
  leagueName: string;
  /** What ESPN said when it rejected the stored cookies (`credentialError`), shown verbatim if present. */
  errorDetail?: string;
  /** Stories currently on hold until the connection is fixed. */
  waitingCount: number;
  /** True for the cron's follow-up resend (every few days); false for the first notice. */
  isReminder?: boolean;
  fixUrl: string;
  preferencesUrl: string;
  siteUrl: string;
}

export function renderEspnConnectionBrokenEmail(data: EspnConnectionBrokenEmailData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const subject = data.isReminder
    ? `Still can't reach your ESPN league — ${data.leagueName}`
    : "Action needed: FFSN can't reach your ESPN league";
  const headlineText = data.isReminder
    ? "Still can't reach your ESPN league."
    : "FFSN can't reach your ESPN league.";
  const waitingLine =
    data.waitingCount > 0
      ? `${data.waitingCount} ${data.waitingCount === 1 ? "story is" : "stories are"} on hold until it's fixed.`
      : "New stories are on hold until it's fixed.";
  const body = `ESPN stopped accepting the login connected to ${data.leagueName}. Until you reconnect, FFSN can't pull scores, rosters, or matchups. ${waitingLine}`;
  const preheader = data.isReminder
    ? `Still waiting on a fix for ${data.leagueName}. ${waitingLine}`
    : `ESPN rejected the login for ${data.leagueName}. ${waitingLine}`;

  const content = [
    slate(data.isReminder ? "Still needs attention" : "Action needed", data.leagueName),
    headline(headlineText),
    paragraph(escapeHtml(body)),
    statsRow([
      { label: "Stories on hold", value: String(data.waitingCount) },
      { label: "What ESPN said", value: data.errorDetail?.trim() || "Login rejected" },
    ]),
    button("Fix the connection", data.fixUrl),
    kicker("How to find your ESPN cookies"),
    paragraph(stepsHtml(ESPN_COOKIE_STEPS), { size: 14 }),
    finePrint(`If the button doesn't work, paste this link into your browser: ${escapeHtml(data.fixUrl)}`, { last: true }),
  ].join("\n");

  const reason = `You're getting this because you're the commissioner of ${data.leagueName} on FFSN.`;

  const html = renderShell({
    title: subject,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    mastheadLabel: data.leagueName,
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · ${(data.isReminder ? "STILL NEEDS ATTENTION" : "ACTION NEEDED")} · ${data.leagueName.toUpperCase()}`,
    headlineText,
    body,
    `Stories on hold: ${data.waitingCount}\nWhat ESPN said: ${data.errorDetail?.trim() || "Login rejected"}`,
    `Fix the connection: ${data.fixUrl}`,
    `How to find your ESPN cookies:\n${stepsText(ESPN_COOKIE_STEPS)}`,
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl, reason }),
  ]);

  return { subject, preheader, html, text, fromName: "FFSN" };
}

export interface EspnConnectionExpiringEmailData {
  leagueName: string;
  /** Days left until the commissioner-entered expiry, already rounded (minimum 1). */
  daysLeft: number;
  fixUrl: string;
  preferencesUrl: string;
  siteUrl: string;
}

export function renderEspnConnectionExpiringEmail(data: EspnConnectionExpiringEmailData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const days = Math.max(1, Math.round(data.daysLeft));
  const dayWord = days === 1 ? "day" : "days";
  const subject = `Your ESPN login for FFSN expires in ${days} ${dayWord}`;
  const body = `The ESPN login connected to ${data.leagueName} is set to expire in ${days} ${dayWord}. When it does, FFSN will stop being able to pull scores, rosters, and matchups until you reconnect.`;
  const preheader = `${data.leagueName}'s ESPN login expires in ${days} ${dayWord}. Reconnect before it lapses.`;

  const content = [
    slate("Expiring soon", data.leagueName),
    headline(`Your ESPN login expires in ${days} ${dayWord}.`),
    paragraph(escapeHtml(body)),
    button("Reconnect now", data.fixUrl),
    kicker("How to find fresh ESPN cookies"),
    paragraph(stepsHtml(ESPN_COOKIE_STEPS), { size: 14 }),
    finePrint(`If the button doesn't work, paste this link into your browser: ${escapeHtml(data.fixUrl)}`, { last: true }),
  ].join("\n");

  const reason = `You're getting this because you're the commissioner of ${data.leagueName} on FFSN.`;

  const html = renderShell({
    title: subject,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    mastheadLabel: data.leagueName,
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · EXPIRING SOON · ${data.leagueName.toUpperCase()}`,
    `Your ESPN login expires in ${days} ${dayWord}.`,
    body,
    `Reconnect now: ${data.fixUrl}`,
    `How to find fresh ESPN cookies:\n${stepsText(ESPN_COOKIE_STEPS)}`,
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl, reason }),
  ]);

  return { subject, preheader, html, text, fromName: "FFSN" };
}

export interface EspnConnectionRestoredEmailData {
  leagueName: string;
  /** Backlogged stories now back in the generation queue. */
  resumedCount: number;
  /** Of those, how many are old enough to generate without opening a comment window. */
  withoutInterviewsCount: number;
  leagueUrl: string;
  preferencesUrl: string;
  siteUrl: string;
}

export function renderEspnConnectionRestoredEmail(data: EspnConnectionRestoredEmailData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const subject = "FFSN is back on your league";
  const body = `The ESPN connection for ${data.leagueName} is working again. FFSN picked up right where it left off.`;
  const preheader = `${data.leagueName}'s ESPN connection is fixed. FFSN is syncing again.`;

  const content = [
    slate("Back on the air", data.leagueName),
    headline("FFSN is back on your league."),
    paragraph(escapeHtml(body)),
    statsRow([
      { label: "Stories resuming", value: String(data.resumedCount) },
      { label: "Skipping interviews", value: String(data.withoutInterviewsCount) },
    ]),
    button("Open your league", data.leagueUrl),
    finePrint(`If the button doesn't work, paste this link into your browser: ${escapeHtml(data.leagueUrl)}`, { last: true }),
  ].join("\n");

  const reason = `You're getting this because you're the commissioner of ${data.leagueName} on FFSN.`;

  const html = renderShell({
    title: subject,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    mastheadLabel: data.leagueName,
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · BACK ON THE AIR · ${data.leagueName.toUpperCase()}`,
    "FFSN is back on your league.",
    body,
    `Stories resuming: ${data.resumedCount}\nSkipping interviews (stale): ${data.withoutInterviewsCount}`,
    `Open your league: ${data.leagueUrl}`,
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl, reason }),
  ]);

  return { subject, preheader, html, text, fromName: "FFSN" };
}

/* -------------------------------------------------------------------------- */
/* The Wire — Sunday digest (spec §19.3)                                      */
/*                                                                             */
/* One email per opted-in manager, Monday 04:00 UTC in season: per league,    */
/* the owner overlays about their team, the wire_alert notifications, Sam's   */
/* unanswered questions and the top global headlines from the last 24 h. The  */
/* Convex sender (convex/wireDigest*) decides who gets one and skips anyone   */
/* with nothing to say; this renders whatever it is handed.                    */
/* -------------------------------------------------------------------------- */

/** "Sun 4:12 PM EDT" in the recipient's zone (falls back to Eastern, then UTC). */
export function formatWireTime(timestamp: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const date = new Date(timestamp);
  for (const zone of [timeZone, DEFAULT_TIME_ZONE, "UTC"]) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
    } catch {
      // invalid zone id; try the next one
    }
  }
  return date.toUTCString();
}

/** "Sunday, Sep 13" — the night the digest covers, from the end of its window. */
function digestDateLabel(windowEnd: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  // The window closes at midnight Eastern; a minute earlier is still the Sunday it reports on.
  const date = new Date(windowEnd - 60 * 1000);
  for (const zone of [timeZone, DEFAULT_TIME_ZONE, "UTC"]) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "short", day: "numeric" }).format(date);
    } catch {
      // invalid zone id; try the next one
    }
  }
  return date.toUTCString();
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The byline on a digest item: the writer's short name, or "The Wire" for a desk post with none. */
function wireByline(persona: string | undefined): string {
  return persona && persona.trim().length > 0 ? shortName(writerDisplay(persona).name) : "The Wire";
}

interface DigestItem {
  label: string;
  time: string;
  text: string;
}

/** A hairline-separated list: label · time above, the post text below. Everything escaped here. */
function digestItems(items: DigestItem[]): string {
  const L = LIGHT_PALETTE;
  const rows = items
    .map(
      (item) => `<tr><td class="em-hairline" style="padding:10px 0 12px;border-top:1px solid ${L.hairline};">
<div class="em-text3" style="font-family:${FONT_DISPLAY};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;line-height:1;color:${L.text3};">${escapeHtml(item.label)}<span style="padding:0 8px;">&middot;</span>${escapeHtml(item.time)}</div>
<div class="em-body" style="margin-top:6px;font-family:${FONT_TEXT};font-size:15px;line-height:1.55;color:${L.body};">${escapeHtml(item.text)}</div>
</td></tr>`,
    )
    .join("\n");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px;">
${rows}
</table>`;
}

function digestTextItems(items: DigestItem[]): string {
  return items.map((item) => `- ${item.label} (${item.time}): ${item.text.trim()}`).join("\n");
}

/** The digest's view of one league: the capped lists, with times already formatted. */
function digestLeagueView(league: WireDigestLeague, timeZone?: string) {
  const time = (at: number) => formatWireTime(at, timeZone);
  return {
    yourTeam: league.yourTeam.slice(0, DIGEST_MAX_YOUR_TEAM).map((item) => ({ label: wireByline(item.persona), time: time(item.createdAt), text: item.text })),
    alerts: league.alerts.map((alert) => ({ label: alert.title, time: time(alert.createdAt), text: alert.message })),
    openQuestions: league.openQuestions.map((question) => ({ ...question, time: time(question.createdAt) })),
    headlines: league.headlines.slice(0, DIGEST_MAX_HEADLINES).map((item) => ({ label: wireByline(item.persona), time: time(item.createdAt), text: item.text })),
  };
}

function digestLeagueHtml(league: WireDigestLeague, timeZone?: string): string {
  const view = digestLeagueView(league, timeZone);
  const parts = [rule(), headline(league.leagueName, { size: 26 }), league.teamName ? kicker(league.teamName) : ""];
  if (view.yourTeam.length > 0) parts.push(kicker("Your team"), digestItems(view.yourTeam));
  if (view.alerts.length > 0) parts.push(kicker("Alerts"), digestItems(view.alerts));
  if (view.openQuestions.length > 0) {
    parts.push(kicker("Sam is waiting on you"), ...view.openQuestions.map((question) => quoteBlock(question.text)), button("Answer on the Wire", league.wireUrl));
  }
  if (view.headlines.length > 0) parts.push(kicker("Around the league"), digestItems(view.headlines));
  parts.push(
    finePrint(
      `<a href="${escapeHtml(league.wireUrl)}" class="em-text2" style="color:${LIGHT_PALETTE.text2};text-decoration:underline;">Open the Wire for ${escapeHtml(league.leagueName)}</a>`,
    ),
  );
  return parts.filter(Boolean).join("\n");
}

function digestLeagueText(league: WireDigestLeague, timeZone?: string): string {
  const view = digestLeagueView(league, timeZone);
  return textDocument([
    TEXT_RULE,
    `${league.leagueName.toUpperCase()}${league.teamName ? ` · ${league.teamName}` : ""}`,
    view.yourTeam.length > 0 ? `Your team:\n${digestTextItems(view.yourTeam)}` : undefined,
    view.alerts.length > 0 ? `Alerts:\n${digestTextItems(view.alerts)}` : undefined,
    view.openQuestions.length > 0
      ? `Sam is waiting on you:\n${view.openQuestions.map((question) => `"${question.text.trim()}" (${question.time})`).join("\n")}\nAnswer on the Wire: ${league.wireUrl}`
      : undefined,
    view.headlines.length > 0 ? `Around the league:\n${digestTextItems(view.headlines)}` : undefined,
    `Open the Wire: ${league.wireUrl}`,
  ]);
}

/** The inbox preview: the first thing the desk said about the reader's team, else the first alert or headline. */
function digestPreheader(data: WireDigestData): string {
  for (const league of data.leagues) {
    const first = league.yourTeam[0]?.text ?? league.alerts[0]?.message ?? league.headlines[0]?.text;
    if (first) {
      const clean = first.trim();
      return clean.length > 140 ? `${clean.slice(0, 137).trimEnd()}…` : clean;
    }
  }
  return "Your Sunday on the Wire.";
}

export function renderWireDigestEmail(data: WireDigestData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl ?? originOf(data.settingsUrl) ?? originOf(data.leagues[0]?.wireUrl) ?? "https://ffsn.ai");
  const leagues = data.leagues;
  const subject =
    leagues.length === 1 ? `Your Wire · ${leagues[0].leagueName}` : leagues.length > 1 ? `Your Wire · ${leagues.length} leagues` : "Your Wire";
  const dateLabel = digestDateLabel(data.windowEnd, data.timeZone);
  const preheader = digestPreheader(data);
  const intro =
    leagues.length > 0
      ? `${greeting(data.recipientName)} Here is what the desk had on your ${leagues.length === 1 ? "team" : "teams"} since Sunday morning, in one place.`
      : `${greeting(data.recipientName)} The desk had nothing on your teams today.`;
  const manageAlerts = `<a href="${escapeHtml(data.settingsUrl)}" class="em-text2" style="color:${LIGHT_PALETTE.text2};text-decoration:underline;">Manage alerts</a>`;

  const content = [
    slate("The Wire", `Sunday night · ${dateLabel}`),
    headline("Your Wire"),
    paragraph(escapeHtml(intro)),
    ...leagues.map((league) => digestLeagueHtml(league, data.timeZone)),
    rule(),
    finePrint(`${manageAlerts} &middot; Sent once, Sunday night, and only when the desk had something for you.`, { last: true }),
  ].join("\n");

  const leagueNames = leagues.map((league) => league.leagueName);
  const reason =
    leagueNames.length > 0
      ? `You're getting this because your Wire alerts are on for ${leagueNames.join(", ")} on FFSN.`
      : "You're getting this because your Wire alerts are on at FFSN.";

  const html = renderShell({
    title: subject,
    preheader,
    siteUrl,
    preferencesUrl: data.settingsUrl,
    mastheadLabel: "The Wire",
    reason,
    content,
  });

  const text = textDocument([
    `FFSN · THE WIRE · SUNDAY NIGHT · ${dateLabel.toUpperCase()}`,
    "Your Wire",
    intro,
    ...leagues.map((league) => digestLeagueText(league, data.timeZone)),
    TEXT_RULE,
    `Manage alerts: ${data.settingsUrl}\nSent once, Sunday night, and only when the desk had something for you.`,
    textFooter({ siteUrl, preferencesUrl: data.settingsUrl, reason }),
  ]);

  return { subject, preheader, html, text, fromName: "The Wire · FFSN" };
}

/* -------------------------------------------------------------------------- */
/* System notice (test sends, announcements)                                  */
/* -------------------------------------------------------------------------- */

export interface SystemNoticeEmailData {
  /** Slate text, defaults to "From the network". */
  kicker?: string;
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  preferencesUrl: string;
  siteUrl: string;
}

export function renderSystemNoticeEmail(data: SystemNoticeEmailData): RenderedEmail {
  const siteUrl = trimTrailingSlash(data.siteUrl);
  const kickerText = data.kicker ?? "From the network";
  const paragraphs = data.paragraphs.map((p) => p.trim()).filter(Boolean);
  const preheader = paragraphs[0] ?? data.title;

  const content = [
    slate(kickerText),
    headline(data.title),
    ...paragraphs.map((p, i) => paragraph(escapeHtml(p), { last: !data.cta && i === paragraphs.length - 1 })),
    data.cta ? button(data.cta.label, data.cta.url) : "",
  ].join("\n");

  const html = renderShell({
    title: data.title,
    preheader,
    siteUrl,
    preferencesUrl: data.preferencesUrl,
    content,
  });

  const text = textDocument([
    `FFSN · ${kickerText.toUpperCase()}`,
    data.title,
    TEXT_RULE,
    ...paragraphs,
    data.cta ? `${data.cta.label}: ${data.cta.url}` : undefined,
    textFooter({ siteUrl, preferencesUrl: data.preferencesUrl }),
  ]);

  return { subject: data.title, preheader, html, text, fromName: "FFSN" };
}

/* -------------------------------------------------------------------------- */
/* Registry (used by the Convex send queue)                                   */
/* -------------------------------------------------------------------------- */

/** Template ids in `emailLogs` that start with this are rendered here instead of by SendGrid. */
export const LOCAL_TEMPLATE_PREFIX = "ffsn:";

export type EmailTemplateKey =
  | "comment_request"
  | "comment_reminder"
  | "article_published"
  | "system_notice"
  | "team_invitation"
  | "espn_connection_broken"
  | "espn_connection_expiring"
  | "espn_connection_restored"
  | "wire_digest";

export interface EmailTemplateDataMap {
  comment_request: CommentRequestEmailData;
  comment_reminder: CommentRequestEmailData;
  article_published: ArticlePublishedEmailData;
  system_notice: SystemNoticeEmailData;
  team_invitation: TeamInvitationEmailData;
  espn_connection_broken: EspnConnectionBrokenEmailData;
  espn_connection_expiring: EspnConnectionExpiringEmailData;
  espn_connection_restored: EspnConnectionRestoredEmailData;
  wire_digest: WireDigestData;
}

export function localTemplateId(key: EmailTemplateKey): string {
  return `${LOCAL_TEMPLATE_PREFIX}${key}`;
}

export function isLocalTemplateId(templateId: string): boolean {
  return templateId.startsWith(LOCAL_TEMPLATE_PREFIX);
}

export function renderEmail<K extends EmailTemplateKey>(key: K, data: EmailTemplateDataMap[K]): RenderedEmail {
  switch (key) {
    case "comment_request":
      return renderCommentRequestEmail({ variant: "request", ...(data as CommentRequestEmailData) });
    case "comment_reminder": {
      const d = data as CommentRequestEmailData;
      return renderCommentRequestEmail({ ...d, variant: d.variant && d.variant !== "request" ? d.variant : "reminder" });
    }
    case "article_published":
      return renderArticlePublishedEmail(data as ArticlePublishedEmailData);
    case "system_notice":
      return renderSystemNoticeEmail(data as SystemNoticeEmailData);
    case "team_invitation":
      return renderTeamInvitationEmail(data as TeamInvitationEmailData);
    case "espn_connection_broken":
      return renderEspnConnectionBrokenEmail(data as EspnConnectionBrokenEmailData);
    case "espn_connection_expiring":
      return renderEspnConnectionExpiringEmail(data as EspnConnectionExpiringEmailData);
    case "espn_connection_restored":
      return renderEspnConnectionRestoredEmail(data as EspnConnectionRestoredEmailData);
    case "wire_digest":
      return renderWireDigestEmail(data as WireDigestData);
    default: {
      const never: never = key;
      throw new Error(`Unknown email template: ${String(never)}`);
    }
  }
}

/**
 * Renders a queued email by its stored template id (`ffsn:<key>`). Returns
 * null for ids that are not local (i.e. SendGrid dynamic template ids), so
 * the caller can fall through to SendGrid's own rendering.
 */
export function renderLocalTemplate(templateId: string, data: unknown): RenderedEmail | null {
  if (!isLocalTemplateId(templateId)) return null;
  const key = templateId.slice(LOCAL_TEMPLATE_PREFIX.length) as EmailTemplateKey;
  if (
    ![
      "comment_request",
      "comment_reminder",
      "article_published",
      "system_notice",
      "team_invitation",
      "espn_connection_broken",
      "espn_connection_expiring",
      "espn_connection_restored",
      "wire_digest",
    ].includes(key)
  ) {
    throw new Error(`Unknown local email template: ${templateId}`);
  }
  return renderEmail(key, data as EmailTemplateDataMap[typeof key]);
}
