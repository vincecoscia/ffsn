// Shell
export { BrandLogo, type BrandLogoProps } from "./BrandLogo";
export { ThemeToggle, type ThemeToggleProps } from "./ThemeToggle";
export { TopBar, type TopBarProps, type TopBarNavItem } from "./TopBar";
export { SiteHeader, type SiteHeaderProps } from "./SiteHeader";
export { AppHeader, type AppHeaderProps, type AppHeaderNavItem } from "./AppHeader";
export { DashboardHeader, type DashboardHeaderProps } from "./DashboardHeader";
export { Ticker, type TickerProps, type TickerItem } from "./Ticker";
export { SiteFooter, type SiteFooterProps, type SiteFooterLink } from "./SiteFooter";

// Layout & sectioning
export { Panel, type PanelProps } from "./Panel";
export { SectionHeader, type SectionHeaderProps } from "./SectionHeader";
export { SegmentSlate, type SegmentSlateProps } from "./SegmentSlate";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { Chip, type ChipProps } from "./Chip";

// Sports/data
export {
  ScoreBug,
  type ScoreBugProps,
  type ScoreBugTeam,
  type ScoreBugMode,
  type ScoreBugStripTone,
} from "./ScoreBug";
export { RankPlate, type RankPlateProps } from "./RankPlate";
export { TeamTile, type TeamTileProps } from "./TeamTile";
export { WinLossPip, type WinLossPipProps } from "./WinLossPip";
export { StatBlock, type StatBlockProps } from "./StatBlock";

// Roster (display data derived from src/lib/ai/persona-prompts.ts)
export {
  writerRoster,
  personasForContentType,
  defaultPersonaFor,
  isSelectableContentType,
  contentTypeLabel,
  personaName,
  personaRole,
  CONTENT_TYPE_LABELS,
  UNAVAILABLE_CONTENT_TYPES,
  type RosterWriter,
} from "./personaRoster";

// Editorial
export { LowerThird, type LowerThirdProps } from "./LowerThird";
export { PullQuote, type PullQuoteProps } from "./PullQuote";
export {
  RelationshipMeter,
  relationshipTierLabel,
  formatDelta,
  type RelationshipMeterProps,
  type RelationshipMeterEvent,
  type RelationshipTier,
} from "./RelationshipMeter";
export {
  DeskReview,
  type DeskReviewProps,
  type ReviewFlag,
  type ReviewFlagSeverity,
} from "./DeskReview";
export {
  QuoteApprovalCard,
  type QuoteApprovalCardProps,
  type QuoteReviewEntry,
  type QuoteReviewStatus,
} from "./QuoteApprovalCard";
export { WriterPlate, type WriterPlateProps } from "./WriterPlate";
export { PersonaAvatar, type PersonaAvatarProps, type PersonaAvatarVariant } from "./PersonaAvatar";
export { BannerPlaceholder, type BannerPlaceholderProps } from "./BannerPlaceholder";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { LoadingScreen, type LoadingScreenProps, Spinner, type SpinnerProps } from "./LoadingScreen";
