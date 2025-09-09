// Content templates for each type of FFSN article

export interface ContentTemplate {
  id: string;
  name: string;
  description: string;
  creditCost: number;
  estimatedWords: number;
  requiredData: string[];
  optionalData: string[];
  sections: ContentSection[];
  examplePrompt?: string;
}

export interface ContentSection {
  name: string;
  description: string;
  required: boolean;
  wordCount?: number;
}

export const contentTemplates: Record<string, ContentTemplate> = {
  "weekly_recap": {
    id: "weekly_recap",
    name: "Weekly Recap",
    description: "Comprehensive review of all matchups with commentary",
    creditCost: 10,
    estimatedWords: 1600,
    requiredData: ["matchup_results", "player_scores", "standings", "playoff_tier"],
    optionalData: ["injuries", "weather", "upsets", "playoff_implications"],
    sections: [
      {
        name: "introduction",
        description: "Hook and week overview - prioritize playoff context if applicable",
        required: true,
        wordCount: 150
      },
      {
        name: "championship_game",
        description: "Championship game breakdown with in-depth analysis",
        required: false, // Only when isChampionshipWeek
        wordCount: 400
      },
      {
        name: "playoff_games",
        description: "Coverage of playoff matchups (WINNERS_BRACKET games)",
        required: false, // Only when playoff games exist
        wordCount: 350
      },
      {
        name: "game_of_the_week",
        description: "Deep dive on the most interesting non-championship matchup",
        required: true,
        wordCount: 300
      },
      {
        name: "other_matchups", 
        description: "Comprehensive coverage of remaining games (consolation and regular season) with detailed analysis of each matchup",
        required: true,
        wordCount: 700
      },
      {
        name: "studs_and_duds",
        description: "Top and bottom performers across all games",
        required: true,
        wordCount: 250
      },
      {
        name: "playoff_implications",
        description: "How results affect playoff picture (if applicable)",
        required: false,
        wordCount: 150
      },
      {
        name: "looking_ahead",
        description: "Preview of next week",
        required: false,
        wordCount: 100
      },
      {
        name: "team_comments",
        description: "Commentary and quotes from team managers",
        required: false,
        wordCount: 200
      }
    ],
    examplePrompt: `Write a weekly recap for Week {week} of {leagueName}. 
    {playoffContext}
    The biggest story was {teamA} defeating {teamB} {scoreA}-{scoreB}. 
    Top performer: {topPlayer} with {topScore} points.
    Biggest bust: {bustPlayer} with only {bustScore} points.
    {playoffImplications}`
  },

  "weekly_preview": {
    id: "weekly_preview",
    name: "Weekly Preview",
    description: "Look-ahead analysis for upcoming matchups and storylines",
    creditCost: 10,
    estimatedWords: 1000,
    requiredData: ["upcoming_matchups", "team_records", "player_status"],
    optionalData: ["injury_reports", "weather_forecasts", "recent_trends"],
    sections: [
      {
        name: "week_overview",
        description: "Key storylines and what to watch",
        required: true,
        wordCount: 200
      },
      {
        name: "marquee_matchup",
        description: "Deep dive on the week's best game",
        required: true,
        wordCount: 300
      },
      {
        name: "other_games",
        description: "Quick preview of remaining matchups",
        required: true,
        wordCount: 350
      },
      {
        name: "sleepers_and_starts",
        description: "Under-the-radar players to watch",
        required: true,
        wordCount: 150
      },
      {
        name: "team_comments",
        description: "Commentary and predictions from team managers",
        required: false,
        wordCount: 200
      }
    ],
    examplePrompt: `Write a weekly preview for Week {week} of {leagueName}. 
    The marquee matchup is {teamA} vs {teamB}, both {recordA} and {recordB}. 
    Key storylines: {keyStoryline1}, {keyStoryline2}.
    Players to watch: {playerToWatch1}, {playerToWatch2}.`
  },

  "trade_analysis": {
    id: "trade_analysis",
    name: "Trade Analysis / Trade Grades",
    description: "Deep dive analysis of a completed trade",
    creditCost: 5,
    estimatedWords: 600,
    requiredData: ["trade_details", "team_rosters", "team_records"],
    optionalData: ["player_stats", "injury_status", "playoff_standings"],
    sections: [
      {
        name: "trade_summary",
        description: "What was traded",
        required: true,
        wordCount: 100
      },
      {
        name: "team_a_analysis",
        description: "Why Team A made this trade",
        required: true,
        wordCount: 200
      },
      {
        name: "team_b_analysis",
        description: "Why Team B made this trade",
        required: true,
        wordCount: 200
      },
      {
        name: "verdict",
        description: "Who won and impact",
        required: true,
        wordCount: 100
      }
    ]
  },

  "power_rankings": {
    id: "power_rankings",
    name: "Power Rankings",
    description: "Weekly rankings with movement and analysis",
    creditCost: 8,
    estimatedWords: 1000,
    requiredData: ["standings", "recent_results", "point_totals"],
    optionalData: ["strength_of_schedule", "injury_report"],
    sections: [
      {
        name: "introduction",
        description: "Week overview and major movers",
        required: true,
        wordCount: 150
      },
      {
        name: "rankings",
        description: "Team-by-team rankings with commentary",
        required: true,
        wordCount: 700
      },
      {
        name: "biggest_risers_fallers",
        description: "Teams with major movement",
        required: true,
        wordCount: 150
      },
      {
        name: "team_comments",
        description: "Team manager reactions and commentary",
        required: false,
        wordCount: 200
      }
    ]
  },

  "waiver_wire_report": {
    id: "waiver_wire_report",
    name: "Waiver Wire Report",
    description: "Top pickup recommendations with statistical backing",
    creditCost: 12,
    estimatedWords: 1000,
    requiredData: ["available_players", "recent_performances", "roster_percentages"],
    optionalData: ["upcoming_schedules", "injury_news", "weather_forecasts"],
    sections: [
      {
        name: "priority_pickups",
        description: "Must-add players this week",
        required: true,
        wordCount: 400
      },
      {
        name: "deep_league_targets",
        description: "Players for deeper leagues",
        required: true,
        wordCount: 300
      },
      {
        name: "drop_candidates",
        description: "Players to consider dropping",
        required: true,
        wordCount: 200
      },
      {
        name: "faab_recommendations",
        description: "Suggested bid amounts",
        required: false,
        wordCount: 100
      }
    ]
  },

  "mock_draft": {
    id: "mock_draft",
    name: "Mock Draft",
    description: "Mock draft predictions forecasting what each team will select",
    creditCost: 15,
    estimatedWords: 2000,
    requiredData: ["draft_order", "league_settings", "scoring_type", "available_players", "draft_type", "league_type"],
    optionalData: ["keeper_info", "team_preferences", "historical_draft_data"],
    sections: [
      {
        name: "introduction",
        description: "Pre-draft analysis explaining draft strategy predictions for each team based on league settings",
        required: true,
        wordCount: 200
      },
      {
        name: "rounds_1_2_by_team",
        description: "Predictions for first two rounds by round, explaining why each team will likely select specific players. Go pick by pick.",
        required: true,
        wordCount: 800
      },
      {
        name: "rounds_3_8",
        description: "Middle round predictions focusing on likely value targets and position runs",
        required: true,
        wordCount: 600
      },
      {
        name: "rounds_9_plus",
        description: "Late round predictions for sleepers and handcuffs teams are likely to target",
        required: true,
        wordCount: 300
      },
      {
        name: "summary",
        description: "Key predictions summary and which teams are positioned for the best drafts",
        required: true,
        wordCount: 100
      }
    ],
    examplePrompt: `Write a mock draft for {leagueName} ({leagueType} league, {draftType} draft). 
    Draft order: {draftOrder}. Scoring: {scoringType}. 
    Use the provided player projections and season outlooks to build optimal teams.
    Present rounds 1-2 in detail by team, then provide overview of later rounds.`
  },

  "rivalry_week_special": {
    id: "rivalry_week_special",
    name: "Rivalry Week Special",
    description: "Hype piece for rivalry matchups",
    creditCost: 10,
    estimatedWords: 800,
    requiredData: ["rivalry_history", "current_records", "matchup_details"],
    optionalData: ["trash_talk_history", "previous_upsets"],
    sections: [
      {
        name: "rivalry_history",
        description: "The backstory and bad blood",
        required: true,
        wordCount: 300
      },
      {
        name: "current_stakes",
        description: "What's on the line",
        required: true,
        wordCount: 200
      },
      {
        name: "key_matchups",
        description: "Players to watch",
        required: true,
        wordCount: 200
      },
      {
        name: "prediction",
        description: "Bold prediction with hype",
        required: true,
        wordCount: 100
      }
    ]
  },

  "emergency_hot_takes": {
    id: "emergency_hot_takes",
    name: "Emergency Hot Takes",
    description: "Rapid-fire reactions to breaking news, injuries, or shocking performances",
    creditCost: 5,
    estimatedWords: 600,
    requiredData: ["breaking_news", "recent_events"],
    optionalData: ["injury_updates", "trade_rumors", "lineup_changes"],
    sections: [
      {
        name: "breaking_news",
        description: "What just happened and why it matters",
        required: true,
        wordCount: 200
      },
      {
        name: "immediate_reactions",
        description: "Hot takes and instant analysis",
        required: true,
        wordCount: 250
      },
      {
        name: "fantasy_implications",
        description: "How this affects your lineup decisions",
        required: true,
        wordCount: 150
      }
    ],
    examplePrompt: `Write emergency hot takes about {breakingNews} in {leagueName}. 
    This affects {affectedTeams} and changes the outlook for {affectedPlayers}. 
    Immediate fantasy implications: {fantasyImpact}.`
  },
  "trade_rumor_mill": {
    id: "trade_rumor_mill",
    name: "Trade Rumor Leak",
    description: "Vinny 'The Sauce' shares mysterious insider information about potential trades",
    creditCost: 8,
    estimatedWords: 700,
    requiredData: ["trade_details"],
    optionalData: ["team_needs", "player_performance"],
    sections: [
      {
        name: "the_whispers",
        description: "Setting up the mysterious source and rumor",
        required: true,
        wordCount: 200
      },
      {
        name: "trade_details",
        description: "The juicy details about who's involved",
        required: true,
        wordCount: 300
      },
      {
        name: "league_implications",
        description: "How this could shake up the league",
        required: true,
        wordCount: 200
      }
    ]
  },

  "mid_season_awards": {
    id: "mid_season_awards",
    name: "Mid-Season Awards",
    description: "Awards ceremony with categories like MVP, Bust, etc.",
    creditCost: 12,
    estimatedWords: 1500,
    requiredData: ["season_stats", "draft_results", "trades"],
    optionalData: ["manager_activity", "waiver_claims"],
    sections: [
      {
        name: "introduction",
        description: "Award ceremony setup",
        required: true,
        wordCount: 150
      },
      {
        name: "mvp_award",
        description: "Most valuable player",
        required: true,
        wordCount: 250
      },
      {
        name: "bust_award",
        description: "Biggest disappointment",
        required: true,
        wordCount: 250
      },
      {
        name: "sleeper_award",
        description: "Best late round pick",
        required: true,
        wordCount: 250
      },
      {
        name: "manager_awards",
        description: "Best/worst manager decisions",
        required: true,
        wordCount: 400
      },
      {
        name: "special_awards",
        description: "Fun categories (luckiest, unluckiest, etc)",
        required: false,
        wordCount: 200
      }
    ]
  },

  "championship_manifesto": {
    id: "championship_manifesto",
    name: "Championship Week Manifesto",
    description: "Epic hype piece for championship matchup",
    creditCost: 10,
    estimatedWords: 1000,
    requiredData: ["finalist_teams", "season_journey", "key_players"],
    optionalData: ["previous_championships", "rivalry_history"],
    sections: [
      {
        name: "epic_introduction",
        description: "Set the stage for glory",
        required: true,
        wordCount: 200
      },
      {
        name: "team_a_journey",
        description: "Path to the championship",
        required: true,
        wordCount: 300
      },
      {
        name: "team_b_journey",
        description: "Path to the championship",
        required: true,
        wordCount: 300
      },
      {
        name: "keys_to_victory",
        description: "What each team needs",
        required: true,
        wordCount: 150
      },
      {
        name: "legacy_impact",
        description: "What this means for their legacy",
        required: true,
        wordCount: 50
      }
    ]
  },

  "season_recap": {
    id: "season_recap",
    name: "Season Recap",
    description: "Comprehensive review of the entire fantasy season with highlights and lowlights",
    creditCost: 20,
    estimatedWords: 1800,
    requiredData: ["season_standings", "all_matchup_results", "draft_results", "season_stats"],
    optionalData: ["trades_made", "waiver_pickups", "injury_timeline", "memorable_moments"],
    sections: [
      {
        name: "season_overview",
        description: "Big picture summary of the season",
        required: true,
        wordCount: 250
      },
      {
        name: "champion_story",
        description: "How the champion won it all",
        required: true,
        wordCount: 400
      },
      {
        name: "draft_review",
        description: "Best and worst draft picks across all teams",
        required: true,
        wordCount: 350
      },
      {
        name: "season_storylines",
        description: "Key trades, injuries, and dramatic moments",
        required: true,
        wordCount: 400
      },
      {
        name: "statistical_superlatives",
        description: "Season records and notable achievements",
        required: true,
        wordCount: 250
      },
      {
        name: "looking_ahead",
        description: "Offseason outlook and next year setup",
        required: true,
        wordCount: 150
      }
    ],
    examplePrompt: `Write a season recap for {leagueName}. 
    {championTeam} won the championship by {championPath}. 
    Biggest storylines: {majorStoryline1}, {majorStoryline2}. 
    Best draft pick: {bestPick}. Worst draft pick: {worstPick}.`
  },

  "custom_roast": {
    id: "custom_roast",
    name: "Custom Roast Article",
    description: "Targeted roasting of specific team/manager",
    creditCost: 25,
    estimatedWords: 1000,
    requiredData: ["target_team", "season_mistakes", "bad_decisions"],
    optionalData: ["historical_failures", "personality_traits"],
    sections: [
      {
        name: "introduction",
        description: "Set up the roast",
        required: true,
        wordCount: 150
      },
      {
        name: "draft_disasters",
        description: "Terrible draft picks",
        required: true,
        wordCount: 250
      },
      {
        name: "trade_tragedies",
        description: "Worst trades made",
        required: true,
        wordCount: 250
      },
      {
        name: "lineup_lunacy",
        description: "Bad start/sit decisions",
        required: true,
        wordCount: 250
      },
      {
        name: "conclusion",
        description: "Final burns and advice",
        required: true,
        wordCount: 100
      }
    ]
  },

  "season_welcome": {
    id: "season_welcome",
    name: "Season Welcome Package",
    description: "Welcome article for newly imported league with history",
    creditCost: 30,
    estimatedWords: 2000,
    requiredData: ["historical_data", "all_time_records", "championship_history"],
    optionalData: ["memorable_trades", "biggest_upsets", "rivalry_data"],
    sections: [
      {
        name: "league_introduction",
        description: "Welcome and league overview",
        required: true,
        wordCount: 300
      },
      {
        name: "dynasty_teams",
        description: "Most successful franchises",
        required: true,
        wordCount: 400
      },
      {
        name: "hall_of_fame",
        description: "Best performances and decisions",
        required: true,
        wordCount: 400
      },
      {
        name: "hall_of_shame",
        description: "Worst performances and decisions",
        required: true,
        wordCount: 400
      },
      {
        name: "memorable_moments",
        description: "Biggest upsets and comebacks",
        required: true,
        wordCount: 300
      },
      {
        name: "looking_forward",
        description: "What to expect this season",
        required: true,
        wordCount: 200
      }
    ]
  },

  "draft_rankings": {
    id: "draft_rankings",
    name: "Post-Draft Rankings & Grades",
    description: "Comprehensive draft analysis with letter grades for all teams based on draft position, player selections, and projected stats",
    creditCost: 15,
    estimatedWords: 2300,
    requiredData: ["draft_results", "team_rosters", "player_projections", "draft_order", "league_settings"],
    optionalData: ["keeper_info", "draft_strategy", "adp_data", "bench_depth"],
    sections: [
      {
        name: "introduction",
        description: "Overview of draft, methodology for grading, and key factors considered",
        required: true,
        wordCount: 200
      },
      {
        name: "team_by_team_grades",
        description: "Individual analysis of each team's draft with personalized grades and commentary. MUST integrate team manager comments about their draft strategy, picks, and reactions directly into each team's breakdown",
        required: true,
        wordCount: 1500
      },
      {
        name: "best_picks",
        description: "Top value picks and steals of the draft across all teams",
        required: true,
        wordCount: 150
      },
      {
        name: "worst_picks",
        description: "Biggest reaches and questionable selections",
        required: true,
        wordCount: 150
      },
      {
        name: "projected_standings",
        description: "Predicted finish based on projected starter points and bench depth",
        required: true,
        wordCount: 150
      }
    ],
    examplePrompt: `Write draft rankings and grades for {leagueName} by Mel Diaper. 
    Analyze each team's draft based on their draft position, player selections, and projected stats.
    Only count starters (lineupSlotId !== 20) for primary analysis, but consider bench depth for position groups.
    Grade teams A through F based on: value picks, reaching for players, overall roster construction, 
    projected points for starters, and positional depth.
    Include total projected points for starters and highlight best/worst picks.
    
    CRITICAL: For each team breakdown, weave in their manager's comments about draft strategy and specific picks. 
    MANDATORY QUOTE FORMAT: ALWAYS include manager's full name and specific question context.
    Structure each team analysis like this example:
    "Malik Nabers at 10th overall was DECENT, though I had him going 8th in most mocks. But then you COMPLETELY lost your mind with Cedric Tillman at 110! WORST PICK IN THE ENTIRE DRAFT! This is why you're not winning championships! When asked about their early wide receiver strategy, John Smith said: 'I wanted to get my WR1 locked in early and felt Nabers had the highest ceiling' - Yeah right, John! That ceiling better be the Sistine Chapel because you're praying for miracles!"
    
    NEVER quote without names: Use "John Smith said:" not just "said:"
    ALWAYS provide question context: "about their draft strategy", "regarding their RB picks", "about trading up"
    Make comments an integral part of the team analysis, not an optional afterthought.`
  }
};

// Helper function to calculate estimated generation time
export function estimateGenerationTime(template: ContentTemplate): number {
  // Rough estimate: 100 words per second for Claude
  const baseTime = Math.ceil(template.estimatedWords / 100);
  // Add processing overhead
  return baseTime + 5; // seconds
}

// Helper function to validate if we have required data
export function validateRequiredData(
  template: ContentTemplate,
  availableData: Record<string, unknown>
): { valid: boolean; missing: string[] } {
  const missing = template.requiredData.filter(
    required => !availableData[required]
  );
  
  return {
    valid: missing.length === 0,
    missing
  };
}