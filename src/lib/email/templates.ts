/**
 * FFSN transactional email templates, rendered in code so they share the
 * Broadcast design system and the writer roster with the app.
 *
 * Every renderer is a pure function: data in, `{ subject, html, text }` out.
 * Nothing here touches Convex or SendGrid; `convex/emailService.ts` calls
 * `renderLocalTemplate` at send time for any queued email whose template id
 * starts with `ffsn:`.
 */

import { firstName, personaInitials, shortName, type EmailPersona } from "./labels";
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
  slate,
  statsRow,
  textDocument,
  textFooter,
  trimTrailingSlash,
  TEXT_RULE,
} from "./shell";

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
  | "team_invitation";

export interface EmailTemplateDataMap {
  comment_request: CommentRequestEmailData;
  comment_reminder: CommentRequestEmailData;
  article_published: ArticlePublishedEmailData;
  system_notice: SystemNoticeEmailData;
  team_invitation: TeamInvitationEmailData;
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
    !["comment_request", "comment_reminder", "article_published", "system_notice", "team_invitation"].includes(key)
  ) {
    throw new Error(`Unknown local email template: ${templateId}`);
  }
  return renderEmail(key, data as EmailTemplateDataMap[typeof key]);
}
