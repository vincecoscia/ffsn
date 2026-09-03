import { describe, expect, it } from "vitest";

import {
  contentTypeLabel,
  firstName,
  formatDeadline,
  humanizeMinutes,
  interviewerDisplay,
  isLocalTemplateId,
  localTemplateId,
  personaInitials,
  renderArticlePublishedEmail,
  renderCommentRequestEmail,
  renderEspnConnectionBrokenEmail,
  renderEspnConnectionExpiringEmail,
  renderEspnConnectionRestoredEmail,
  renderLocalTemplate,
  renderSystemNoticeEmail,
  renderTeamInvitationEmail,
  SENDGRID_UNSUBSCRIBE_TAG,
  shortName,
  writerDisplay,
  type CommentRequestEmailData,
  type EspnConnectionBrokenEmailData,
  type EspnConnectionExpiringEmailData,
  type EspnConnectionRestoredEmailData,
  type TeamInvitationEmailData,
} from "../src/lib/email";

const siteUrl = "https://ffsn.ai";
const preferencesUrl = `${siteUrl}/dashboard/settings/notifications`;
// Thu, Sep 3 2026, 7:30 PM EDT
const deadline = Date.UTC(2026, 8, 3, 23, 30);

const baseRequest: CommentRequestEmailData = {
  variant: "request",
  recipientName: "Dana Whitlock",
  leagueName: "The Sunday Scaries",
  contentTypeLabel: contentTypeLabel("weekly_recap"),
  week: 3,
  question: "Walk me through the Sunday-morning call on Jaylen Waddle.",
  writer: writerDisplay("curtis-vaughn"),
  interviewer: interviewerDisplay(),
  deadline,
  commentRequestUrl: `${siteUrl}/leagues/l1/comment-requests/r1`,
  preferencesUrl,
  siteUrl,
};

describe("email label helpers", () => {
  it("maps content types to their display names", () => {
    expect(contentTypeLabel("weekly_recap")).toBe("Weekly Recap");
    expect(contentTypeLabel("trade_rumor_mill")).toBe("The Asking Price");
    expect(contentTypeLabel("some_new_type")).toBe("Some New Type");
    expect(contentTypeLabel(undefined)).toBe("story");
  });

  it("resolves writers by slug, by display name, and never misattributes unknowns", () => {
    expect(writerDisplay("mel-diaper")).toEqual({ name: "Mel Diaper", role: "The Draft Disaster" });
    expect(writerDisplay("Mel Diaper").role).toBe("The Draft Disaster");
    expect(writerDisplay("rick-two-beers").name).toContain("O'Sullivan");
    expect(writerDisplay(undefined).name).toBe("Curtis Vaughn");
    expect(writerDisplay("Somebody Else")).toEqual({ name: "Somebody Else", role: "FFSN correspondent" });
  });

  it("uses Sam Ortega as the interviewer", () => {
    expect(interviewerDisplay()).toEqual({ name: 'Simone "Sam" Ortega', role: "Sideline Reporter" });
  });

  it("derives initials, short names and first names", () => {
    expect(personaInitials('Simone "Sam" Ortega')).toBe("SO");
    expect(personaInitials("Mel Diaper")).toBe("MD");
    expect(personaInitials("Walt")).toBe("WA");
    expect(shortName('Simone "Sam" Ortega')).toBe("Sam Ortega");
    expect(shortName("Curtis Vaughn")).toBe("Curtis Vaughn");
    expect(firstName("Dana Whitlock")).toBe("Dana");
    expect(firstName("User")).toBeUndefined();
    expect(firstName("dana@example.com")).toBeUndefined();
    expect(firstName("")).toBeUndefined();
  });

  it("formats windows", () => {
    expect(humanizeMinutes(30)).toBe("30 minutes");
    expect(humanizeMinutes(1)).toBe("1 minute");
    expect(humanizeMinutes(90)).toBe("1 hour 30 minutes");
    expect(humanizeMinutes(120)).toBe("2 hours");
    expect(humanizeMinutes(60 * 24)).toBe("1 day");
    expect(formatDeadline(deadline)).toMatch(/Thu, Sep 3, 7:30 PM E[DS]T/);
    expect(formatDeadline(deadline, "not/a-zone")).toMatch(/7:30 PM/);
  });
});

describe("comment request email", () => {
  it("comes from the sideline desk and names the writer, story, window and question", () => {
    const email = renderCommentRequestEmail(baseRequest);
    expect(email.fromName).toBe("Sam Ortega · FFSN");
    expect(email.subject).toBe("Sam Ortega wants you on the record · The Sunday Scaries · Week 3");
    expect(email.html).toContain("Simone &quot;Sam&quot; Ortega");
    expect(email.html).toContain("Sideline Reporter");
    expect(email.html).toContain("Curtis Vaughn");
    expect(email.html).toContain("Studio Anchor");
    expect(email.html).toContain("Weekly Recap");
    expect(email.html).toContain("Hi Dana.");
    expect(email.html).toContain("Walk me through the Sunday-morning call on Jaylen Waddle.");
    expect(email.html).toMatch(/Thu, Sep 3, 7:30 PM E[DS]T/);
    expect(email.html).toContain(baseRequest.commentRequestUrl);
    expect(email.text).toContain("Go on the record: " + baseRequest.commentRequestUrl);
    expect(email.text).toContain("Window closes:");
  });

  it("escapes user-controlled text", () => {
    const email = renderCommentRequestEmail({
      ...baseRequest,
      recipientName: "<script>alert(1)</script>",
      leagueName: 'Bob\'s "League" & Co <b>',
      question: "Is 3 < 4 && 5 > 2?",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("Bob&#39;s &quot;League&quot; &amp; Co &lt;b&gt;");
    expect(email.html).toContain("Is 3 &lt; 4 &amp;&amp; 5 &gt; 2?");
  });

  it("switches copy for reminders and the final call", () => {
    const reminder = renderCommentRequestEmail({ ...baseRequest, variant: "reminder", minutesRemaining: 180 });
    expect(reminder.subject).toBe("Still hoping to get you on the record · The Sunday Scaries · Week 3");
    expect(reminder.html).toContain("closes in 3 hours");
    expect(reminder.html).toContain("Answer now");
    expect(reminder.html).not.toContain("If the window closes without a reply");

    const final = renderCommentRequestEmail({ ...baseRequest, variant: "final_reminder", minutesRemaining: 30 });
    expect(final.subject).toBe("Last call from the sideline · The Sunday Scaries · Week 3");
    expect(final.html).toContain("Final call");
    expect(final.html).toContain("closes in 30 minutes");
    expect(final.html).toContain("did not respond to a request for comment");
  });

  it("copes with missing optional fields", () => {
    const email = renderCommentRequestEmail({
      ...baseRequest,
      recipientName: undefined,
      week: undefined,
      question: undefined,
      deadline: undefined,
    });
    expect(email.subject).toBe("Sam Ortega wants you on the record · The Sunday Scaries");
    expect(email.html).toContain("Hello.");
    expect(email.html).not.toContain("Here&#39;s what I&#39;m asking");
    expect(email.html).toContain("Soon");
  });
});

describe("article published email", () => {
  const base = {
    title: "The Highest-Scoring Team in This League Is 1-2",
    summary: "Good evening. Kittle Me This put up the week's top score and lost by four.",
    articleUrl: `${siteUrl}/articles/a1`,
    leagueName: "The Sunday Scaries",
    contentTypeLabel: contentTypeLabel("weekly_recap"),
    week: 3,
    writer: writerDisplay("curtis-vaughn"),
    preferencesUrl,
    siteUrl,
  };

  it("bylines the writer and links the story", () => {
    const email = renderArticlePublishedEmail(base);
    expect(email.fromName).toBe("FFSN");
    expect(email.subject).toBe("Curtis Vaughn · The Highest-Scoring Team in This League Is 1-2");
    expect(email.html).toContain("Studio Anchor");
    expect(email.html).toContain("New on FFSN");
    expect(email.html).toContain(base.articleUrl);
    expect(email.html).not.toContain("You&#39;re quoted");
    expect(email.text).toContain("Read the story: " + base.articleUrl);
  });

  it("flags a quoted recipient", () => {
    const email = renderArticlePublishedEmail({ ...base, quoted: true });
    expect(email.subject).toBe("You're quoted · The Highest-Scoring Team in This League Is 1-2");
    expect(email.html).toContain("You&#39;re quoted");
    expect(email.text).toContain("You're quoted");
  });
});

describe("team invitation email", () => {
  const deadline2027 = Date.UTC(2027, 8, 3, 23, 30); // Fri, Sep 3 2027, 7:30 PM EDT

  const base: TeamInvitationEmailData = {
    leagueName: "The Sunday Scaries",
    teamName: "Kittle Me This",
    teamAbbreviation: "KMT",
    invitedByName: "Dana Whitlock",
    inviteUrl: `${siteUrl}/invite/sample-token`,
    expiresAt: deadline2027,
    preferencesUrl,
    siteUrl,
  };

  it("names the league, team, inviter, and links the claim button, with a plain-text fallback", () => {
    const email = renderTeamInvitationEmail(base);
    expect(email.fromName).toBe("FFSN");
    expect(email.subject).toBe("You're invited to claim Kittle Me This in The Sunday Scaries on FFSN");
    expect(email.html).toContain("The Sunday Scaries");
    expect(email.html).toContain("Kittle Me This");
    expect(email.html).toContain("Dana Whitlock");
    expect(email.html).toContain("Claim your team");
    expect(email.html).toContain(base.inviteUrl);
    expect(email.html).toMatch(/expires.*Sep 3, 7:30 PM E[DS]T/i);
    expect(email.text).toContain("Claim your team: " + base.inviteUrl);
    expect(email.text).toContain(base.inviteUrl); // plain-text URL fallback
  });

  it("shows the team logo when present, and omits it otherwise", () => {
    const withLogo = renderTeamInvitationEmail({ ...base, teamLogo: `${siteUrl}/logos/kmt.png` });
    expect(withLogo.html).toContain(`src="${siteUrl}/logos/kmt.png"`);
    // The masthead always has its own <img> (the FFSN wordmark); a team logo adds a second.
    expect(withLogo.html.match(/<img/g)?.length).toBe(2);

    const withoutLogo = renderTeamInvitationEmail(base);
    expect(withoutLogo.html.match(/<img/g)?.length).toBe(1);
  });

  it("still works without a known inviter", () => {
    const email = renderTeamInvitationEmail({ ...base, invitedByName: undefined });
    expect(email.html).toContain("The commissioner of The Sunday Scaries");
    expect(email.html).not.toContain("undefined");
  });

  it("escapes user-controlled text", () => {
    const email = renderTeamInvitationEmail({
      ...base,
      teamName: '<script>alert(1)</script>',
      leagueName: 'Bob\'s "League" & Co',
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(email.html).toContain("Bob&#39;s &quot;League&quot; &amp; Co");
  });

  it("round-trips through the local template registry", () => {
    const id = localTemplateId("team_invitation");
    expect(id).toBe("ffsn:team_invitation");
    expect(isLocalTemplateId(id)).toBe(true);
    const rendered = renderLocalTemplate(id, base);
    expect(rendered?.subject).toContain("You're invited to claim Kittle Me This");
  });
});

describe("espn connection broken email", () => {
  const base: EspnConnectionBrokenEmailData = {
    leagueName: "The Sunday Scaries",
    errorDetail: "ESPN API returned 401: Unauthorized",
    waitingCount: 3,
    fixUrl: `${siteUrl}/leagues/l1/settings`,
    preferencesUrl,
    siteUrl,
  };

  it("names what ESPN said, what's waiting, links the fix, and gives the cookie steps", () => {
    const email = renderEspnConnectionBrokenEmail(base);
    expect(email.fromName).toBe("FFSN");
    expect(email.subject).toBe("Action needed: FFSN can't reach your ESPN league");
    expect(email.html).toContain("The Sunday Scaries");
    expect(email.html).toContain("ESPN API returned 401: Unauthorized");
    expect(email.html).toContain("3");
    expect(email.html).toContain("Fix the connection");
    expect(email.html).toContain(base.fixUrl);
    expect(email.html).toContain("espn_s2");
    expect(email.html).toContain("SWID");
    expect(email.text).toContain("Fix the connection: " + base.fixUrl);
    expect(email.text).toContain(base.fixUrl); // plain-text URL fallback
    expect(email.text).toContain("How to find your ESPN cookies");
  });

  it("switches to reminder copy without changing the core facts", () => {
    const first = renderEspnConnectionBrokenEmail(base);
    const reminder = renderEspnConnectionBrokenEmail({ ...base, isReminder: true });
    expect(reminder.subject).not.toBe(first.subject);
    expect(reminder.subject.toLowerCase()).toContain("still");
    expect(reminder.html).toContain("Still");
    // The facts (error detail, waiting count, fix link) don't change with the variant.
    expect(reminder.html).toContain("ESPN API returned 401: Unauthorized");
    expect(reminder.html).toContain(base.fixUrl);
  });

  it("falls back to plain copy when ESPN's error message is unknown, and handles zero waiting", () => {
    const email = renderEspnConnectionBrokenEmail({ ...base, errorDetail: undefined, waitingCount: 0 });
    expect(email.html).toContain("Login rejected");
    expect(email.html).not.toContain("undefined");
  });

  it("escapes user-controlled text", () => {
    const email = renderEspnConnectionBrokenEmail({
      ...base,
      leagueName: 'Bob\'s "League" & Co <b>',
      errorDetail: "<script>alert(1)</script>",
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(email.html).toContain("Bob&#39;s &quot;League&quot; &amp; Co &lt;b&gt;");
  });

  it("round-trips through the local template registry", () => {
    const id = localTemplateId("espn_connection_broken");
    expect(id).toBe("ffsn:espn_connection_broken");
    expect(isLocalTemplateId(id)).toBe(true);
    const rendered = renderLocalTemplate(id, base);
    expect(rendered?.subject).toContain("can't reach your ESPN league");
  });
});

describe("espn connection expiring email", () => {
  const base: EspnConnectionExpiringEmailData = {
    leagueName: "The Sunday Scaries",
    daysLeft: 12,
    fixUrl: `${siteUrl}/leagues/l1/settings`,
    preferencesUrl,
    siteUrl,
  };

  it("names the days left, links reconnect, and gives the cookie steps", () => {
    const email = renderEspnConnectionExpiringEmail(base);
    expect(email.fromName).toBe("FFSN");
    expect(email.subject).toBe("Your ESPN login for FFSN expires in 12 days");
    expect(email.html).toContain("The Sunday Scaries");
    expect(email.html).toContain("12 days");
    expect(email.html).toContain("Reconnect now");
    expect(email.html).toContain(base.fixUrl);
    expect(email.html).toContain("espn_s2");
    expect(email.text).toContain("Reconnect now: " + base.fixUrl);
    expect(email.text).toContain(base.fixUrl);
  });

  it("uses singular 'day' for one day left, and floors/rounds sensibly", () => {
    const email = renderEspnConnectionExpiringEmail({ ...base, daysLeft: 1 });
    expect(email.subject).toBe("Your ESPN login for FFSN expires in 1 day");
    expect(email.html).not.toContain("1 days");
  });

  it("escapes user-controlled text", () => {
    const email = renderEspnConnectionExpiringEmail({ ...base, leagueName: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("round-trips through the local template registry", () => {
    const id = localTemplateId("espn_connection_expiring");
    expect(id).toBe("ffsn:espn_connection_expiring");
    expect(isLocalTemplateId(id)).toBe(true);
    const rendered = renderLocalTemplate(id, base);
    expect(rendered?.subject).toBe("Your ESPN login for FFSN expires in 12 days");
  });
});

describe("espn connection restored email", () => {
  const base: EspnConnectionRestoredEmailData = {
    leagueName: "The Sunday Scaries",
    resumedCount: 4,
    withoutInterviewsCount: 1,
    leagueUrl: `${siteUrl}/leagues/l1`,
    preferencesUrl,
    siteUrl,
  };

  it("confirms the fix, the resume counts, and links back in", () => {
    const email = renderEspnConnectionRestoredEmail(base);
    expect(email.fromName).toBe("FFSN");
    expect(email.subject).toBe("FFSN is back on your league");
    expect(email.html).toContain("The Sunday Scaries");
    expect(email.html).toContain("4");
    expect(email.html).toContain("1");
    expect(email.html).toContain("Open your league");
    expect(email.html).toContain(base.leagueUrl);
    expect(email.text).toContain("Open your league: " + base.leagueUrl);
    expect(email.text).toContain(base.leagueUrl);
  });

  it("copes with a backlog that resumed nothing", () => {
    const email = renderEspnConnectionRestoredEmail({ ...base, resumedCount: 0, withoutInterviewsCount: 0 });
    expect(email.html).not.toContain("undefined");
  });

  it("escapes user-controlled text", () => {
    const email = renderEspnConnectionRestoredEmail({ ...base, leagueName: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("round-trips through the local template registry", () => {
    const id = localTemplateId("espn_connection_restored");
    expect(id).toBe("ffsn:espn_connection_restored");
    expect(isLocalTemplateId(id)).toBe(true);
    const rendered = renderLocalTemplate(id, base);
    expect(rendered?.subject).toBe("FFSN is back on your league");
  });
});

describe("shell", () => {
  it("includes the SendGrid unsubscribe tag, preferences link, logo, and dark-mode rules", () => {
    const email = renderSystemNoticeEmail({
      title: "The desk is on the air.",
      paragraphs: ["Test."],
      preferencesUrl,
      siteUrl: `${siteUrl}/`,
    });
    expect(email.html).toContain(SENDGRID_UNSUBSCRIBE_TAG);
    expect(email.text).toContain(SENDGRID_UNSUBSCRIBE_TAG);
    expect(email.html).toContain(preferencesUrl);
    expect(email.html).toContain(`src="${siteUrl}/email/FFSN.png"`);
    expect(email.html).toContain("@media (prefers-color-scheme:dark)");
    expect(email.html).toContain("[data-ogsc] .em-panel");
    expect(email.html).toContain("Barlow Condensed");
    expect(email.html).not.toContain("beta");
  });
});

describe("local template registry", () => {
  it("round-trips template ids and renders queued data", () => {
    const id = localTemplateId("comment_request");
    expect(id).toBe("ffsn:comment_request");
    expect(isLocalTemplateId(id)).toBe(true);
    expect(isLocalTemplateId("d-1234567890")).toBe(false);
    expect(renderLocalTemplate("d-1234567890", {})).toBeNull();

    const rendered = renderLocalTemplate(id, JSON.parse(JSON.stringify(baseRequest)));
    expect(rendered?.subject).toContain("wants you on the record");

    const reminder = renderLocalTemplate(localTemplateId("comment_reminder"), {
      ...baseRequest,
      variant: undefined,
      minutesRemaining: 45,
    });
    expect(reminder?.subject).toContain("Still hoping");
    expect(() => renderLocalTemplate("ffsn:nope", {})).toThrow(/Unknown local email template/);
  });
});
