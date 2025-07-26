"use client";

import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SeasonSelectorProps {
  currentSeason: number;
  selectedSeason: number;
  onSeasonChange: (season: number) => void;
  availableSeasons?: number[];
}

export function SeasonSelector({
  currentSeason,
  selectedSeason,
  onSeasonChange,
  availableSeasons,
}: SeasonSelectorProps) {
  // If no available seasons provided, generate a reasonable range
  const seasons = availableSeasons || Array.from(
    { length: 5 }, 
    (_, i) => currentSeason - i
  );

  return (
    <Select
      value={selectedSeason.toString()}
      onValueChange={(value) => onSeasonChange(parseInt(value))}
    >
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder="Select a season" />
      </SelectTrigger>
      <SelectContent>
        {seasons.map((season) => (
          <SelectItem key={season} value={season.toString()}>
            {season} Season
            {season === currentSeason && " (Current)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}