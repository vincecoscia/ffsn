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
  renderLocalTemplate,
  renderSystemNoticeEmail,
  SENDGRID_UNSUBSCRIBE_TAG,
  shortName,
  writerDisplay,
  type CommentRequestEmailData,
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
