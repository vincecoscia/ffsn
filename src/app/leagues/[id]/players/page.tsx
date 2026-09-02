"use client";

import React, { useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { useDraftStatus } from "@/hooks/use-draft-status";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertCircle, TrendingUp, TrendingDown, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, SectionHeader, StatBlock, LoadingScreen, EmptyState, Spinner, Chip } from "@/components/broadcast";

interface PlayersPageProps {
  params: Promise<{ id: string }>;
}

interface Player {
  espnId: string;
  fullName: string;
  defaultPosition: string;
  proTeamAbbrev: string;
  ownerTeamId?: string;
  ownerTeamName?: string;
  injured?: boolean;
  injuryStatus?: string;
  active?: boolean;
  stats: {
    actualTotal: number;
    actualAverage: number;
    projectedTotal?: number;
  };
  hasLeagueSpecificStats?: boolean;
}

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"];

interface DraftBoardPlayer {
  espnId: string;
  fullName: string;
  defaultPosition: string;
  proTeamAbbrev?: string;
  injured: boolean;
  injuryStatus?: string;
  adp: number;
  percentOwned: number;
  auctionValue?: number;
  espnRank?: number;
  projectedTotal?: number;
}

const DRAFT_BOARD_PAGE = 100;

/**
 * Pre-draft view: the whole player pool in ESPN average-draft-position order,
 * paginated from `players.getDraftBoard`. Also feeds the per-position
 * "top of the board" strip via `onLoaded`.
 */
function DraftBoardTab({
  leagueId,
  seasonId,
  selectedPosition,
  rankLabel,
  onLoaded,
}: {
  leagueId: Id<"leagues">;
  seasonId: number;
  selectedPosition: string;
  rankLabel: string;
  onLoaded?: (players: DraftBoardPlayer[]) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.players.getDraftBoard,
    { leagueId, seasonId, position: selectedPosition === "ALL" ? undefined : selectedPosition },
    { initialNumItems: DRAFT_BOARD_PAGE }
  );

  React.useEffect(() => {
    onLoaded?.(results);
  }, [results, onLoaded]);

  if (status === "LoadingFirstPage") {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <EmptyState
        icon={<AlertCircle className="size-6" strokeWidth={1.8} />}
        title="No draft rankings yet"
        description="ESPN has not published average draft positions for this season, or the player pool has not synced."
      />
    );
  }

  const hasAuction = results.some((p) => (p.auctionValue ?? 0) > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-bc-hairline hover:bg-transparent">
              <TableHead className="bc-label-sm w-10 text-bc-text-3">#</TableHead>
              <TableHead className="bc-label-sm text-bc-text-3">Player</TableHead>
              <TableHead className="hidden bc-label-sm text-bc-text-3 text-center sm:table-cell">Pos</TableHead>
              <TableHead className="hidden bc-label-sm text-bc-text-3 text-center md:table-cell">Team</TableHead>
              <TableHead className="bc-label-sm text-bc-text-3 text-right">ADP</TableHead>
              <TableHead className="hidden bc-label-sm text-bc-text-3 text-right md:table-cell">{rankLabel}</TableHead>
              <TableHead className="hidden bc-label-sm text-bc-text-3 text-right lg:table-cell">% drafted</TableHead>
              {hasAuction && (
                <TableHead className="hidden bc-label-sm text-bc-text-3 text-right xl:table-cell">Auction</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((player, index) => (
              <TableRow key={player.espnId} className="border-bc-hairline hover:bg-bc-panel-2">
                <TableCell>
                  <span className="bc-num text-bc-text-2">{index + 1}</span>
                </TableCell>
                <TableCell className="max-w-[180px] sm:max-w-none">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-bc-ink">{player.fullName}</span>
                    {/* Position and team ride with the name on phones, where their columns are hidden. */}
                    <span className="bc-label-sm flex-none text-bc-text-3 sm:hidden">
                      {player.defaultPosition}
                      {player.proTeamAbbrev ? ` · ${player.proTeamAbbrev}` : ""}
                    </span>
                    {player.injured && (
                      <Badge variant="destructive">{player.injuryStatus || "INJ"}</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden text-center sm:table-cell">
                  <Badge variant="secondary">{player.defaultPosition}</Badge>
                </TableCell>
                <TableCell className="hidden text-center md:table-cell">
                  <span className="bc-label-sm text-bc-text-3">{player.proTeamAbbrev ?? "FA"}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="bc-num text-bc-ink">{player.adp.toFixed(1)}</span>
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <span className="bc-num text-bc-text-2">{player.espnRank ?? "–"}</span>
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  <span className="bc-label-sm text-bc-text-3">{player.percentOwned.toFixed(1)}%</span>
                </TableCell>
                {hasAuction && (
                  <TableCell className="hidden text-right xl:table-cell">
                    <span className="bc-num text-bc-text-2">
                      {player.auctionValue ? `$${Math.round(player.auctionValue)}` : "–"}
                    </span>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {status !== "Exhausted" && (
        <div className="flex items-center justify-center border-t border-bc-hairline pt-4">
          <Button
            variant="outline"
            onClick={() => loadMore(DRAFT_BOARD_PAGE)}
            disabled={status === "LoadingMore"}
          >
            {status === "LoadingMore" ? <Spinner /> : <ChevronDown className="size-4" strokeWidth={2} />}
            {status === "LoadingMore" ? "Loading" : `Load ${DRAFT_BOARD_PAGE} more`}
          </Button>
        </div>
      )}
    </div>
  );
}

// Free Agents Tab Component
function FreeAgentsTab({
  leagueId,
  seasonId,
  selectedPosition
}: {
  leagueId: Id<"leagues">;
  seasonId: number;
  selectedPosition: string;
}) {
  const freeAgentsData = useQuery(api.players.getFreeAgentsWithStats, {
    leagueId,
    seasonId,
    position: selectedPosition === "ALL" ? undefined : selectedPosition,
    limit: 100
  });

  const freeAgents = React.useMemo(() => freeAgentsData || [], [freeAgentsData]);

  if (!freeAgents.length) {
    return (
      <EmptyState
        icon={<AlertCircle className="size-6" strokeWidth={1.8} />}
        title="No free agents found"
        description={
          selectedPosition === "ALL"
            ? "All available players are currently rostered."
            : `No available ${selectedPosition} players found.`
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-bc-hairline hover:bg-transparent">
            <TableHead className="bc-label-sm text-bc-text-3">Rank</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3">Player</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-center">Pos</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-center sm:table-cell">
              Team
            </TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-right">Points</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right md:table-cell">
              Avg/game
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right lg:table-cell">
              % owned
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {freeAgents.map((player, index) => {
            const avgPoints = player.stats?.actualAverage || 0;

            return (
              <TableRow key={player.espnId} className="border-bc-hairline hover:bg-bc-panel-2">
                <TableCell>
                  <span className="bc-num text-bc-text-2">{index + 1}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-bc-ink">{player.fullName}</span>
                    {player.injured && (
                      <Badge variant="destructive">{player.injuryStatus || "INJ"}</Badge>
                    )}
                    {player.hasLeagueSpecificStats && (
                      <Badge variant="outline">League stats</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Badge variant="secondary">{player.defaultPosition}</Badge>
                </TableCell>
                <TableCell className="hidden text-center sm:table-cell">
                  <span className="bc-label-sm text-bc-text-3">{player.proTeamAbbrev}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="bc-num text-bc-ink">
                    {player.stats?.actualTotal?.toFixed(1) || "0.0"}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <div className="flex items-center justify-end gap-1">
                    <span className="bc-num text-bc-text-2">{avgPoints.toFixed(1)}</span>
                    {avgPoints > 15 ? (
                      <TrendingUp className="size-4 text-bc-win" />
                    ) : avgPoints < 8 ? (
                      <TrendingDown className="size-4 text-bc-red-text" />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  <span className="bc-label-sm text-bc-text-3">
                    {player.ownership?.percentOwned?.toFixed(1) || "0.0"}%
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function PlayerTable({ players }: { players: Player[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-bc-hairline hover:bg-transparent">
            <TableHead className="bc-label-sm text-bc-text-3">Rank</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3">Player</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-center">Pos</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-center sm:table-cell">
              Team
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 md:table-cell">Owner</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-right">Points</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right md:table-cell">
              Avg/game
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {players.map((player, index) => {
            const avgPoints = player.stats?.actualAverage || 0;

            return (
              <TableRow
                key={`${player.espnId}-${player.ownerTeamId}`}
                className="border-bc-hairline hover:bg-bc-panel-2"
              >
                <TableCell>
                  <span className="bc-num text-bc-text-2">{index + 1}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-bc-ink">{player.fullName}</span>
                    {player.injured && (
                      <Badge variant="destructive">{player.injuryStatus || "INJ"}</Badge>
                    )}
                    {player.hasLeagueSpecificStats && (
                      <Badge variant="outline">League stats</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Badge variant="secondary">{player.defaultPosition}</Badge>
                </TableCell>
                <TableCell className="hidden text-center sm:table-cell">
                  <span className="bc-label-sm text-bc-text-3">{player.proTeamAbbrev}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="bc-label-sm text-bc-text-2">{player.ownerTeamName}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="bc-num text-bc-ink">
                    {player.stats?.actualTotal?.toFixed(1) || "0.0"}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <div className="flex items-center justify-end gap-1">
                    <span className="bc-num text-bc-text-2">{avgPoints.toFixed(1)}</span>
                    {avgPoints > 15 ? (
                      <TrendingUp className="size-4 text-bc-win" />
                    ) : avgPoints < 8 ? (
                      <TrendingDown className="size-4 text-bc-red-text" />
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function PlayersPage({ params }: PlayersPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();

  // Get current/available seasons for the league
  const { currentSeason, availableSeasons, isLoading: isSeasonLoading } = useLeagueSeason(leagueId);

  const [selectedSeason, setSelectedSeason] = useState(currentSeason);
  const [selectedPosition, setSelectedPosition] = useState("ALL");

  // Sync the selected season once the real current season resolves
  const hasSyncedSeason = React.useRef(false);
  React.useEffect(() => {
    if (!isSeasonLoading && !hasSyncedSeason.current) {
      hasSyncedSeason.current = true;
      setSelectedSeason(currentSeason);
    }
  }, [isSeasonLoading, currentSeason]);

  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });

  // Before the draft the page is a draft board (ADP order); afterwards it is
  // the performers view. Follows the selected season so past seasons still
  // show their results.
  const { isDraftComplete, isLoading: draftLoading } = useDraftStatus(leagueId, selectedSeason);
  const preDraft = !draftLoading && !isDraftComplete;
  const rankLabel = league?.settings.scoringType?.toLowerCase().includes("ppr") ? "PPR rank" : "STD rank";

  // Top of the draft board per position, derived from the loaded ADP rows.
  const [boardTop, setBoardTop] = useState<Map<string, DraftBoardPlayer>>(new Map());
  const handleBoardLoaded = React.useCallback((players: DraftBoardPlayer[]) => {
    const top = new Map<string, DraftBoardPlayer>();
    players.forEach((p) => {
      if (!top.has(p.defaultPosition)) top.set(p.defaultPosition, p);
    });
    setBoardTop(top);
  }, []);

  // Get top performers using the optimized query (more players per position)
  const topPerformersData = useQuery(api.players.getTopPerformersByPosition, {
    leagueId,
    seasonId: selectedSeason,
    limit: 10 // Get top 10 per position instead of just 1
  });

  // Get single top performer per position for the summary cards
  const topPerformersSummaryData = useQuery(api.players.getTopPerformersByPosition, {
    leagueId,
    seasonId: selectedSeason,
    limit: 1
  });

  // Convert top performers data to a flat array for filtering
  const allTopPerformers = React.useMemo(() => {
    if (!topPerformersData) return [];

    const players: Player[] = [];
    Object.entries(topPerformersData).forEach(([, positionPlayers]) => {
      if (Array.isArray(positionPlayers)) {
        players.push(...(positionPlayers as Player[]));
      }
    });

    return players;
  }, [topPerformersData]);

  // Filter top performers by position
  const filteredPlayers = React.useMemo(() => {
    let filtered = allTopPerformers;

    if (selectedPosition !== "ALL") {
      filtered = filtered.filter(player => player.defaultPosition === selectedPosition);
    }

    // Already sorted by points in the query, but ensure consistency
    return filtered.sort((a, b) => {
      const aPoints = a.stats?.actualTotal || 0;
      const bPoints = b.stats?.actualTotal || 0;
      return bPoints - aPoints;
    });
  }, [allTopPerformers, selectedPosition]);

  // Group top performers by position for position view
  const playersByPosition = React.useMemo(() => {
    const grouped = new Map<string, Player[]>();

    if (topPerformersData) {
      Object.entries(topPerformersData).forEach(([position, players]) => {
        if (Array.isArray(players)) {
          grouped.set(position, players as Player[]);
        }
      });
    }

    return grouped;
  }, [topPerformersData]);

  // Convert top performers summary data to Map for summary cards
  const topPerformers = React.useMemo(() => {
    const top = new Map<string, Player>();

    if (topPerformersSummaryData) {
      Object.entries(topPerformersSummaryData).forEach(([position, players]) => {
        if (Array.isArray(players) && players.length > 0) {
          top.set(position, players[0] as Player);
        }
      });
    }

    return top;
  }, [topPerformersSummaryData]);

  if (!userId || !league || draftLoading) {
    return <LoadingScreen message="Loading players" />;
  }

  return (
    <LeaguePageLayout
      leagueId={leagueId}
      currentUserId={userId}
      title="Players"
    >
      <Panel padding="md">
        <SectionHeader
          title={preDraft ? "Draft board" : "Players"}
          kicker={preDraft ? `${selectedSeason} season · Average draft position` : `${selectedSeason} season`}
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <Select value={selectedPosition} onValueChange={setSelectedPosition}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="All positions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All positions</SelectItem>
                  {POSITIONS.map((pos) => (
                    <SelectItem key={pos} value={pos}>
                      {pos}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <SeasonSelector
                currentSeason={currentSeason}
                selectedSeason={selectedSeason}
                onSeasonChange={setSelectedSeason}
                availableSeasons={availableSeasons}
              />
            </div>
          }
        />

        {/* Pre-draft: the whole pool in ADP order */}
        {preDraft && (
          <div className="mt-6 flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="bc-label-sm text-bc-text-3">Top of the board by position</span>
                <Chip variant="signal" live>Pre-draft</Chip>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                {POSITIONS.map((position) => {
                  const topPlayer = boardTop.get(position);
                  return (
                    <div key={position} className="border border-bc-hairline bg-bc-ground p-3">
                      <span className="bc-label-sm text-bc-text-3">{position}</span>
                      {topPlayer ? (
                        <div className="mt-2 flex flex-col gap-1">
                          <div className="truncate font-display text-[14px] font-bold uppercase leading-none text-bc-ink">
                            {topPlayer.fullName}
                          </div>
                          <div className="truncate bc-label-sm text-bc-text-3">{topPlayer.proTeamAbbrev ?? "FA"}</div>
                          <StatBlock className="mt-1" label="ADP" value={topPlayer.adp.toFixed(1)} />
                        </div>
                      ) : (
                        <div className="mt-2 bc-label-sm text-bc-text-3">No players</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="border border-bc-signal bg-bc-ground p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="size-1.5 flex-none bg-bc-signal" aria-hidden="true" />
                <span className="bc-label-sm text-bc-signal">Draft board</span>
              </div>
              <p className="text-sm text-bc-text-2">
                Every player in the {selectedSeason} pool, ordered by ESPN average draft position. Performance
                tabs open once the league has drafted.
              </p>
            </div>
            <DraftBoardTab
              leagueId={leagueId}
              seasonId={selectedSeason}
              selectedPosition={selectedPosition}
              rankLabel={rankLabel}
              onLoaded={handleBoardLoaded}
            />
          </div>
        )}

        {/* Top Performers Summary */}
        {!preDraft && (
        <div className="mt-6 flex flex-col gap-3">
          <span className="bc-label-sm text-bc-text-3">Top performers by position</span>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {POSITIONS.map(position => {
              const topPlayer = topPerformers.get(position);
              return (
                <div key={position} className="border border-bc-hairline bg-bc-ground p-3">
                  <span className="bc-label-sm text-bc-text-3">{position}</span>
                  {topPlayer ? (
                    <div className="mt-2 flex flex-col gap-1">
                      <div className="truncate font-display text-[14px] font-bold uppercase leading-none text-bc-ink">
                        {topPlayer.fullName}
                      </div>
                      <div className="truncate bc-label-sm text-bc-text-3">
                        {topPlayer.ownerTeamName}
                      </div>
                      <StatBlock
                        className="mt-1"
                        label={topPlayer.hasLeagueSpecificStats ? "League scoring" : "Points"}
                        value={topPlayer.stats?.actualTotal?.toFixed(1) || "0.0"}
                      />
                    </div>
                  ) : (
                    <div className="mt-2 bc-label-sm text-bc-text-3">No players</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        )}

        {/* Player Tables */}
        {!preDraft && (
        <Tabs defaultValue="top-performers" className="mt-6 w-full gap-5">
          <TabsList>
            <TabsTrigger value="top-performers">Top performers</TabsTrigger>
            <TabsTrigger value="by-position">By position</TabsTrigger>
            <TabsTrigger value="free-agents">Free agents</TabsTrigger>
            <TabsTrigger value="draft-board">Draft board</TabsTrigger>
          </TabsList>

          <TabsContent value="top-performers" className="flex flex-col gap-4">
            <div className="border border-bc-signal bg-bc-ground p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="size-1.5 flex-none bg-bc-signal" aria-hidden="true" />
                <span className="bc-label-sm text-bc-signal">League top performers</span>
              </div>
              <p className="text-sm text-bc-text-2">
                Showing the top 10 performers in each position based on league-specific scoring rules.
              </p>
            </div>
            <PlayerTable players={filteredPlayers} />
          </TabsContent>

          <TabsContent value="by-position">
            <div className="flex flex-col gap-8">
              {POSITIONS.map(position => {
                const positionPlayers = playersByPosition.get(position) || [];
                return (
                  <div key={position} className="flex flex-col gap-3">
                    <div>
                      <span className="bc-h-title text-[20px]">
                        Top {position} players ({positionPlayers.length} shown)
                      </span>
                      <p className="bc-label-sm mt-1.5 text-bc-text-3">
                        Ranked by total fantasy points using league scoring rules
                      </p>
                    </div>
                    <PlayerTable players={positionPlayers} />
                  </div>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="free-agents">
            <FreeAgentsTab
              leagueId={leagueId}
              seasonId={selectedSeason}
              selectedPosition={selectedPosition}
            />
          </TabsContent>

          <TabsContent value="draft-board">
            <DraftBoardTab
              leagueId={leagueId}
              seasonId={selectedSeason}
              selectedPosition={selectedPosition}
              rankLabel={rankLabel}
            />
          </TabsContent>
        </Tabs>
        )}
      </Panel>
    </LeaguePageLayout>
  );
}
