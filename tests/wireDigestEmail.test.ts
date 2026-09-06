import { describe, expect, it } from "vitest";

import { formatWireTime, isLocalTemplateId, localTemplateId, renderLocalTemplate, renderWireDigestEmail, SENDGRID_UNSUBSCRIBE_TAG } from "../src/lib/email";
import { DIGEST_MAX_HEADLINES, DIGEST_MAX_YOUR_TEAM, type WireDigestData, type WireDigestLeague } from "../src/lib/ai/wire/types";

const siteUrl = "https://ffsn.ai";
const settingsUrl = `${siteUrl}/dashboard/settings/notifications`;
// Sunday Sep 13 2026, Eastern: hour → UTC ms (EDT is UTC−4).
const sundayAt = (hourEt: number, minute = 0) => Date.UTC(2026, 8, 13, hourEt + 4, minute);

function league(overrides: Partial<WireDigestLeague> = {}): WireDigestLeague {
  return {
    leagueId: "l1",
    leagueName: "The Sunday Scaries",
    teamName: "Kittle Me This",
    wireUrl: `${siteUrl}/leagues/l1/wire`,
    yourTeam: [
      { persona: "reggie-banks", text: "Kittle Me This just got six from Ja'Marr Chase.", createdAt: sundayAt(16, 12) },
      { persona: "curtis-vaughn", text: "Kickoff: Kittle Me This has Joe Burrow on the field in this one.", createdAt: sundayAt(13, 1) },
    ],
    alerts: [{ title: "Lineup lock", message: "Joe Burrow (Questionable) is in your lineup with 60 minutes to kickoff.", createdAt: sundayAt(12, 0) }],
    openQuestions: [{ text: "Walk me through the Sunday-morning call on Jaylen Waddle.", createdAt: sundayAt(20, 30), postId: "p1" }],
    headlines: [
      { persona: "dex-alvarez", text: "Joe Burrow (CIN · QB): Questionable → Out.", createdAt: sundayAt(11, 40) },
      { persona: "curtis-vaughn", text: "Final: CIN 27, CLE 20.", createdAt: sundayAt(16, 22) },
    ],
    ...overrides,
  };
}

function digest(overrides: Partial<WireDigestData> = {}): WireDigestData {
  return {
    recipientName: "Dana Whitlock",
    windowStart: sundayAt(0),
    windowEnd: sundayAt(24),
    leagues: [league()],
    settingsUrl,
    ...overrides,
  };
}

describe("wire digest email", () => {
  it("subjects one league by name and several by count", () => {
    expect(renderWireDigestEmail(digest()).subject).toBe("Your Wire · The Sunday Scaries");
    const two = renderWireDigestEmail(digest({ leagues: [league(), league({ leagueId: "l2", leagueName: "Moisty Loins Memorial" })] }));
    expect(two.subject).toBe("Your Wire · 2 leagues");
    expect(two.html).toContain("Moisty Loins Memorial");
    expect(renderWireDigestEmail(digest({ leagues: [] })).subject).toBe("Your Wire");
  });

  it("carries the Sunday-night header, the greeting, the team and every section", () => {
    const email = renderWireDigestEmail(digest());
    expect(email.fromName).toBe("The Wire · FFSN");
    expect(email.html).toContain("The Wire");
    expect(email.html).toContain("Sunday night · Sunday, Sep 13");
    expect(email.html).toContain("Hi Dana.");
    expect(email.html).toContain("Kittle Me This");
    for (const section of ["Your team", "Alerts", "Sam is waiting on you", "Around the league"]) expect(email.html).toContain(section);
    expect(email.html).toContain("Kittle Me This just got six from Ja&#39;Marr Chase.");
    expect(email.html).toContain("Lineup lock");
    expect(email.html).toContain("Walk me through the Sunday-morning call on Jaylen Waddle.");
    expect(email.html).toContain("Answer on the Wire");
    expect(email.html).toContain(`${siteUrl}/leagues/l1/wire`);
    expect(email.html).toContain("Final: CIN 27, CLE 20.");
    expect(email.preheader).toBe("Kittle Me This just got six from Ja'Marr Chase.");
  });

  it("bylines items with the writer's short name, and 'The Wire' when a desk post carries no persona", () => {
    const email = renderWireDigestEmail(
      digest({
        leagues: [
          league({
            yourTeam: [
              { persona: "reggie-banks", text: "Six.", createdAt: sundayAt(16) },
              { persona: undefined, text: "No byline.", createdAt: sundayAt(16) },
              { persona: "sam-ortega", text: "A question.", createdAt: sundayAt(16) },
            ],
          }),
        ],
      }),
    );
    expect(email.html).toContain("Reggie Banks");
    expect(email.html).toContain("The Wire<span");
    expect(email.html).toContain("Sam Ortega");
    expect(email.html).not.toContain("undefined");
    expect(email.text).toContain("- Reggie Banks (");
    expect(email.text).toContain("- The Wire (");
  });

  it("omits every section that is empty", () => {
    const email = renderWireDigestEmail(digest({ leagues: [league({ yourTeam: [], alerts: [], openQuestions: [], headlines: [] })] }));
    for (const section of ["Your team", "Alerts", "Sam is waiting on you", "Around the league", "Answer on the Wire"]) {
      expect(email.html, section).not.toContain(section);
      expect(email.text, section).not.toContain(section);
    }
    expect(email.html).toContain("Open the Wire for The Sunday Scaries");
    expect(email.text).toContain(`Open the Wire: ${siteUrl}/leagues/l1/wire`);
  });

  it("caps the per-league lists at the digest limits", () => {
    const many = league({
      yourTeam: Array.from({ length: DIGEST_MAX_YOUR_TEAM + 3 }, (_, i) => ({ persona: "reggie-banks", text: `Team item ${i}`, createdAt: sundayAt(16) })),
      headlines: Array.from({ length: DIGEST_MAX_HEADLINES + 3 }, (_, i) => ({ persona: "dex-alvarez", text: `Headline ${i}`, createdAt: sundayAt(16) })),
    });
    const email = renderWireDigestEmail(digest({ leagues: [many] }));
    expect(email.html).toContain(`Team item ${DIGEST_MAX_YOUR_TEAM - 1}`);
    expect(email.html).not.toContain(`Team item ${DIGEST_MAX_YOUR_TEAM}`);
    expect(email.html).toContain(`Headline ${DIGEST_MAX_HEADLINES - 1}`);
    expect(email.html).not.toContain(`Headline ${DIGEST_MAX_HEADLINES}`);
  });

  it("formats item times in the recipient's zone, Eastern by default", () => {
    expect(formatWireTime(sundayAt(16, 12))).toMatch(/Sun.*4:12 PM E[DS]T/);
    expect(formatWireTime(sundayAt(16, 12), "America/Los_Angeles")).toMatch(/1:12 PM P[DS]T/);
    expect(formatWireTime(sundayAt(16, 12), "not/a-zone")).toMatch(/4:12 PM/);
    const email = renderWireDigestEmail(digest());
    expect(email.html).toMatch(/4:12 PM E[DS]T/);
    expect(email.text).toMatch(/4:12 PM E[DS]T/);
    const pacific = renderWireDigestEmail(digest({ timeZone: "America/Los_Angeles" }));
    expect(pacific.html).toMatch(/1:12 PM P[DS]T/);
  });

  it("escapes every piece of user- and model-controlled text", () => {
    const email = renderWireDigestEmail(
      digest({
        recipientName: "<script>alert(1)</script>",
        leagues: [
          league({
            leagueName: 'Bob\'s "League" & Co <b>',
            teamName: "<img src=x onerror=alert(1)>",
            yourTeam: [{ persona: "reggie-banks", text: "Is 3 < 4 && 5 > 2?", createdAt: sundayAt(16) }],
            alerts: [{ title: "<b>Lock</b>", message: "A & B", createdAt: sundayAt(12) }],
            openQuestions: [{ text: "Why <em>that</em> call?", createdAt: sundayAt(20), postId: "p1" }],
            headlines: [{ persona: "<i>Somebody</i>", text: "<script>x</script>", createdAt: sundayAt(11) }],
          }),
        ],
      }),
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<b>Lock</b>");
    expect(email.html).not.toContain("<em>that</em>");
    expect(email.html).not.toContain("<i>Somebody</i>");
    expect(email.html).toContain("Bob&#39;s &quot;League&quot; &amp; Co &lt;b&gt;");
    expect(email.html).toContain("Is 3 &lt; 4 &amp;&amp; 5 &gt; 2?");
    expect(email.html).toContain("&lt;b&gt;Lock&lt;/b&gt;");
    expect(email.html).toContain("Why &lt;em&gt;that&lt;/em&gt; call?");
  });

  it("links Manage alerts to the settings page and keeps the SendGrid unsubscribe tag in both parts", () => {
    const email = renderWireDigestEmail(digest());
    expect(email.html).toContain("Manage alerts");
    expect(email.html).toContain(`href="${settingsUrl}"`);
    expect(email.html).toContain(SENDGRID_UNSUBSCRIBE_TAG);
    expect(email.text).toContain(`Manage alerts: ${settingsUrl}`);
    expect(email.text).toContain(SENDGRID_UNSUBSCRIBE_TAG);
    expect(email.html).toContain("Wire alerts are on for The Sunday Scaries");
  });

  it("derives the site origin from the settings link when none is given, and uses one when it is", () => {
    const derived = renderWireDigestEmail(digest());
    expect(derived.html).toContain(`src="${siteUrl}/email/FFSN.png"`);
    const given = renderWireDigestEmail(digest({ siteUrl: "https://beta.ffsn.ai/", settingsUrl: "not a url" }));
    expect(given.html).toContain('src="https://beta.ffsn.ai/email/FFSN.png"');
    const fromWire = renderWireDigestEmail(digest({ settingsUrl: "/dashboard/settings/notifications" }));
    expect(fromWire.html).toContain(`src="${siteUrl}/email/FFSN.png"`);
  });

  it("writes a plain-text twin with the same sections, items and links", () => {
    const email = renderWireDigestEmail(digest());
    expect(email.text).toContain("FFSN · THE WIRE · SUNDAY NIGHT · SUNDAY, SEP 13");
    expect(email.text).toContain("THE SUNDAY SCARIES · Kittle Me This");
    expect(email.text).toContain("Your team:\n- Reggie Banks (");
    expect(email.text).toContain("Kittle Me This just got six from Ja'Marr Chase.");
    expect(email.text).toContain("Alerts:\n- Lineup lock (");
    expect(email.text).toContain('Sam is waiting on you:\n"Walk me through the Sunday-morning call on Jaylen Waddle."');
    expect(email.text).toContain(`Answer on the Wire: ${siteUrl}/leagues/l1/wire`);
    expect(email.text).toContain("Around the league:\n- Dex Alvarez (");
    // No markup in the text part; the SendGrid substitution tag is the one angle-bracketed thing allowed.
    expect(email.text.replace(SENDGRID_UNSUBSCRIBE_TAG, "")).not.toContain("<");
  });

  it("round-trips through the local template registry", () => {
    const id = localTemplateId("wire_digest");
    expect(id).toBe("ffsn:wire_digest");
    expect(isLocalTemplateId(id)).toBe(true);
    const rendered = renderLocalTemplate(id, JSON.parse(JSON.stringify(digest())));
    expect(rendered?.subject).toBe("Your Wire · The Sunday Scaries");
  });
});
