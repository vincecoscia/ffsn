import React from 'react';
import { RankPlate, TeamTile } from '@/components/broadcast';

interface Team {
  _id: string;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  externalId: string;
  record: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor?: number;
    pointsAgainst?: number;
  };
}

interface DraftSettings {
  availableDate?: number;
  date?: number;
  pickOrder?: number[];
  type?: string;
  orderType?: string;
}

interface DraftOrderDisplayProps {
  teams: Team[];
  draftSettings: DraftSettings;
}

function initialsFor(team: Team): string {
  if (team.abbreviation) return team.abbreviation.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function DraftOrderDisplay({ teams, draftSettings }: DraftOrderDisplayProps) {
  // Create a map for quick team lookup by external ID (convert to string for comparison)
  const teamMap = React.useMemo(() => {
    const map = new Map<string, Team>();
    teams.forEach(team => {
      map.set(team.externalId, team);
    });
    return map;
  }, [teams]);

  const getTeamByExternalId = (externalId: number | string): Team | null => {
    return teamMap.get(String(externalId)) || null;
  };

  if (!draftSettings.pickOrder || draftSettings.pickOrder.length === 0) {
    return (
      <p className="text-[15px] text-bc-text-2">Draft order not available.</p>
    );
  }

  const draftDate = draftSettings.availableDate ? new Date(draftSettings.availableDate) : null;

  return (
    <div className="flex flex-col gap-4">
      {draftDate && (
        <span className="bc-label-sm text-bc-text-3">
          {draftDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
        </span>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {draftSettings.pickOrder.map((externalId, index) => {
          const team = getTeamByExternalId(externalId);
          const rank = index + 1;

          if (!team) {
            return (
              <div
                key={index}
                className="flex items-center gap-3 border border-bc-hairline bg-bc-panel-2 p-3"
              >
                <RankPlate rank={rank} />
                <div className="flex flex-col">
                  <span className="bc-label-sm text-bc-text-3">Team not found</span>
                  <span className="text-[13px] text-bc-text-3">ID: {externalId}</span>
                </div>
              </div>
            );
          }

          return (
            <div
              key={team._id}
              className="flex items-center gap-3 border border-bc-hairline bg-bc-ground p-3"
            >
              <RankPlate rank={rank} tone={rank === 1 ? "first" : "default"} />
              <TeamTile initials={initialsFor(team)} size={36} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-display text-[16px] font-bold uppercase tracking-[0.02em] text-bc-ink">
                  {team.name}
                </span>
                <span className="bc-label-sm text-bc-text-3">
                  {team.record.wins}-{team.record.losses}
                  {team.record.ties > 0 && `-${team.record.ties}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {(draftSettings.type || draftSettings.orderType) && (
        <div className="flex items-center gap-3 border-t border-bc-hairline pt-3">
          {draftSettings.type && (
            <span className="bc-label-sm text-bc-text-3">
              Type <span className="text-bc-ink">{draftSettings.type}</span>
            </span>
          )}
          {draftSettings.orderType && (
            <span className="bc-label-sm text-bc-text-3">
              Order <span className="text-bc-ink">{draftSettings.orderType}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
