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
  renderWireDigestEmail,
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
// The Wire digest window: Sunday Sep 13 2026, midnight to midnight Eastern.
const sundayAt = (hourEt: number, minute = 0) => Date.UTC(2026, 8, 13, hourEt + 4, minute);
const wireWindowStart = sundayAt(0);
const wireWindowEnd = sundayAt(24);

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
    key: "wire-digest",
    label: "The Wire, Sunday digest (two leagues)",
    email: renderWireDigestEmail({
      recipientName: "Dana Whitlock",
      windowStart: wireWindowStart,
      windowEnd: wireWindowEnd,
      siteUrl,
      settingsUrl: preferencesUrl,
      leagues: [
        {
          leagueId: "sample-league",
          leagueName,
          teamName: "Kittle Me This",
          wireUrl: `${siteUrl}/leagues/sample-league/wire`,
          yourTeam: [
            { persona: "reggie-banks", text: "Kittle Me This just got six from Ja'Marr Chase.", createdAt: sundayAt(16, 12) },
            { persona: "reggie-banks", text: "Derrick Henry is having a day for Kittle Me This. 24.7 fantasy points and counting.", createdAt: sundayAt(15, 48) },
            {
              persona: "mel-diaper",
              text: "Kittle Me This rosters Jaylen Waddle: 3.4 fantasy points at the final. A bad day, not a lineup call.",
              createdAt: sundayAt(16, 20),
            },
            { persona: "curtis-vaughn", text: "Kickoff: Kittle Me This has Joe Burrow on the field in this one.", createdAt: sundayAt(13, 1) },
          ],
          alerts: [
            {
              title: "Lineup lock",
              message: "Joe Burrow (Questionable) is in your starting lineup with 60 minutes to kickoff.",
              createdAt: sundayAt(12, 0),
            },
          ],
          openQuestions: [
            {
              text: "Kittle Me This left 31 points on the bench in a game you lost by 4. Walk me through the Sunday-morning call on Jaylen Waddle.",
              createdAt: sundayAt(20, 30),
              postId: "sample-post",
            },
          ],
          headlines: [
            {
              persona: "dex-alvarez",
              text: 'Joe Burrow (CIN · QB): Questionable → Out. ESPN: "Burrow (toe) will miss 6–8 weeks after surgery."',
              createdAt: sundayAt(11, 40),
            },
            { persona: "curtis-vaughn", text: "Final: CIN 27, CLE 20.", createdAt: sundayAt(16, 22) },
            { persona: "reggie-banks", text: "Derrick Henry (BAL · RB): 112 rushing yards, 3 TD and counting.", createdAt: sundayAt(15, 45) },
          ],
        },
        {
          leagueId: "sample-league-2",
          leagueName: "Moisty Loins Memorial",
          teamName: "Sable Ridge Sentinels",
          wireUrl: `${siteUrl}/leagues/sample-league-2/wire`,
          yourTeam: [],
          alerts: [],
          openQuestions: [],
          headlines: [
            { persona: "nina-sharpe", text: "Class. Sable Ridge Sentinels needs 22.6 from Joe Burrow and Chase Brown on Monday night. Show your work.", createdAt: sundayAt(23, 35) },
            { persona: "curtis-vaughn", text: "Sable Ridge Sentinels has the lead on Moisty Loins, 98.4 to 71.0. Let's go to the board.", createdAt: sundayAt(19, 10) },
          ],
        },
      ],
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
