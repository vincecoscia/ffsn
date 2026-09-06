import { describe, expect, it } from "vitest";
import { fnv1a } from "../../src/lib/ai/persona-prompts";
import {
  SAM_CHASE_COOLDOWN_MS,
  capThreadContext,
  decideReplyMode,
  relationshipEventForSentiment,
  replyGateReason,
  samChasedRecently,
  samSamplesPost,
  shouldSamChase,
  writerPersonaForTarget,
} from "../../convex/lib/wireSocialRules";
import {
  SAM_CHASE_ONE_IN,
  WRITER_REPLIES_PER_LEAGUE_PER_DAY,
  WRITER_REPLIES_PER_MANAGER_PER_HOUR,
  WRITER_REPLIES_PER_THREAD_PER_MANAGER,
} from "../../src/lib/ai/wire/types";

/**
 * Pure gate logic behind `wireSocial.onManagerPost` (spec §17.3) - see that file's header comment
 * for why the mode decision and rate limits live here instead of being tested through the action
 * itself (a "use node" action that calls `generateWriterReply`).
 */

describe("decideReplyMode", () => {
  it("a manager_reply with a target is mode 'reply'", () => {
    expect(decideReplyMode({ kind: "manager_reply", replyTo: { scope: "global", id: "p1" } })).toBe("reply");
  });

  it("a manager_reply with no target answers nothing", () => {
    expect(decideReplyMode({ kind: "manager_reply" })).toBeNull();
    expect(decideReplyMode({ kind: "manager_reply", replyTo: null })).toBeNull();
  });

  it("a standalone manager_post is always mode 'chase'", () => {
    expect(decideReplyMode({ kind: "manager_post" })).toBe("chase");
    expect(decideReplyMode({ kind: "manager_post", replyTo: null })).toBe("chase");
  });
});

describe("writerPersonaForTarget", () => {
  it("null target answers nothing", () => {
    expect(writerPersonaForTarget(null)).toBeNull();
    expect(writerPersonaForTarget(undefined)).toBeNull();
  });

  it("a target with an author (a manager's own post) is never answered", () => {
    expect(writerPersonaForTarget({ persona: "dex-alvarez", authorUserId: "clerk_x" })).toBeNull();
  });

  it("a target with a persona and no author is the writer being answered", () => {
    expect(writerPersonaForTarget({ persona: "dex-alvarez" })).toBe("dex-alvarez");
  });

  it("a target with neither answers nothing", () => {
    expect(writerPersonaForTarget({})).toBeNull();
  });
});

describe("samSamplesPost / samChasedRecently / shouldSamChase", () => {
  it("matches fnv1a(id) % SAM_CHASE_ONE_IN === 0 exactly", () => {
    for (const id of ["a", "post-1", "post-2", "post-3", "some-league-post-id", "xyz"]) {
      expect(samSamplesPost(id)).toBe(fnv1a(id) % SAM_CHASE_ONE_IN === 0);
    }
  });

  it("is deterministic for the same id", () => {
    expect(samSamplesPost("stable-id")).toBe(samSamplesPost("stable-id"));
  });

  it("samChasedRecently: undefined means never chased", () => {
    expect(samChasedRecently(undefined, Date.now())).toBe(false);
  });

  it("samChasedRecently: true inside the cooldown window, false just outside it", () => {
    const now = 10_000_000;
    expect(samChasedRecently(now - 1, now)).toBe(true);
    expect(samChasedRecently(now - (SAM_CHASE_COOLDOWN_MS - 1), now)).toBe(true);
    expect(samChasedRecently(now - SAM_CHASE_COOLDOWN_MS, now)).toBe(false);
    expect(samChasedRecently(now - SAM_CHASE_COOLDOWN_MS - 1, now)).toBe(false);
  });

  it("shouldSamChase refuses when chased recently, even on a sampled post", () => {
    const now = 10_000_000;
    // Find an id the sampler actually accepts, so the cooldown is the only thing under test.
    const sampledId = ["a", "b", "c", "d", "e", "f", "g", "h"].find((id) => samSamplesPost(id));
    expect(sampledId).toBeDefined();
    expect(shouldSamChase({ leaguePostId: sampledId!, lastSamChaseAt: now - 1, now })).toBe(false);
  });

  it("shouldSamChase follows the sampler once the cooldown has passed", () => {
    const now = 10_000_000;
    const sampledId = ["a", "b", "c", "d", "e", "f", "g", "h"].find((id) => samSamplesPost(id));
    const unsampledId = ["a", "b", "c", "d", "e", "f", "g", "h"].find((id) => !samSamplesPost(id));
    expect(sampledId).toBeDefined();
    expect(unsampledId).toBeDefined();
    expect(shouldSamChase({ leaguePostId: sampledId!, lastSamChaseAt: undefined, now })).toBe(true);
    expect(shouldSamChase({ leaguePostId: unsampledId!, lastSamChaseAt: undefined, now })).toBe(false);
  });
});

describe("replyGateReason", () => {
  const passing = {
    repliesToManagerLastHour: 0,
    repliesInLeagueToday: 0,
    repliesInThreadToManager: 0,
    seasonSpendUsd: 0,
    spendCapUsd: 60,
  };

  it("passes every gate when nothing is near a limit", () => {
    expect(replyGateReason(passing)).toBeNull();
  });

  it("the per-manager hourly limit", () => {
    expect(
      replyGateReason({ ...passing, repliesToManagerLastHour: WRITER_REPLIES_PER_MANAGER_PER_HOUR })
    ).toBe("manager_hourly_limit");
    expect(
      replyGateReason({ ...passing, repliesToManagerLastHour: WRITER_REPLIES_PER_MANAGER_PER_HOUR - 1 })
    ).toBeNull();
  });

  it("the per-league daily limit", () => {
    expect(replyGateReason({ ...passing, repliesInLeagueToday: WRITER_REPLIES_PER_LEAGUE_PER_DAY })).toBe(
      "league_daily_limit"
    );
  });

  it("the per-thread limit", () => {
    expect(
      replyGateReason({ ...passing, repliesInThreadToManager: WRITER_REPLIES_PER_THREAD_PER_MANAGER })
    ).toBe("thread_limit");
  });

  it("the season spend cap", () => {
    expect(replyGateReason({ ...passing, seasonSpendUsd: 60, spendCapUsd: 60 })).toBe("season_spend_cap");
    expect(replyGateReason({ ...passing, seasonSpendUsd: 61, spendCapUsd: 60 })).toBe("season_spend_cap");
    expect(replyGateReason({ ...passing, seasonSpendUsd: 59.99, spendCapUsd: 60 })).toBeNull();
  });

  it("checks the manager-hour gate first when several are exceeded at once", () => {
    expect(
      replyGateReason({
        repliesToManagerLastHour: WRITER_REPLIES_PER_MANAGER_PER_HOUR,
        repliesInLeagueToday: WRITER_REPLIES_PER_LEAGUE_PER_DAY,
        repliesInThreadToManager: WRITER_REPLIES_PER_THREAD_PER_MANAGER,
        seasonSpendUsd: 60,
        spendCapUsd: 60,
      })
    ).toBe("manager_hourly_limit");
  });
});

describe("relationshipEventForSentiment", () => {
  it("jab -> wire_jab, thanks -> wire_praise, neutral -> nothing", () => {
    expect(relationshipEventForSentiment("jab")).toBe("wire_jab");
    expect(relationshipEventForSentiment("thanks")).toBe("wire_praise");
    expect(relationshipEventForSentiment("neutral")).toBeNull();
  });
});

describe("capThreadContext", () => {
  it("leaves a short thread untouched", () => {
    expect(capThreadContext([1, 2, 3], 6)).toEqual([1, 2, 3]);
  });

  it("keeps the most recent turns when the thread runs long", () => {
    const turns = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(capThreadContext(turns, 3)).toEqual([6, 7, 8]);
  });

  it("does not mutate the input array", () => {
    const turns = [1, 2, 3];
    const capped = capThreadContext(turns, 2);
    expect(turns).toEqual([1, 2, 3]);
    expect(capped).toEqual([2, 3]);
  });
});
