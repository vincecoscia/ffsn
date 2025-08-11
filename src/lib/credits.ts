// Credit utility functions for AI content generation

export interface ContentCost {
  contentType: string;
  baseCost: number;
  finalCost: number;
  wordCount?: number;
}

export interface CreditCheck {
  hasSufficientCredits: boolean;
  currentBalance: number;
  requiredAmount: number;
  shortage: number;
}

// Calculate credit cost for different content types
export function calculateContentCost(
  contentType: string, 
  wordCount?: number
): ContentCost {
  // Base costs for different content types (in credits)
  const baseCosts: Record<string, number> = {
    "weekly_recap": 15,
    "weekly_preview": 12,
    "trade_analysis": 20,
    "power_rankings": 18,
    "waiver_wire_report": 10,
    "rivalry_week_special": 25,
    "season_recap": 30,
    "custom_roast": 8,
    "mock_draft": 22,
    "mid_season_awards": 16,
    "championship_manifesto": 28,
    "emergency_hot_takes": 6,
  };

  const baseCost = baseCosts[contentType] || 15;
  
  // Adjust for word count if provided (500 words = 1.0 multiplier)
  let finalCost = baseCost;
  if (wordCount) {
    const wordMultiplier = Math.max(0.5, Math.min(2.0, wordCount / 500));
    finalCost = Math.round(baseCost * wordMultiplier);
  }

  return {
    contentType,
    baseCost,
    finalCost,
    wordCount,
  };
}

// Format credit amount for display
export function formatCredits(amount: number): string {
  if (amount === 1) return "1 credit";
  return `${amount.toLocaleString()} credits`;
}

// Get user-friendly content type names
export function getContentTypeName(contentType: string): string {
  const typeNames: Record<string, string> = {
    "weekly_recap": "Weekly Recap",
    "weekly_preview": "Weekly Preview", 
    "trade_analysis": "Trade Analysis",
    "power_rankings": "Power Rankings",
    "waiver_wire_report": "Waiver Wire Report",
    "rivalry_week_special": "Rivalry Week Special",
    "season_recap": "Season Recap",
    "custom_roast": "Custom Team Roast",
    "mock_draft": "Mock Draft Analysis",
    "mid_season_awards": "Mid-Season Awards",
    "championship_manifesto": "Championship Manifesto", 
    "emergency_hot_takes": "Emergency Hot Takes",
  };

  return typeNames[contentType] || contentType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// Get credit purchase suggestions based on shortage
export function getCreditPurchaseSuggestion(shortage: number): {
  packageName: string;
  credits: number;
  price: number;
} {
  if (shortage <= 100) {
    return { packageName: "Basic Pack", credits: 100, price: 9.99 };
  } else if (shortage <= 250) {
    return { packageName: "Value Pack", credits: 250, price: 19.99 };
  } else {
    return { packageName: "Pro Pack", credits: 500, price: 34.99 };
  }
}

// Credit warning thresholds
export const CREDIT_THRESHOLDS = {
  LOW: 50,      // Show low credit warning
  CRITICAL: 20, // Show critical warning
  EMPTY: 0,     // No credits remaining
} as const;

// Get credit status for UI indicators
export function getCreditStatus(balance: number): {
  status: 'healthy' | 'low' | 'critical' | 'empty';
  color: string;
  message: string;
} {
  if (balance <= CREDIT_THRESHOLDS.EMPTY) {
    return {
      status: 'empty',
      color: 'red',
      message: 'No credits remaining. Purchase more to generate content.',
    };
  } else if (balance <= CREDIT_THRESHOLDS.CRITICAL) {
    return {
      status: 'critical', 
      color: 'red',
      message: `Only ${balance} credits left. Consider purchasing more soon.`,
    };
  } else if (balance <= CREDIT_THRESHOLDS.LOW) {
    return {
      status: 'low',
      color: 'yellow', 
      message: `${balance} credits remaining. You may want to purchase more.`,
    };
  } else {
    return {
      status: 'healthy',
      color: 'green',
      message: `${balance} credits available.`,
    };
  }
}

// Helper to generate credit transaction descriptions
export function generateCreditDescription(
  type: 'earned' | 'spent' | 'purchased' | 'refunded' | 'bonus',
  context: {
    amount?: number;
    contentType?: string;
    leagueName?: string;
    paymentAmount?: number;
  }
): string {
  const { amount = 0, contentType, leagueName, paymentAmount } = context;

  switch (type) {
    case 'earned':
      if (leagueName) {
        return amount === 1000 
          ? `League creation bonus - 1000 credits`
          : `League join bonus - 100 credits`;
      }
      return `Earned ${amount} credits`;

    case 'spent':
      if (contentType) {
        const typeName = getContentTypeName(contentType);
        return `${typeName} generation - ${Math.abs(amount)} credits`;
      }
      return `AI content generation - ${Math.abs(amount)} credits`;

    case 'purchased':
      const price = paymentAmount ? ` for $${(paymentAmount / 100).toFixed(2)}` : '';
      return `Purchased ${amount} credits${price}`;

    case 'refunded':
      return `Refunded ${amount} credits`;

    case 'bonus':
      return `Bonus credits - ${amount} credits`;

    default:
      return `${amount} credits`;
  }
}