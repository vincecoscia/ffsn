/**
 * Renders every FFSN email template with sample data so they can be opened in
 * a browser while iterating on the design.
 *
 *   npx vite-node scripts/preview-emails.ts            # writes .email-preview/
 *   npx vite-node scripts/preview-emails.ts some/dir   # custom output dir
 *
 * For each template it writes `<key>.html` (exactly what is sent; follows your
 * OS theme in a browser), `<key>.light.html` (dark-mode rules disabled, which
 * is what Gmail and Outlook desktop show), `<key>.dark.html` (dark-mode rules
 * forced on, as Apple Mail renders in dark mode) and `<key>.txt` (the
 * plain-text part), plus an `index.html` linking them all.
 * The sample data below is the shared design fixture (The Sunday Scaries,
 * Dana Whitlock, Week 3) and contains no real league data.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  contentTypeLabel,
  interviewerDisplay,
  renderArticlePublishedEmail,
  renderCommentRequestEmail,
  renderSystemNoticeEmail,
  writerDisplay,
  type RenderedEmail,
} from "../src/lib/email";

const siteUrl = process.env.SITE_URL ?? "https://ffsn.ai";
const preferencesUrl = `${siteUrl}/dashboard/settings/notifications`;
const outDir = resolve(process.argv[2] ?? ".email-preview");
const leagueName = "The Sunday Scaries";
const commentRequestUrl = `${siteUrl}/leagues/sample-league/comment-requests/sample-request`;
const articleUrl = `${siteUrl}/articles/sample-article`;

// Thu, Sep 3 2026, 7:30 PM EDT
const deadline = Date.UTC(2026, 8, 3, 23, 30);

const samples: Array<{ key: string; label: string; email: RenderedEmail }> = [
  {
    key: "comment-request",
    label: "Request for comment (Sam Ortega, for Curtis Vaughn's Weekly Recap)",
    email: renderCommentRequestEmail({
      variant: "request",
      recipientName: "Dana Whitlock",
      leagueName,
      contentTypeLabel: contentTypeLabel("weekly_recap"),
      week: 3,
      question:
        "Kittle Me This left 31 points on the bench in a game you lost by 4. Walk me through the Sunday-morning call on Jaylen Waddle.",
      writer: writerDisplay("curtis-vaughn"),
      interviewer: interviewerDisplay(),
      deadline,
      commentRequestUrl,
      preferencesUrl,
      siteUrl,
    }),
  },
  {
    key: "comment-reminder",
    label: "Reminder (Mel Diaper's Mock Draft, 3 hours left)",
    email: renderCommentRequestEmail({
      variant: "reminder",
      recipientName: "Dana Whitlock",
      leagueName,
      contentTypeLabel: contentTypeLabel("mock_draft"),
      question:
        "Mel called your Hurts pick nineteen picks of air. Anything you want to say to him before the mock runs?",
      writer: writerDisplay("mel-diaper"),
      interviewer: interviewerDisplay(),
      deadline,
      minutesRemaining: 180,
      commentRequestUrl,
      preferencesUrl,
      siteUrl,
    }),
  },
  {
    key: "comment-final",
    label: "Final call (Nina Sharpe's Power Rankings, 30 minutes left)",
    email: renderCommentRequestEmail({
      variant: "final_reminder",
      recipientName: "Dana Whitlock",
      leagueName,
      contentTypeLabel: contentTypeLabel("power_rankings"),
      week: 3,
      writer: writerDisplay("nina-sharpe"),
      interviewer: interviewerDisplay(),
      deadline,
      minutesRemaining: 30,
      commentRequestUrl,
      preferencesUrl,
      siteUrl,
    }),
  },
  {
    key: "article-published",
    label: "Article published (Curtis Vaughn, Weekly Recap)",
    email: renderArticlePublishedEmail({
      title: "The Highest-Scoring Team in This League Is 1-2",
      summary:
        "Good evening. Kittle Me This put up the week's top score and lost by four. Tightest game on the board, and everything else was decided by more than that. Numbers desk has the bench math.",
      articleUrl,
      leagueName,
      contentTypeLabel: contentTypeLabel("weekly_recap"),
      week: 3,
      writer: writerDisplay("curtis-vaughn"),
      recipientName: "Dana Whitlock",
      preferencesUrl,
      siteUrl,
    }),
  },
  {
    key: "article-quoted",
    label: "Article published, recipient quoted (Mel Diaper, Mock Draft)",
    email: renderArticlePublishedEmail({
      title: "Nineteen Picks of Air: The Second Mock",
      summary:
        "Three rounds. That's the gap. Dana Whitlock told Sam the Hurts pick was about the schedule. I read the quote back and I have a pick number for it.",
      articleUrl,
      leagueName,
      contentTypeLabel: contentTypeLabel("mock_draft"),
      writer: writerDisplay("mel-diaper"),
      recipientName: "Dana Whitlock",
      quoted: true,
      preferencesUrl,
      siteUrl,
    }),
  },
  {
    key: "system-notice",
    label: "System notice (test send)",
    email: renderSystemNoticeEmail({
      kicker: "Signal check",
      title: "The desk is on the air.",
      paragraphs: [
        "This is a test message from FFSN to confirm email delivery is working.",
        "Test type: basic. If you can read this, the sender, the unsubscribe group and the template pipeline are all wired up.",
      ],
      cta: { label: "Open the dashboard", url: `${siteUrl}/dashboard` },
      preferencesUrl,
      siteUrl,
    }),
  },
];

const DARK_MEDIA = "@media (prefers-color-scheme:dark)";

mkdirSync(outDir, { recursive: true });

for (const { key, email } of samples) {
  writeFileSync(resolve(outDir, `${key}.html`), email.html);
  writeFileSync(resolve(outDir, `${key}.light.html`), email.html.replace(DARK_MEDIA, "@media not all"));
  writeFileSync(resolve(outDir, `${key}.dark.html`), email.html.replace(DARK_MEDIA, "@media all"));
  writeFileSync(resolve(outDir, `${key}.txt`), `Subject: ${email.subject}\nFrom: ${email.fromName}\n\n${email.text}\n`);
}

const index = `<!doctype html><meta charset="utf-8"><title>FFSN email previews</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;color:#0E0C0C;background:#F4F0EC}h1{font-size:20px}li{margin:8px 0}code{font-size:12px;color:#5E5651}</style>
<h1>FFSN email previews</h1>
<ul>${samples
  .map(
    ({ key, label, email }) =>
      `<li><strong>${label}</strong><br><code>${email.fromName} · ${email.subject}</code><br><a href="${key}.html">as sent</a> · <a href="${key}.light.html">light</a> · <a href="${key}.dark.html">dark</a> · <a href="${key}.txt">text</a></li>`,
  )
  .join("")}</ul>`;
writeFileSync(resolve(outDir, "index.html"), index);

console.log(`Wrote ${samples.length} templates × 4 files to ${outDir}`);
for (const { key, email } of samples) {
  console.log(`  ${key.padEnd(20)} ${email.fromName.padEnd(18)} ${email.subject}`);
}
