// The Wire — UI barrel. Data layer types are derived from `convex/wire.ts`'s own validators via
// `FunctionReturnType` (see `useLeagueWire.ts`), not imported from `src/lib/ai/wire/types.ts`,
// because that contract's literal unions are wider than what the query validators actually
// enforce. Everything here otherwise follows spec `ffsn-the-wire-spec.md` §2.

export {
  useLeagueWire,
  type WireFeedItem,
  type WireGlobalPost,
  type WireLeaguePost,
  type WireStatus,
  type WireTickerRow,
  type WireReplyItem,
  type WireReactionsView,
  type WireAuthorRefView,
  type WireTeamRefView,
  type UseLeagueWireOptions,
  type UseLeagueWireResult,
} from "./useLeagueWire";
export { WirePost, formatWireTime, type WirePostCardProps } from "./WirePost";
export { WireOverlayBlock, type WireOverlayBlockProps } from "./WireOverlayBlock";
export { WireTagChip, type WireTagChipProps } from "./WireTagChip";
export { WireFeed, type WireFeedProps } from "./WireFeed";
export { WirePanel, type WirePanelProps } from "./WirePanel";
export { WireReactionBar, type WireReactionBarProps } from "./WireReactionBar";
export { ManagerPlate, type ManagerPlateProps } from "./ManagerPlate";
export { WireComposer, type WireComposerProps } from "./WireComposer";
export { WireReplyComposer, type WireReplyComposerProps } from "./WireReplyComposer";
