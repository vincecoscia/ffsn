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

export const getTradeTransactions = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { leagueId, seasonId } = args;

    // Get all TRADE_ACCEPT transactions
    let tradesQuery = ctx.db
      .query("transactions")
      .withIndex("by_type", (q) => q.eq("type", "TRADE_ACCEPT"))
      .filter((q) => q.eq(q.field("leagueId"), leagueId));

    // Filter by season if provided
    if (seasonId !== undefined) {
      tradesQuery = tradesQuery.filter((q) => q.eq(q.field("seasonId"), seasonId));
    }

    const trades = await tradesQuery.collect();

    // Get teams for the seasons represented in trades
    let teams;
    if (seasonId !== undefined) {
      // If specific season requested, get teams for that season only
      teams = await ctx.db
        .query("teams")
        .withIndex("by_season", (q) => 
          q.eq("leagueId", leagueId).eq("seasonId", seasonId)
        )
        .collect();
    } else {
      // Get all unique seasons from trades
      const seasonsInTrades = new Set<number>();
      trades.forEach(trade => {
        seasonsInTrades.add(trade.seasonId);
      });
      
      // Get teams for all seasons represented in trades
      const teamArrays = await Promise.all(
        Array.from(seasonsInTrades).map(async (season) => {
          return await ctx.db
            .query("teams")
            .withIndex("by_season", (q) => 
              q.eq("leagueId", leagueId).eq("seasonId", season)
            )
            .collect();
        })
      );
      teams = teamArrays.flat();
    }

    // Create a map with season-specific team info
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

    // Get all players involved in trades with their seasons
    const playerSeasonPairs = new Set<string>();
    trades.forEach(trade => {
      trade.items.forEach(item => {
        const key = `${item.playerId}:${trade.seasonId}`;
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