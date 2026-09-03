# Generated samples, 2026-09-03

Live generations against the fixture leagues (`src/lib/ai/__fixtures__/rich-week.json`, `draft-day.json`)
after the writer-voice pass. Two rounds happened this day: the first gave four writers the same joke
(understatement) and read as one voice in several hats; the second gave every writer a different
register and rhythm. These files are the second round. Every name here is invented fixture data. The HTML
comment at the end of each file is the verifier's flag list for that article. All seven were generated on
Opus 5 at medium effort.

- `draft_rankings--mel-diaper` — full volume plus one notch: caps in every paragraph, one all-caps paragraph, two outrageous demands per section, receipts on every line
- `weekly_recap--curtis-vaughn` — on air: "Good evening.", "Let's go to the board.", tosses to Nina, Dex and Reggie by name, "That's the show. This is FFSN."
- `weekly_recap--sam-ortega` — reporter's notebook in the present tense: "I catch Dana Whitlock after the final. I ask what that feels like."; "Nina has the rest of the numbers. I have the people."
- `power_rankings--nina-sharpe` — lecture: "Class. Circle the top line.", "Pop quiz:", claims graded as homework, "That's the segment."
- `trade_analysis--dex-alvarez` — phone hit in fragments: "Here's what I've got.", REPORTED / OPINION tags per line, "Back to you."
- `weekly_recap--reggie-banks` — the hype: "SEVEN AND OH!", "GIVE THAT MAN HIS FLOWERS.", "THAT'S A DAWG.", "Flowers And Face-Plants"
- `weekly_recap--walt-brennan` — Sunday column: "A season is a mortgage." carried through to "A missed payment is still a payment somebody else collected."

Compare with `../samples-2026-09-02/` for Curtis, Mel and Dex before the pass.

Regenerate with `npm run eval:articles -- --live --type <type> --persona <slug> --fixture <fixture> --dump <dir>`.
