"use client";

import type { ReactNode } from "react";
import { ChevronDown, Trophy } from "lucide-react";

import {
  Panel,
  SectionHeader,
  ScoreBug,
  TeamTile,
  RankPlate,
  StatBlock,
  EmptyState,
} from "@/components/broadcast";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type {
  PlayoffContext,
  BracketRound,
  BracketGame,
  BracketTeam,
  BracketSide,
} from "../../../convex/lib/playoffTypes";

export interface PlayoffBracketProps {
  context: PlayoffContext;
  /**
   * The season this bracket belongs to - not part of `PlayoffContext` (the shared E/F/G contract
   * in `convex/lib/playoffTypes.ts`, kept untouched by this component), only needed here for the
   * champion banner headline ("2025 Champion").
   */
  seasonId: number;
  /**
   * Projected mode only: renders as a disclosure (the header becomes the trigger, collapsing to a
   * one-line "who's in" summary). Ignored once the playoffs are under way - the live/final bracket
   * is always shown in full, per the owner's ask that playoff time "look different and special".
   */
  collapsible?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Matches `src/app/leagues/[id]/schedule/page.tsx`'s `initialsFor` - `BracketTeam`/`BracketSide` carry no abbreviation, only a name. */
function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function formatScore(score: number | undefined): string | undefined {
  return typeof score === "number" ? score.toFixed(1) : undefined;
}

function SeedRow({ team, dimmed }: { team: BracketTeam; dimmed?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-bc-hairline py-2.5 first:border-t-0",
        dimmed && "opacity-60"
      )}
    >
      <RankPlate rank={team.seed} tone={team.seed === 1 ? "first" : "default"} />
      <TeamTile initials={initialsFromName(team.name)} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">
          {team.name}
        </span>
        <span className="bc-label-sm text-bc-text-3">{team.record}</span>
      </div>
      <StatBlock label="PF" value={team.pointsFor.toFixed(1)} align="right" />
    </div>
  );
}

/** A round-one rest: `BracketGame.bye` rather than a two-sided game. */
function ByeSlot({ bye }: { bye: NonNullable<BracketGame["bye"]> }) {
  return (
    <div className="flex flex-col border border-bc-hairline bg-bc-ground">
      <div className="bc-label-sm flex h-6 items-center bg-bc-panel-2 px-3 text-bc-text-3">
        <span>Bye</span>
      </div>
      <div className="flex min-h-[42px] items-center gap-3 border-t border-bc-hairline px-3 py-1.5">
        <RankPlate rank={bye.seed} tone={bye.seed === 1 ? "first" : "default"} />
        <TeamTile initials={initialsFromName(bye.name)} size={32} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">
            {bye.name}
          </span>
          <span className="bc-label-sm text-[10px] text-bc-text-3">Rests · advances</span>
        </div>
      </div>
    </div>
  );
}

/** A slot whose feeder games haven't been decided yet - `home`/`away` are absent. */
function TbdSlot() {
  return (
    <div className="flex min-h-[97px] flex-col items-center justify-center border border-dashed border-bc-hairline bg-bc-ground">
      <span className="bc-label-sm text-bc-text-3">TBD</span>
    </div>
  );
}

function seedPlate(side: BracketSide) {
  return (
    <RankPlate
      rank={side.seed ?? "-"}
      tone={side.seed === 1 ? "first" : "default"}
      className="size-7 text-[13px]"
    />
  );
}

/** One bracket game, reused by the projected round-one preview, the full bracket and the consolation panels. */
function GameCard({ game }: { game: BracketGame }) {
  if (game.status === "bye" && game.bye) {
    return <ByeSlot bye={game.bye} />;
  }
  if (!game.home || !game.away) {
    return <TbdSlot />;
  }

  return (
    <ScoreBug
      // "final" gets the winner/loser treatment; every other status (live, scheduled) renders at
      // full weight with no winner marker - nothing has been decided, so nobody reads as dimmed.
      mode={game.status === "final" ? "final" : "live"}
      home={{
        leading: seedPlate(game.home),
        name: game.home.name,
        score: formatScore(game.home.score),
        winner: !!game.winnerTeamId && game.winnerTeamId === game.home.teamId,
      }}
      away={{
        leading: seedPlate(game.away),
        name: game.away.name,
        score: formatScore(game.away.score),
        winner: !!game.winnerTeamId && game.winnerTeamId === game.away.teamId,
      }}
    />
  );
}

function RoundColumn({ round, championshipWeek }: { round: BracketRound; championshipWeek: number }) {
  return (
    <div className="flex w-[260px] flex-none flex-col gap-3">
      <div className="flex items-baseline gap-2 border-b-2 border-bc-hairline pb-2">
        <span className="bc-label text-bc-ink">{round.name}</span>
        <span className="bc-label-sm text-bc-text-3">Wk {round.week}</span>
      </div>
      <div className="flex flex-1 flex-col justify-around gap-5">
        {round.games.map((game, index) => {
          const isChampionship = game.week === championshipWeek && game.tier === "WINNERS_BRACKET";
          return (
            <div key={`${game.week}-${game.tier}-${index}`} className="flex flex-col gap-1.5">
              {isChampionship && (
                <div className="flex items-center gap-2">
                  <span className="h-[3px] w-6 flex-none bg-bc-red" aria-hidden="true" />
                  <span className="bc-label-sm text-bc-red-text">Championship</span>
                </div>
              )}
              <div className={cn(isChampionship && "border border-bc-red p-1.5")}>
                <GameCard game={game} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConsolationSection({ games }: { games: BracketGame[] }) {
  if (games.length === 0) return null;

  const thirdPlaceLadder = games.filter((g) => g.tier === "WINNERS_CONSOLATION_LADDER");
  const consolationLadder = games.filter((g) => g.tier === "LOSERS_CONSOLATION_LADDER");

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {thirdPlaceLadder.length > 0 && (
        <Panel padding="sm">
          <SectionHeader size="sm" title="Third-place ladder" />
          <div className="mt-3 flex flex-col gap-2.5">
            {thirdPlaceLadder.map((game, index) => (
              <GameCard key={`${game.week}-${index}`} game={game} />
            ))}
          </div>
        </Panel>
      )}
      {consolationLadder.length > 0 && (
        <Panel padding="sm">
          <SectionHeader size="sm" title="Consolation ladder" />
          <div className="mt-3 flex flex-col gap-2.5">
            {consolationLadder.map((game, index) => (
              <GameCard key={`${game.week}-${index}`} game={game} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function ChampionBanner({
  champion,
  runnerUp,
  seasonId,
}: {
  champion: BracketTeam;
  runnerUp?: BracketTeam;
  seasonId: number;
}) {
  return (
    <Panel padding="lg" className="relative overflow-hidden border-bc-red">
      <span className="absolute inset-x-0 top-0 h-1 bg-bc-red" aria-hidden="true" />
      <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
        <TeamTile initials={initialsFromName(champion.name)} size={64} tone="accent" />
        <div className="flex flex-col gap-1">
          <span className="bc-label-sm text-bc-red-text">{seasonId} Champion</span>
          <h2 className="font-display text-[28px] font-extrabold uppercase leading-none tracking-[0.01em] text-bc-ink sm:text-[34px]">
            {champion.name}
          </h2>
          <span className="bc-label-sm text-bc-text-3">
            Seed {champion.seed} · {champion.record}
            {runnerUp && ` · beat ${runnerUp.name}`}
          </span>
        </div>
        <Trophy className="ml-auto hidden size-12 flex-none text-bc-red sm:block" strokeWidth={1.5} aria-hidden="true" />
      </div>
    </Panel>
  );
}

function ProjectedPicture({
  context,
  collapsible,
  open,
  onOpenChange,
  className,
}: {
  context: PlayoffContext;
  collapsible?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const round1 = context.bracket[0];
  const isOpen = collapsible ? !!open : true;

  const actions: ReactNode = collapsible ? (
    <span className="flex items-center gap-3">
      {!isOpen && (
        <span className="bc-label-sm hidden max-w-[42vw] truncate text-bc-text-3 sm:inline">
          Top {context.seeds.length} if the season ended today: {context.seeds.map((t) => t.name).join(", ")}
        </span>
      )}
      <ChevronDown
        className={cn("size-4 flex-none text-bc-text-3 transition-transform", isOpen && "rotate-180")}
        aria-hidden="true"
      />
    </span>
  ) : undefined;

  const header = <SectionHeader title="Playoff picture" kicker="If the season ended today" actions={actions} />;

  const body = (
    <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_auto]">
      <div className="flex flex-col">
        {context.seeds.map((team) => (
          <SeedRow key={team.teamId} team={team} />
        ))}
        {context.bubble.length > 0 && (
          <>
            <div className="mt-2 border-t border-dashed border-bc-hairline pt-2">
              <span className="bc-label-sm text-bc-text-3">Next out</span>
            </div>
            {context.bubble.map((team) => (
              <SeedRow key={team.teamId} team={team} dimmed />
            ))}
          </>
        )}
      </div>
      {round1 && (
        <div className="flex flex-col gap-3 lg:w-[280px]">
          <span className="bc-label-sm text-bc-text-3">
            Round 1 · Week {round1.week}
          </span>
          <div className="flex flex-col gap-3">
            {round1.games.map((game, index) => (
              <GameCard key={`${game.week}-${index}`} game={game} />
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (!collapsible) {
    return (
      <Panel padding="md" className={className}>
        {header}
        {body}
      </Panel>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <Panel padding="md" className={className}>
        <CollapsibleTrigger asChild>
          <button type="button" className="block w-full text-left">
            {header}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{body}</CollapsibleContent>
      </Panel>
    </Collapsible>
  );
}

function FullBracket({
  context,
  seasonId,
  className,
}: {
  context: PlayoffContext;
  seasonId: number;
  className?: string;
}) {
  const isFinal = context.mode === "final";

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {isFinal && context.champion && (
        <ChampionBanner champion={context.champion} runnerUp={context.runnerUp} seasonId={seasonId} />
      )}
      <Panel padding="md">
        <SectionHeader
          title="Playoffs"
          kicker={
            isFinal
              ? "Season complete"
              : context.currentRound
                ? `${context.currentRound.name} · Week ${context.currentRound.week}`
                : undefined
          }
        />
        <div className="mt-4 overflow-x-auto">
          <div className="flex gap-6 pb-2">
            {context.bracket.map((round) => (
              <RoundColumn key={round.week} round={round} championshipWeek={context.championshipWeek} />
            ))}
          </div>
        </div>
      </Panel>
      {context.consolation.length > 0 && <ConsolationSection games={context.consolation} />}
    </div>
  );
}

/**
 * The playoff picture / bracket for the schedule page (owner's ask, brief-playoffs-common.md):
 * "if the season ended today" during the regular season, a full bracket once the playoffs start,
 * a champion banner once the title is decided. Presentational - feed it `PlayoffContext` straight
 * from `api.matchups.getPlayoffBracket`.
 */
export function PlayoffBracket({
  context,
  seasonId,
  collapsible,
  open,
  onOpenChange,
  className,
}: PlayoffBracketProps) {
  if (context.seeds.length === 0) {
    return (
      <EmptyState
        icon={<Trophy className="size-6" strokeWidth={1.8} />}
        title="Playoff picture appears once the season starts"
        description="Check back after Week 1 kicks off."
        className={className}
      />
    );
  }

  if (context.mode === "projected") {
    return (
      <ProjectedPicture
        context={context}
        collapsible={collapsible}
        open={open}
        onOpenChange={onOpenChange}
        className={className}
      />
    );
  }

  return <FullBracket context={context} seasonId={seasonId} className={className} />;
}
