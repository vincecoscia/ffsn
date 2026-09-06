// Content templates for each type of FFSN article

export interface ContentTemplate {
  id: string;
  name: string;
  description: string;
  creditCost: number;
  /** Ceiling, not a quota. A shorter accurate article always beats a padded one. */
  estimatedWords: number;
  requiredData: string[];
  optionalData: string[];
  sections: ContentSection[];
  examplePrompt?: string;
  /**
   * "show" marks a multi-speaker piece produced turn-by-turn by its own producer (the
   * "Disputed" debate show — see `src/lib/ai/disputed/`), not by the single-writer article
   * pipeline. Absent (the default) means an ordinary article. A "show" template is never
   * offered by the content-generation picker (`isSelectableContentType`) and is refused by
   * `aiContent.createGenerationRequest`.
   */
  kind?: "article" | "show";
}

export interface ContentSection {
  name: string;
  description: string;
  required: boolean;
  /** Ceiling for this section, not a quota. */
  wordCount?: number;
}

export const contentTemplates: Record<string, ContentTemplate> = {
  "weekly_recap": {
    id: "weekly_recap",
    name: "Weekly Recap",
    description: "Comprehensive review of all matchups with commentary",
    creditCost: 25,
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
        description: "Remaining games (consolation and regular season); cover each one only as far as its material goes",
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
        description: "Quotes from managers with the writer's response to each",
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
        description: "Quotes from managers with the writer's response to each",
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
    creditCost: 15,
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
    creditCost: 15,
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
        description: "Quotes from managers with the writer's response to each",
        required: false,
        wordCount: 200
      }
    ]
  },

  "waiver_wire_report": {
    id: "waiver_wire_report",
    name: "Waiver Wire Report",
    description: "Top pickup recommendations with statistical backing",
    creditCost: 10,
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

  "bank_statement": {
    id: "bank_statement",
    name: "The Bank Statement",
    description: "Reggie Banks' weekly results ledger: who cashed in, who's overdrawn, judged on the scoreboard and nothing else. Draft position is never evidence here.",
    creditCost: 15,
    estimatedWords: 900,
    requiredData: ["standings", "matchup_results", "point_totals"],
    optionalData: ["waiver_claims", "trades_made", "lineup_changes", "team_rosters"],
    sections: [
      {
        name: "opening_bell",
        description: "The single biggest result of the week, score first, and what it says about the manager who produced it",
        required: true,
        wordCount: 120
      },
      {
        name: "deposits",
        description: "Managers who cashed in: wins, waiver claims that produced points, lineup calls that won the week. Each entry ends on its result",
        required: true,
        wordCount: 300
      },
      {
        name: "overdrawn",
        description: "Managers who left it on the table: points left on the bench, an ignored wire, a loss that was the lineup's fault. Attack the lineup, never the person",
        required: true,
        wordCount: 300
      },
      {
        name: "the_homework",
        description: "One paragraph answering the draft-desk view of the week without using its evidence: what the standings say versus what the draft board said",
        required: false,
        wordCount: 100
      },
      {
        name: "team_comments",
        description: "Quotes from managers with the writer's response to each",
        required: false,
        wordCount: 150
      }
    ]
  },

  "mock_draft": {
    id: "mock_draft",
    name: "Mock Draft",
    description: "Mock draft predictions forecasting what each team will select",
    creditCost: 30,
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
    creditCost: 15,
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
    creditCost: 15,
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
    name: "The Asking Price",
    description: "What is actually on the block: real listings, completed transactions and on-record interest",
    creditCost: 25,
    estimatedWords: 700,
    requiredData: ["trade_details"],
    optionalData: ["team_needs", "player_performance"],
    sections: [
      {
        name: "the_whispers",
        description: "What is on the market right now and where that is on the record",
        required: true,
        wordCount: 200
      },
      {
        name: "trade_details",
        description: "The listing or transaction itself: who, what, when",
        required: true,
        wordCount: 300
      },
      {
        name: "league_implications",
        description: "What the move changes in the standings, stated from the record",
        required: true,
        wordCount: 200
      }
    ]
  },

  "mid_season_awards": {
    id: "mid_season_awards",
    name: "Mid-Season Awards",
    description: "Awards ceremony with categories like MVP, Bust, etc.",
    creditCost: 20,
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
    creditCost: 20,
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
    creditCost: 25,
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
    creditCost: 30,
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

  // Banner Night (owner ask, 2026-09-06): written from the League Almanac (src/lib/ai/almanac.ts),
  // every receipt used once, a verdict and a numeric claim for every team. The old six overlapping
  // history sections (dynasty / hall of fame / hall of shame / moments) had the prod piece citing
  // "42.7" eight times and skipping four of ten managers.
  "season_welcome": {
    id: "season_welcome",
    name: "Season Kickoff",
    description: "Banner Night: the league's all-time ledger, the curse board, a verdict for every team, and the one number the writer will be held to",
    creditCost: 25,
    estimatedWords: 2300,
    requiredData: ["almanac"],
    optionalData: ["draft_receipts", "quotes"],
    sections: [
      {
        name: "banner_night",
        description: "Opening night. The all-time ledger in one breath: every champion by season, who has the most titles, the back-to-back, the unlikely champion, the drought. Every number from the ALMANAC, each used once.",
        required: true,
        wordCount: 450
      },
      {
        name: "curse_board",
        description: "Points and no ring: the most career points without a title, the longest drought, the bridesmaid, the never-made-the-playoffs. Name them with the receipt.",
        required: true,
        wordCount: 350
      },
      {
        name: "ten_verdicts",
        description: "One paragraph per team — every team in THIS SEASON'S TEAMS, in the order listed, headed by the team name. Each paragraph: one all-time receipt from that manager's ledger line, one absurd demand, one numeric prediction for this season (these are the claims).",
        required: true,
        wordCount: 1100
      },
      {
        name: "carryover_grudge",
        description: "Last season's final and the grudge it left: the margin, the loser, what the writer said then (priorClaims / relationships). Said once, here, and nowhere else.",
        required: true,
        wordCount: 250
      },
      {
        name: "the_number",
        description: "Close on one prediction with a number, then one absurd demand. The demand is the last line.",
        required: true,
        wordCount: 150
      }
    ]
  },

  "draft_rankings": {
    id: "draft_rankings",
    name: "Post-Draft Rankings & Grades",
    description: "Comprehensive draft analysis with letter grades for all teams based on draft position, player selections, and projected stats",
    creditCost: 30,
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
    
    Where the quote ledger has a manager's words, place them inside that team's own grade block:
    attribute as "{MANAGER} of {TEAM}", quote verbatim, name what they were asked about, and respond
    in voice. A team with no quote is analysed without one.`
  },

  /* --------------------------------------------------------------------------------------- *
   * Spec section 8.5 — the seven types that had no template. Word counts are ceilings.
   * --------------------------------------------------------------------------------------- */

  "draft_strategy_guide": {
    id: "draft_strategy_guide",
    name: "Draft Strategy Guide",
    description: "How to attack this league's draft from this draft slot, using this league's settings",
    creditCost: 20,
    estimatedWords: 1200,
    requiredData: ["league_settings", "draft_order"],
    optionalData: ["available_players", "player_projections", "team_rosters", "draft_results"],
    sections: [
      {
        name: "the_format",
        description: "The settings that actually change draft strategy in this league: scoring, roster slots, draft type, team count",
        required: true,
        wordCount: 150
      },
      {
        name: "the_board",
        description: "Where the value sits by position in this player pool, with ADP where the payload has it",
        required: true,
        wordCount: 300
      },
      {
        name: "plan_by_slot",
        description: "What each draft slot in the order should be planning for, early / middle / late",
        required: true,
        wordCount: 350
      },
      {
        name: "position_runs",
        description: "The runs to expect and whether to start one or wait one out",
        required: true,
        wordCount: 200
      },
      {
        name: "one_mistake",
        description: "The single mistake this league's format punishes hardest, named once",
        required: true,
        wordCount: 150
      }
    ]
  },

  "team_name_power_rankings": {
    id: "team_name_power_rankings",
    name: "Team Name Power Rankings",
    description: "Ranking the team names themselves, from the actual names in the league",
    creditCost: 10,
    estimatedWords: 900,
    requiredData: ["team_rosters"],
    optionalData: ["standings", "matchup_results"],
    sections: [
      {
        name: "the_criteria",
        description: "How names are being judged in this ranking, stated once and applied consistently",
        required: true,
        wordCount: 120
      },
      {
        name: "the_rankings",
        description: "Every team name ranked, using the names exactly as they appear in FACTS",
        required: true,
        wordCount: 450
      },
      {
        name: "the_bottom",
        description: "The names at the bottom and what would fix them",
        required: true,
        wordCount: 180
      },
      {
        name: "team_comments",
        description: "Quotes from managers about their own name, with the writer's response to each",
        required: false,
        wordCount: 150
      }
    ]
  },

  "trade_block_tuesday": {
    id: "trade_block_tuesday",
    name: "Trade Block Tuesday",
    description: "The standing trade block: who is listed, who is buying, who is selling — on the record only",
    creditCost: 10,
    estimatedWords: 900,
    requiredData: ["team_rosters", "standings"],
    optionalData: ["trade_details", "player_scores", "injuries"],
    sections: [
      {
        name: "the_board",
        description: "What is actually listed or on the record this week; if the board is empty, say so and keep it short",
        required: true,
        wordCount: 200
      },
      {
        name: "listings_by_team",
        description: "Team by team: what they are shopping and what their record says about why",
        required: true,
        wordCount: 350
      },
      {
        name: "buyers_and_sellers",
        description: "Who the standings say is buying and who is selling",
        required: true,
        wordCount: 200
      },
      {
        name: "one_read",
        description: "Exactly one speculative paragraph, standing alone, opened \"My read, not reporting:\"",
        required: true,
        wordCount: 100
      },
      {
        name: "team_comments",
        description: "On-record manager statements about the block, with the writer's response to each",
        required: false,
        wordCount: 150
      }
    ]
  },

  "commissioner_corner": {
    id: "commissioner_corner",
    name: "Commissioner's Corner",
    description: "One league-governance item argued out in full: the setting, the argument, the consequence",
    creditCost: 25,
    estimatedWords: 900,
    requiredData: ["league_settings", "standings"],
    optionalData: ["trade_details", "all_time_records", "matchup_results", "championship_history"],
    sections: [
      {
        name: "the_item",
        description: "The one governance item this column is about, named in the first hundred words",
        required: true,
        wordCount: 150
      },
      {
        name: "the_setting",
        description: "The rule or setting as it actually stands, quoted from the payload before any argument about it",
        required: true,
        wordCount: 150
      },
      {
        name: "the_argument",
        description: "The case, in the first person, owned",
        required: true,
        wordCount: 350
      },
      {
        name: "what_changes",
        description: "What the league would look like if it changed, stated from the record",
        required: true,
        wordCount: 150
      },
      {
        name: "team_comments",
        description: "Quotes from managers on the item, with the writer's response to each",
        required: false,
        wordCount: 150
      }
    ]
  },

  "playoff_picture": {
    id: "playoff_picture",
    name: "Playoff Picture",
    description: "Who is in, who is alive, and the math that decides it",
    creditCost: 20,
    estimatedWords: 1100,
    requiredData: ["standings", "matchup_results"],
    optionalData: ["player_scores", "injuries", "team_rosters"],
    sections: [
      {
        name: "the_field",
        description: "The current seeding as the standings have it, with the sample size named",
        required: true,
        wordCount: 200
      },
      {
        name: "in_the_hunt",
        description: "The teams still alive and what separates them, in points and games",
        required: true,
        wordCount: 300
      },
      {
        name: "the_math",
        description: "Elimination and clinching arithmetic, showing both inputs for every number computed",
        required: true,
        wordCount: 250
      },
      {
        name: "schedule_ahead",
        description: "What the remaining schedule does to the picture, only from the payload",
        required: true,
        wordCount: 200
      },
      {
        name: "team_comments",
        description: "Quotes from managers in the race, with the writer's response to each",
        required: false,
        wordCount: 150
      }
    ]
  },

  "hall_of_shame": {
    id: "hall_of_shame",
    name: "Hall of Shame",
    description: "The season's worst decisions, each one pinned to the line in the record that proves it",
    creditCost: 15,
    estimatedWords: 1000,
    requiredData: ["standings", "matchup_results"],
    optionalData: ["draft_results", "trade_details", "player_scores", "all_time_records"],
    sections: [
      {
        name: "the_case_file",
        description: "What is being inducted this time and the standard for induction",
        required: true,
        wordCount: 150
      },
      {
        name: "worst_lineup_decision",
        description: "The worst start/sit call, with the bench impact numbers that prove it",
        required: true,
        wordCount: 250
      },
      {
        name: "worst_transaction",
        description: "The worst trade or waiver move, with the transaction itself quoted from the record",
        required: true,
        wordCount: 250
      },
      {
        name: "the_score",
        description: "The single worst score of the period and the game it lost",
        required: true,
        wordCount: 200
      },
      {
        name: "verdict",
        description: "The induction, one paragraph, decisions only — never the person",
        required: true,
        wordCount: 120
      }
    ]
  },

  "player_glazing": {
    id: "player_glazing",
    name: "The Case For",
    description: "An honest argument for one player: the problem first, then the case, the path, and one named risk",
    creditCost: 20,
    estimatedWords: 1000,
    requiredData: ["player_scores", "team_rosters"],
    optionalData: ["matchup_results", "standings", "player_projections", "injuries"],
    sections: [
      {
        name: "the_problem",
        description: "The honest case against this player first, in the numbers, before any defence of him",
        required: true,
        wordCount: 200
      },
      {
        name: "the_case",
        description: "The argument for him, every claim carried by a number from the payload",
        required: true,
        wordCount: 350
      },
      {
        name: "the_path",
        description: "What specifically has to happen for the case to come true",
        required: true,
        wordCount: 250
      },
      {
        name: "the_risk",
        description: "One named risk that would end the case, stated plainly and not hedged away",
        required: true,
        wordCount: 150
      },
      {
        name: "team_comments",
        description: "Quotes from the manager who rosters him, with the writer's response to each",
        required: false,
        wordCount: 150
      }
    ]
  },

  "desk_show": {
    id: "desk_show",
    kind: "show",
    name: "Disputed",
    description: "The desk's weekly debate show. Mel Diaper and Reggie Banks argue one question about one manager; the rest of the desk are called as witnesses; Curtis Vaughn hosts. Produced turn by turn by the show producer, not by the article pipeline.",
    creditCost: 30,
    estimatedWords: 1600,
    requiredData: ["standings", "matchup_results"],
    optionalData: ["transactions", "trades", "team_rosters"],
    sections: [
      { name: "cold_open", description: "Curtis states the biggest fact of the week and asks the question", required: true, wordCount: 60 },
      { name: "opening_statements", description: "Mel then Reggie take a side with a number attached", required: true, wordCount: 240 },
      { name: "main_event", description: "The debate, with witnesses called by name and Curtis redirecting when it gets hot", required: true, wordCount: 1000 },
      { name: "verdict", description: "Nina grades both takes and names a winner; Curtis reads the season ledger", required: true, wordCount: 160 },
      { name: "last_jabs", description: "One jab each, then Curtis signs off", required: true, wordCount: 140 }
    ]
  }
};

/* -------------------------------------------------------------------------- */
/* Credits (spec §10.2)                                                        */
/*                                                                             */
/* `creditCost` above is the single source of truth for what a manual          */
/* generation costs: 1 credit ≈ 1¢ of measured API cost, rounded up to the     */
/* nearest 5 with a floor of 10. Automated content never spends credits.       */
/* -------------------------------------------------------------------------- */

/** Every manager the requester asks for comment adds this much on top of the type's price. */
export const INTERVIEW_CREDITS_PER_MANAGER = 5;

/**
 * What one manual generation costs: the content type's price plus 5 credits per manager the
 * requester turned comment requests on for. An unknown content type costs nothing on its own.
 */
export function creditCostFor(contentType: string, managersAsked = 0): number {
  const base = contentTemplates[contentType]?.creditCost ?? 0;
  const managers = Number.isFinite(managersAsked) ? Math.max(0, Math.floor(managersAsked)) : 0;
  return base + managers * INTERVIEW_CREDITS_PER_MANAGER;
}

// Helper function to calculate estimated generation time
export function estimateGenerationTime(template: ContentTemplate): number {
  // Rough estimate: 100 words per second for Claude
  const baseTime = Math.ceil(template.estimatedWords / 100);
  // Add processing overhead
  return baseTime + 5; // seconds
}

/**
 * Which `LeagueDataContext` keys satisfy a `requiredData` entry. Every requirement key used by
 * any template in this file must appear here, so `validateRequiredData` can answer for it — a
 * requirement nothing maps to would silently validate as present.
 */
const REQUIRED_DATA_SOURCES: Record<string, string[]> = {
  matchup_results: ["recentMatchups", "playoffBreakdown"],
  // Games that have not been played. `recentMatchups` is NOT a source here: satisfying a
  // preview with last week's results is exactly how a preview turns into a recap.
  upcoming_matchups: ["upcomingMatchups"],
  player_scores: ["teams", "recentMatchups"],
  player_status: ["injuryReport", "teams"],
  player_projections: ["draftPicks", "availablePlayers"],
  standings: ["standings"],
  season_standings: ["standings"],
  team_records: ["standings", "teams"],
  current_records: ["standings", "teams"],
  team_rosters: ["teams"],
  target_team: ["teams"],
  finalist_teams: ["teams", "standings"],
  recent_results: ["recentMatchups"],
  all_matchup_results: ["recentMatchups"],
  point_totals: ["standings", "teams"],
  season_stats: ["teams", "standings"],
  season_journey: ["recentMatchups", "standings"],
  season_mistakes: ["recentMatchups", "transactions", "trades"],
  bad_decisions: ["transactions", "trades", "recentMatchups"],
  key_players: ["teams"],
  matchup_details: ["recentMatchups"],
  available_players: ["availablePlayers"],
  recent_performances: ["teams", "recentMatchups"],
  roster_percentages: ["teams", "availablePlayers"],
  trade_details: ["trades"],
  trades: ["trades"],
  rivalry_history: ["rivalries"],
  breaking_news: ["transactions", "trades", "injuryReport", "recentMatchups"],
  recent_events: ["transactions", "trades", "recentMatchups"],
  draft_order: ["draftOrder", "draftSettings"],
  draft_results: ["draftPicks"],
  draft_type: ["draftType", "draftSettings"],
  league_type: ["leagueType"],
  scoring_type: ["scoringType"],
  league_settings: ["scoringType", "totalTeams", "draftType", "rosterSize"],
  playoff_tier: ["playoffBreakdown", "recentMatchups"],
  historical_data: ["previousSeasons"],
  all_time_records: ["leagueHistory"],
  championship_history: ["leagueHistory"],
  injuries: ["injuryReport"],
};

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return Boolean(value);
}

// Helper function to validate if we have required data
export function validateRequiredData(
  template: ContentTemplate,
  availableData: Record<string, unknown>
): { valid: boolean; missing: string[] } {
  const missing = template.requiredData.filter(required => {
    // The requirement key itself wins when the caller passes a flat availability map.
    if (hasValue(availableData[required])) return false;
    const sources = REQUIRED_DATA_SOURCES[required];
    if (!sources) return true;
    return !sources.some(key => hasValue(availableData[key]));
  });

  return {
    valid: missing.length === 0,
    missing
  };
}