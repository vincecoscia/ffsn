"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface TeamLogoProps {
  teamId: Id<"teams">;
  teamName: string;
  espnLogo?: string;
  customLogo?: Id<"_storage">;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export function TeamLogo({ 
  teamId, 
  teamName, 
  espnLogo, 
  customLogo,
  size = "md",
  className = ""
}: TeamLogoProps) {
  const [showEspnLogo, setShowEspnLogo] = useState(true);
  const customLogoUrl = useQuery(api.teams.getCustomLogoUrl, 
    customLogo ? { teamId } : "skip"
  );

  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-12 w-12",
    lg: "h-16 w-16",
    xl: "h-20 w-20"
  };

  const iconSizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
    xl: "h-10 w-10"
  };

  // Prioritize custom logo over ESPN logo
  const logoUrl = customLogoUrl || (showEspnLogo && espnLogo ? espnLogo : null);

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={`${teamName} logo`}
        className={`${sizeClasses[size]} rounded object-cover ${className}`}
        onError={() => {
          if (logoUrl === espnLogo) {
            // ESPN logo failed to load
            setShowEspnLogo(false);
          }
        }}
      />
    );
  }

  // Fallback placeholder
  return (
    <div className={`${sizeClasses[size]} rounded bg-gray-200 flex items-center justify-center ${className}`}>
      <svg 
        className={`${iconSizeClasses[size]} text-gray-400`} 
        fill="none" 
        viewBox="0 0 24 24" 
        stroke="currentColor"
      >
        <path 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          strokeWidth={2} 
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" 
        />
      </svg>
    </div>
  );
}