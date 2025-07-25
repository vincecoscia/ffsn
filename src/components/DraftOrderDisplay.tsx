import React from 'react';

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
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Draft Information</h2>
        <p className="text-gray-500">Draft order not available.</p>
      </div>
    );
  }

  const draftDate = draftSettings.availableDate ? new Date(draftSettings.availableDate) : null;

  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-900">Draft Order - Round 1</h2>
        <div className="text-right">
          {draftDate && (
            <div className="text-xs text-gray-600">
              {draftDate.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}
            </div>
          )}
          {draftSettings.type && (
            <div className="text-xs text-blue-600 font-medium uppercase">
              {draftSettings.type} Draft
            </div>
          )}
        </div>
      </div>
      
      {/* Horizontal scrollable grid of draft pick cards */}
      <div className="overflow-x-auto">
        <div className="flex space-x-3 pb-2" style={{ minWidth: 'fit-content' }}>
          {draftSettings.pickOrder.map((externalId, index) => {
            const team = getTeamByExternalId(externalId);
            
            if (!team) {
              return (
                <div key={index} className="flex-shrink-0 w-48 border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="text-center">
                    <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center text-sm font-bold text-gray-600 mx-auto mb-2">
                      {index + 1}
                    </div>
                    <div className="text-xs text-gray-500">Team not found</div>
                    <div className="text-xs text-gray-400">ID: {externalId}</div>
                  </div>
                </div>
              );
            }

            const isTopPick = index < 3; // Highlight top 3 picks

            return (
              <div key={team._id} className={`flex-shrink-0 w-48 border rounded-lg p-3 hover:shadow-md transition-all ${
                isTopPick 
                  ? 'border-blue-300 bg-blue-50' 
                  : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}>
                {/* Pick Number Badge */}
                <div className="text-center mb-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold mx-auto ${
                    isTopPick 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-gray-600 text-white'
                  }`}>
                    {index + 1}
                  </div>
                </div>
                
                {/* Team Info */}
                <div className="text-center">
                  <div className={`text-sm font-medium mb-1 ${
                    isTopPick ? 'text-blue-900' : 'text-gray-900'
                  }`}>
                    {team.name}
                  </div>
                  {team.abbreviation && (
                    <div className="text-xs text-gray-500 mb-2">
                      {team.abbreviation}
                    </div>
                  )}
                  <div className="text-xs text-gray-400">
                    {team.record.wins}-{team.record.losses}
                    {team.record.ties > 0 && `-${team.record.ties}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Draft Details Footer */}
      {(draftSettings.type || draftSettings.orderType) && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center justify-center space-x-4 text-xs text-gray-500">
            {draftSettings.type && (
              <span>Type: <span className="font-medium text-gray-700">{draftSettings.type}</span></span>
            )}
            {draftSettings.orderType && (
              <span>Order: <span className="font-medium text-gray-700">{draftSettings.orderType}</span></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}