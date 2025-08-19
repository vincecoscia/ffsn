import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

export const getTransactionsBySeason = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { leagueId, seasonId } = args;

    // Get all transactions for the league
    let transactionsQuery = ctx.db
      .query("transactions")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId));

    // Filter by season if provided
    if (seasonId !== undefined) {
      transactionsQuery = ctx.db
        .query("transactions")
        .withIndex("by_season", (q) => 
          q.eq("leagueId", leagueId).eq("seasonId", seasonId)
        );
    }

    const transactions = await transactionsQuery.collect();

    // Get all unique seasons from transactions
    const seasonsInTransactions = new Set<number>();
    transactions.forEach(transaction => {
      seasonsInTransactions.add(transaction.seasonId);
    });

    console.log(`Seasons with transaction data: ${Array.from(seasonsInTransactions).sort((a, b) => b - a).join(', ')}`);

    // Get teams for all seasons represented in transactions
    const teams = await Promise.all(
      Array.from(seasonsInTransactions).map(async (season) => {
        return await ctx.db
          .query("teams")
          .withIndex("by_season", (q) => 
            q.eq("leagueId", leagueId).eq("seasonId", season)
          )
          .collect();
      })
    );

    // Flatten teams array and create a map with season-specific team info
    const flatTeams = teams.flat();
    const teamMap = new Map(
      flatTeams.map(team => [`${team.externalId}:${team.seasonId}`, {
        name: team.name,
        abbreviation: team.abbreviation,
        owner: team.owner,
        logo: team.logo,
        customLogo: team.customLogo,
        _id: team._id,
        seasonId: team.seasonId
      }])
    );

    // Get all players involved in transactions with their seasons
    const playerSeasonPairs = new Set<string>();
    transactions.forEach(transaction => {
      transaction.items.forEach(item => {
        const key = `${item.playerId}:${transaction.seasonId}`;
        playerSeasonPairs.add(key);
      });
    });

    // Fetch player information from playersEnhanced
    const players = await Promise.all(
      Array.from(playerSeasonPairs).map(async (playerSeasonKey) => {
        const [playerId, seasonId] = playerSeasonKey.split(':');
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", parseInt(seasonId))
          )
          .first();
        return player ? { [playerId]: player } : null;
      })
    );

    console.log(`Found ${playerSeasonPairs.size} unique player-season pairs, resolved ${players.filter(p => p !== null).length} players`);

    const playerMap = new Map(
      players
        .filter(p => p !== null)
        .map(p => [Object.keys(p!)[0], Object.values(p!)[0]])
    );


    // Format transactions with team and player info
    const formattedTransactions = transactions.map(transaction => {
      const formattedItems = transaction.items.map(item => {
        const player = playerMap.get(item.playerId.toString());
        const fromTeam = item.fromTeamId !== 0 
          ? teamMap.get(`${item.fromTeamId}:${transaction.seasonId}`) 
          : null;
        const toTeam = item.toTeamId !== 0 
          ? teamMap.get(`${item.toTeamId}:${transaction.seasonId}`) 
          : null;

        return {
          ...item,
          player: player ? {
            name: player.fullName,
            position: player.defaultPosition,
            team: player.proTeamAbbrev || 'FA',
          } : null,
          fromTeam,
          toTeam,
        };
      });

      // Get the primary team involved
      const primaryTeam = teamMap.get(`${transaction.teamId}:${transaction.seasonId}`);

      return {
        ...transaction,
        items: formattedItems,
        primaryTeam,
      };
    });

    // Group by season and sort by date
    const groupedBySeasons = formattedTransactions.reduce((acc, transaction) => {
      const season = transaction.seasonId;
      if (!acc[season]) {
        acc[season] = [];
      }
      acc[season].push(transaction);
      return acc;
    }, {} as Record<number, typeof formattedTransactions>);

    // Sort each season's transactions by date (newest first)
    Object.keys(groupedBySeasons).forEach(season => {
      groupedBySeasons[Number(season)].sort((a, b) => 
        b.proposedDate - a.proposedDate
      );
    });

    return {
      transactions: formattedTransactions,
      groupedBySeasons,
      seasons: Object.keys(groupedBySeasons).map(Number).sort((a, b) => b - a),
    };
  },
});

// Get paginated transactions for a specific week (excludes DRAFT and ROSTER types)
export const getTransactionsByWeek = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    scoringPeriod: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { leagueId, seasonId, scoringPeriod, limit = 50 } = args;

    // Get transactions for specific week, excluding draft and roster types
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_scoring_period", (q) => 
        q.eq("leagueId", leagueId)
         .eq("seasonId", seasonId)
         .eq("scoringPeriod", scoringPeriod)
      )
      .filter((q) => 
        q.and(
          q.neq(q.field("type"), "DRAFT"),
          q.neq(q.field("type"), "ROSTER")
        )
      )
      .order("desc")
      .take(limit);

    if (transactions.length === 0) {
      return {
        transactions: [],
        hasMore: false,
        nextCursor: null,
      };
    }

    // Get teams for this season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", leagueId).eq("seasonId", seasonId)
      )
      .collect();

    const teamMap = new Map(
      teams.map(team => [`${team.externalId}:${team.seasonId}`, {
        name: team.name,
        abbreviation: team.abbreviation,
        owner: team.owner,
        logo: team.logo,
        customLogo: team.customLogo,
        _id: team._id,
        seasonId: team.seasonId
      }])
    );

    // Get all players involved in these transactions
    const playerSeasonPairs = new Set<string>();
    transactions.forEach(transaction => {
      transaction.items.forEach(item => {
        const key = `${item.playerId}:${transaction.seasonId}`;
        playerSeasonPairs.add(key);
      });
    });

    // Fetch player information
    const players = await Promise.all(
      Array.from(playerSeasonPairs).map(async (playerSeasonKey) => {
        const [playerId, seasonId] = playerSeasonKey.split(':');
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", parseInt(seasonId))
          )
          .first();
        return player ? { [playerId]: player } : null;
      })
    );

    const playerMap = new Map(
      players
        .filter(p => p !== null)
        .map(p => [Object.keys(p!)[0], Object.values(p!)[0]])
    );

    // Format transactions with team and player info
    const formattedTransactions = transactions.map(transaction => {
      const formattedItems = transaction.items.map(item => {
        const player = playerMap.get(item.playerId.toString());
        const fromTeam = item.fromTeamId !== 0 
          ? teamMap.get(`${item.fromTeamId}:${transaction.seasonId}`) 
          : null;
        const toTeam = item.toTeamId !== 0 
          ? teamMap.get(`${item.toTeamId}:${transaction.seasonId}`) 
          : null;

        return {
          ...item,
          player: player ? {
            name: player.fullName,
            position: player.defaultPosition,
            team: player.proTeamAbbrev || 'FA',
          } : null,
          fromTeam,
          toTeam,
        };
      });

      const primaryTeam = teamMap.get(`${transaction.teamId}:${transaction.seasonId}`);

      return {
        ...transaction,
        items: formattedItems,
        primaryTeam,
      };
    });

    // Sort by date (newest first)
    formattedTransactions.sort((a, b) => b.proposedDate - a.proposedDate);

    return {
      transactions: formattedTransactions,
      hasMore: transactions.length === limit,
      nextCursor: transactions.length === limit ? transactions[transactions.length - 1]._id : null,
    };
  },
});

// Get available weeks with transaction data for a season
export const getAvailableWeeks = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    const { leagueId, seasonId } = args;

    // Get all transactions for the season
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", leagueId).eq("seasonId", seasonId)
      )
      .collect();

    // Get unique weeks and count transactions per week
    const weekCounts = new Map<number, { total: number; trades: number; draft: number }>();
    
    transactions.forEach(transaction => {
      const week = transaction.scoringPeriod;
      if (!weekCounts.has(week)) {
        weekCounts.set(week, { total: 0, trades: 0, draft: 0 });
      }
      
      const counts = weekCounts.get(week)!;
      counts.total++;
      
      if (transaction.type === 'TRADE_ACCEPT') {
        counts.trades++;
      } else if (transaction.type === 'DRAFT') {
        counts.draft++;
      }
    });

    // Convert to array and sort by week (ascending)
    const availableWeeks = Array.from(weekCounts.entries())
      .map(([week, counts]) => ({
        week,
        ...counts,
        hasRegularTransactions: counts.total - counts.draft > 0,
      }))
      .sort((a, b) => a.week - b.week);

    return availableWeeks;
  },
});

// Get draft transactions for a season
export const getDraftTransactions = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    const { leagueId, seasonId } = args;

    // Get all DRAFT transactions
    const draftTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", leagueId).eq("seasonId", seasonId)
      )
      .filter((q) => q.eq(q.field("type"), "DRAFT"))
      .collect();

    if (draftTransactions.length === 0) {
      return [];
    }

    // Get teams for this season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", leagueId).eq("seasonId", seasonId)
      )
      .collect();

    const teamMap = new Map(
      teams.map(team => [`${team.externalId}:${team.seasonId}`, {
        name: team.name,
        abbreviation: team.abbreviation,
        owner: team.owner,
        logo: team.logo,
        customLogo: team.customLogo,
        _id: team._id,
        seasonId: team.seasonId
      }])
    );

    // Get all players involved in draft
    const playerSeasonPairs = new Set<string>();
    draftTransactions.forEach(transaction => {
      transaction.items.forEach(item => {
        const key = `${item.playerId}:${transaction.seasonId}`;
        playerSeasonPairs.add(key);
      });
    });

    // Fetch player information
    const players = await Promise.all(
      Array.from(playerSeasonPairs).map(async (playerSeasonKey) => {
        const [playerId, seasonId] = playerSeasonKey.split(':');
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", parseInt(seasonId))
          )
          .first();
        return player ? { [playerId]: player } : null;
      })
    );

    const playerMap = new Map(
      players
        .filter(p => p !== null)
        .map(p => [Object.keys(p!)[0], Object.values(p!)[0]])
    );

    // Format draft transactions
    const formattedDraftTransactions = draftTransactions.map(transaction => {
      const formattedItems = transaction.items.map(item => {
        const player = playerMap.get(item.playerId.toString());
        const fromTeam = item.fromTeamId !== 0 
          ? teamMap.get(`${item.fromTeamId}:${transaction.seasonId}`) 
          : null;
        const toTeam = item.toTeamId !== 0 
          ? teamMap.get(`${item.toTeamId}:${transaction.seasonId}`) 
          : null;

        return {
          ...item,
          player: player ? {
            name: player.fullName,
            position: player.defaultPosition,
            team: player.proTeamAbbrev || 'FA',
          } : null,
          fromTeam,
          toTeam,
        };
      });

      return {
        ...transaction,
        items: formattedItems,
      };
    });

    // Sort by overall pick number
    formattedDraftTransactions.sort((a, b) => {
      const aPickNum = a.items[0]?.overallPickNumber || 999;
      const bPickNum = b.items[0]?.overallPickNumber || 999;
      return aPickNum - bPickNum;
    });

    return formattedDraftTransactions;
  },
});

// Get trade transactions for a season with optional pagination
export const getTradeTransactions = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { leagueId, seasonId, limit = 50 } = args;

    // Get TRADE_ACCEPT transactions for the specific season
    const trades = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", leagueId).eq("seasonId", seasonId)
      )
      .filter((q) => q.eq(q.field("type"), "TRADE_ACCEPT"))
      .order("desc")
      .take(limit);

    if (trades.length === 0) {
      return [];
    }

    // Get teams for this season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", leagueId).eq("seasonId", seasonId)
      )
      .collect();

    const teamMap = new Map(
      teams.map(team => [`${team.externalId}:${team.seasonId}`, {
        name: team.name,
        abbreviation: team.abbreviation,
        owner: team.owner,
        logo: team.logo,
        customLogo: team.customLogo,
        _id: team._id,
        seasonId: team.seasonId
      }])
    );

    // Get all players involved in trades
    const playerSeasonPairs = new Set<string>();
    trades.forEach(trade => {
      trade.items.forEach(item => {
        const key = `${item.playerId}:${trade.seasonId}`;
        playerSeasonPairs.add(key);
      });
    });

    // Fetch player information
    const players = await Promise.all(
      Array.from(playerSeasonPairs).map(async (playerSeasonKey) => {
        const [playerId, seasonId] = playerSeasonKey.split(':');
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", parseInt(seasonId))
          )
          .first();
        return player ? { [playerId]: player } : null;
      })
    );

    const playerMap = new Map(
      players
        .filter(p => p !== null)
        .map(p => [Object.keys(p!)[0], Object.values(p!)[0]])
    );

    // Format trades with team and player info
    const formattedTrades = trades.map(trade => {
      // Group items by team involvement
      const tradeDetails: Record<string, {
        team: any;
        playersReceived: any[];
        playersSent: any[];
      }> = {};

      trade.items.forEach(item => {
        const player = playerMap.get(item.playerId.toString());
        const playerInfo = player ? {
          name: player.fullName,
          position: player.defaultPosition,
          team: player.proTeamAbbrev || 'FA',
        } : null;

        // Handle players received
        if (item.toTeamId !== 0) {
          const toTeamKey = `${item.toTeamId}:${trade.seasonId}`;
          if (!tradeDetails[toTeamKey]) {
            tradeDetails[toTeamKey] = {
              team: teamMap.get(toTeamKey),
              playersReceived: [],
              playersSent: [],
            };
          }
          tradeDetails[toTeamKey].playersReceived.push(playerInfo);
        }

        // Handle players sent
        if (item.fromTeamId !== 0) {
          const fromTeamKey = `${item.fromTeamId}:${trade.seasonId}`;
          if (!tradeDetails[fromTeamKey]) {
            tradeDetails[fromTeamKey] = {
              team: teamMap.get(fromTeamKey),
              playersReceived: [],
              playersSent: [],
            };
          }
          tradeDetails[fromTeamKey].playersSent.push(playerInfo);
        }
      });

      return {
        ...trade,
        tradeDetails: Object.values(tradeDetails),
      };
    });

    // Sort trades by date (newest first)
    formattedTrades.sort((a, b) => 
      b.proposedDate - a.proposedDate
    );

    return formattedTrades;
  },
});