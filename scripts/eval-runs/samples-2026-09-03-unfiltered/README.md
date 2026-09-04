# Generated samples at `unfiltered`, 2026-09-03

Live generations against `src/lib/ai/__fixtures__/rich-week.json` with the league language rating
set to `unfiltered`, the night profanity moved from a house-style quota into each persona's own
LANGUAGE trait (`language:` in `src/lib/ai/persona-prompts.ts`). Every name here is invented fixture
data. The HTML comment at the end of each file is the verifier's flag list. All on Opus 5 at medium.

Counts are tracked words in the body (team names exempt), against the writer's range at unfiltered
(Mel 4-12, Reggie 3-10, Curtis 0-1). Two rounds:

**Round 1 — trait + samples, ceiling only.**
- `weekly_recap--mel-diaper` — 4: "a shitshow of a use of a good day", "hurts like shit", "a GODDAMN EXPLANATION ATTACHED". First attempt came back at 13 words (the known thin-article flake) and was regenerated; $0.54.
- `weekly_recap--reggie-banks--before-trait-floor` — 0, flagged FLAT. The model read "never get angry" as "never swear".
- `weekly_recap--reggie-banks` — 1, after the trait gained an expected range and the user prompt its per-piece LANGUAGE line: "That projection sheet is horseshit and I say that with a smile."
- `weekly_recap--curtis-vaughn` — 0 of 1, which is the design: most of his pieces use none.

**Round 2 — floors (a range, "fewer than N is out of character"), Reggie's "profanity is volume, not anger" line, "fuck" named in the tier, praise-swears allowed.**
- `weekly_recap--reggie-banks--floors-1` — 3: "projections are horseshit", "damn near four touchdowns", "SHUT THE FUCK UP."
- `weekly_recap--reggie-banks--floors-2` — 3: "that is a fucking statement", "SHUT THE FUCK UP.", "The paper is horseshit."
- `weekly_recap--reggie-banks--floors-3` — 3: "SHUT THE FUCK UP, that's a fucking DAWG", "Projections are horseshit".
- `weekly_recap--mel-diaper--floors` — 3 (UNDER his floor of 4): "HORSESHIT to call it variance", "CONFISCATED TONIGHT, AND I MEAN FUCKING TONIGHT", "hurts like shit". Failed the publish gate on an unrelated verifier finding (data_speak).

Every Reggie run landed exactly on his floor: the floor behaves as a target. Two of Mel's lines are
his language samples echoed word for word — the samples are treated as templates.

**Round 3 — sample rotation (a week-seeded window of 3 from pools of 5-8), variety lines ("goddamn is
one word in the tier"), Mel's floor raised to 5, and a per-section nudge for carriers ("every section
after the first sentence carries at least one").**
- `weekly_recap--mel-diaper--rich-week--salty-rotation` — 6 mild of a 3-6 range at salty: damn ×2, hell ×2, half-assed, sucks. The mild tier finally reads with some range.
- `weekly_recap--mel-diaper--rich-week--floor5-rotation` — 3 (UNDER his new floor of 5): the floor alone did not move Mel the way it moved Reggie.
- `weekly_recap--mel-diaper--rich-week--per-section` — 5, exactly one per section: "a fucking receipt", "horseshit with a bow on it", "did not save a damn thing", "a shitshow", "AND I MEAN FUCKING TONIGHT". Structure moved him where the count did not.

Companion episodes for round 3: `../disputed/...-230937-salty-variety.*` (10 mild: damn ×7, hell ×2,
half-assed — up from 4) and `...-231011-unfiltered-variety.*` (2 mild / 8 strong, "goddamn" down to
1 of 10: "$76 and a fucking shrug", "a fucking junk drawer with $76 taped to it", "I'll wear your
cute-ass grade card").

Companion Disputed episodes: `../disputed/ffl-2025-w8.league-20260903-2011-salty.*` (4 mild),
`...-201537-unfiltered.*` (round 1: 2 mild / 3 strong) and `...-203346-unfiltered-floors.*`
(round 2: 2 mild / 10 strong, Mel 7, Reggie 5). Those use the real league file, not a fixture.

Regenerate with `npm run eval:articles -- --live --type weekly_recap --persona <slug> --fixture rich-week --language unfiltered --dump <dir>`;
the summary prints each body's profanity against the writer's range (FLAT / UNDER / OVER / OUT OF TIER).
