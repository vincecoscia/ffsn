# ESPN Fantasy Football API (2025) – Data Schemas by Endpoint Category

## League Overview (Basic Info & Status)

The root **League** object contains high-level identifiers and status info for the fantasy league. Key fields include:

* **id** (`integer`): Unique league ID.
* **seasonId** (`integer`): Season year (e.g., 2025).
* **scoringPeriodId** (`integer`): Current scoring period (typically the current week of season).
* **segmentId** (`integer`): Segment of the game (usually `0` for the main fantasy season).
* **gameId** (`integer`): Game type (1 for NFL Fantasy).
* **members** (`array<object>`): List of league members (users). Each object has:

  * `id` (`string`): User GUID.
  * `displayName` (`string`)
  * `isLeagueManager` (`boolean`)
* **teams** (`array<Team>`): Array of team objects (see **Teams and Standings**).
* **settings** (`object`): Basic league info (e.g., `name`).
* **status** (`object`): Status details including:

  * `currentMatchupPeriod` (`integer`)
  * `latestScoringPeriod` (`integer`)
  * `finalScoringPeriod` (`integer`)
  * `isActive` (`boolean`)
  * `previousSeasons` (`integer[]`)
  * `teamsJoined` (`integer`)
  * Additional flags (e.g., `isFull`, `isPlayoffMatchupEdited`).

*Example without view parameters: minimal info (IDs, current period, basic lists). The **`mStatus`** view enriches it with status fields.*

---

## Teams and Standings

Each **Team** entry contains roster and performance info:

* **id** (`integer`)
* **name** (`string`)

  * `location` (`string`)
  * `nickname` (`string`)
* **abbrev** (`string`)
* **owners** (`array<string>`)
* **divisionId** (`integer`)
* **playoffSeed** (`integer`)
* **record** (`object`): Breakdown (`overall`, `home`, `away`, `division`), each with wins, losses, ties, pointsFor, pointsAgainst, streak info.
* **points** (`number`)
* **pointsAdjusted**, **pointsDelta** (`number`)
* **rankCurrent**, **currentProjectedRank**, **rankFinal**, **rankCalculatedFinal**, **draftDayProjectedRank** (`integer`)
* **transactionCounter** (`object`): Counts of `acquisitions`, `drops`, `trades`, etc.
* **valuesByStat** (`object`): Stat ID → total value.

Views:

* `mTeam`: adds `draftStrategy`, `pendingTransactions`.
* `mStandings`: adds `simulationResults` and a **schedule** overview:

  ```json
  [
    {
      "matchupPeriodId": 1,
      "home": { "teamId": 1, "totalPoints": 91.05 },
      "away": { "teamId": 3, "totalPoints": 48.06 }
    },
    ...
  ]
  ```

---

## League Settings (Rules & Configuration)

`mSettings` view returns nested objects:

* **acquisitionSettings:** Waiver and budget rules
* **draftSettings:** Draft type, date, order, auction budget
* **rosterSettings:** Lineup slot counts, position limits, lock behavior
* **scheduleSettings:** Regular-season matchup count, playoff structure, divisions
* **scoringSettings:** Stat ID → point values, tie-break rules, bonuses
* **tradeSettings:** Trade deadlines, veto and review policies

Each sub-object contains detailed fields to configure league behavior.

---

## Rosters and Players

Teams have a **roster**:

* **entries** (`array<RosterEntry>`)
* **appliedStatTotal** (`number`)

**RosterEntry**:

* `playerId`, `lineupSlotId`, `acquisitionType`, `acquisitionDate`, `injuryStatus`, `pendingTransactionIds`
* **playerPoolEntry**:

  * `onTeamId`, `keeperValue`, `keeperValueFuture`, `lineupLocked`, `appliedStatTotal`
  * **player**: detailed profile:

    * `id`, `firstName`, `lastName`, `fullName`
    * `defaultPositionId`, `proTeamId`, `eligibleSlots`
    * `droppable`, `injured`, `injuryStatus`
    * `draftRanksByRankType`
    * **stats** (`array<StatLine>`):

      * `id`, `statSourceId`, `statSplitTypeId`, `externalId`
      * **stats** (raw counts), **appliedStats** (points), `points`

---

## Matchups and Schedule

**Matchup** objects:

* `matchupPeriodId`
* **home**, **away**: each with `teamId`, `totalPoints`, optional breakdowns
* Winner inferred by comparing scores.

Views:

* `mStandings`: simple schedule
* `mMatchup`, `mMatchupScore`, `mBoxscore`: detailed box scores for starters and bench

---

## Player Stats and Data Model

* **Players Endpoint** (`players_wl`): list of players with `id`, `fullName`, `defaultPositionId`, `proTeamId`, `eligibleSlots`, ownership %
* **PlayerPoolEntry**: schema matching roster’s `playerPoolEntry` for free agents
* **stats** arrays for season totals, weekly stats, projections (each with raw stats and applied points)

---

## Draft Results (Draft Detail)

`mDraftDetail` view:

* `drafted`, `inProgress`
* **picks** (`array<Pick>`):

  * `overallPickNumber`, `teamId`, `playerId`
  * `roundId`, `bidAmount`, `nominatingTeamId`, `keeper`, `reservedForKeeper`, `autoDraftTypeId`, `id`, `completeDate`

---

## Historical League Data (League History)

* **leagueHistory** endpoint: array of league objects per season
* Use `seasonId` to retrieve specific years
* Schema matches current league object
* `status.previousSeasons` lists available years

*This allows retrieval of past league settings, teams, rosters, schedule, and draft results for any historical season.*

---

## Champions & Playoff Brackets

### Retrieving Historical Champions

The champion for a given season can be determined by identifying the winner of the championship matchup:

1. **Identify Championship Period**: From the league’s settings (`mSettings` view), note:

   * `matchupPeriodCount`: the number of regular season periods.
   * `playoffMatchupPeriodLength`: how many weeks each playoff round lasts.
   * `playoffTeamCount`: total teams in playoffs.

2. **Compute Final Round Period**:

   ```text
   championshipPeriod = matchupPeriodCount + (playoffMatchupPeriodLength * (roundCount - 1)) + 1
   ```

   * `roundCount = log2(playoffTeamCount)` (e.g., 4 teams → 2 rounds).

3. **Fetch Matchup**:

   * Call the league endpoint with `view=mMatchupScore` (or `mBoxscore`) and filter `matchupPeriodId=championshipPeriod`.
   * Inspect the returned object’s `home.totalPoints` vs `away.totalPoints`.
   * The higher-scoring side’s `teamId` is the champion.

4. **League History**:

   * To find past champions, call `/leagueHistory/{leagueId}?seasonId={YEAR}&view=mMatchupScore` for each historical year.
   * Apply the same logic per season.

### Constructing Playoff Brackets

Since ESPN does not expose a dedicated bracket endpoint, you can build brackets client-side:

1. **Retrieve Full Playoff Schedule**:

   * Use `view=mMatchup` or `mStandings` on the league endpoint; this returns all matchups including playoff weeks.

2. **Determine Playoff Weeks**:

   * From `scheduleSettings`, compute start and end periods for each playoff round:

     ```text
     Round 1: periods (matchupPeriodCount+1) to (matchupPeriodCount + playoffMatchupPeriodLength)
     Round 2: next block of playoffMatchupPeriodLength, etc.
     ```

3. **Group Matchups by Round**:

   * Filter schedule entries by `matchupPeriodId` ranges to group them into round arrays.

4. **Build Bracket Structure**:

   * For **Round 1**, list each matchup with `home.teamId`, `away.teamId`, and scores.
   * For subsequent rounds, the participants are the winners of the previous round:

     * Use the champion IDs from Round 1 matchups to populate Round 2’s bracket seeds.
   * Continue until the championship round.

5. **Presentation**:

   * Render the bracket by round, showing matchups, scores, and advancing teams.
   * Optionally store this bracket structure for front-end display.

> **Note:** Because playoff matchups may be reseeded or tiered, check for any ESPN fields like `playoffTierType` or `matchupType` in detailed matchup views (`mBoxscore`). These can indicate playoff bracket structure (e.g., semifinal vs. consolation matches).

*By leveraging the existing matchup and settings data, you can programmatically derive champions and full playoff brackets for both the current and historical seasons.*
