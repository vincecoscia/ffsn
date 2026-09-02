"use client";

import React from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ClipboardList, ShieldAlert } from "lucide-react";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Chip,
  EmptyState,
  Panel,
  SectionHeader,
  StatBlock,
  personaName,
  personaRole,
} from "@/components/broadcast";

/**
 * "Desk metrics" (spec §8.7): the commissioner's read on how well the writers are staying inside
 * the FACTS block. Three league-wide tiles, a per-writer table, and the most recent verifier
 * findings with a link to the draft each one came from.
 */

type Metrics = NonNullable<ReturnType<typeof useDeskMetrics>>;

const WINDOWS: Array<{ label: string; days?: number }> = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "All time" },
];

const SEVERITY_VARIANT: Record<string, "destructive" | "red" | "outline"> = {
  block: "destructive",
  strip: "red",
  warn: "outline",
};

const SEVERITY_LABEL: Record<string, string> = {
  block: "Blocked",
  strip: "Removed",
  warn: "Check",
};

function useDeskMetrics(leagueId: Id<"leagues">, sinceDays: number | undefined, enabled: boolean) {
  // `now` is deliberately not passed: reading the clock during render is impure, and the window
  // here is measured in days, so letting the query fall back to the server clock costs nothing.
  // Callers that need a fixed window (the tests) pass `now` explicitly.
  return useQuery(api.deskMetrics.getDeskMetrics, enabled ? { leagueId, sinceDays } : "skip");
}

/** `null` metrics mean "we have not measured that yet", which is never rendered as a zero. */
function formatMetric(value: number | null, digits: number, suffix = ""): string {
  if (value === null) return "--";
  return `${value.toFixed(digits)}${suffix}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "--";
  return `${Math.round(value * 100)}%`;
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function CommissionerOnly() {
  return (
    <Panel padding="lg">
      <EmptyState
        icon={<ShieldAlert className="size-6" strokeWidth={1.8} />}
        title="Commissioner only"
        description="Desk metrics are the newsroom's own scorecard. Ask your commissioner if you need a look."
      />
    </Panel>
  );
}

/**
 * The query throws for anyone who is not the commissioner. The page already gates on the league
 * role, so this only catches the drift case (role changed under an open tab) and turns it into the
 * same plain panel instead of a blank screen.
 */
class CommissionerBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <CommissionerOnly />;
    return this.props.children;
  }
}

function StatTiles({ metrics }: { metrics: Metrics }) {
  const tiles = [
    {
      label: "Ungrounded per 1k words",
      value: formatMetric(metrics.league.ungroundedPer1k, 2),
      caption: "Blocked or removed findings for every thousand words published. Zero is the target.",
    },
    {
      label: "Quote fidelity",
      value: formatPercent(metrics.league.quoteFidelity),
      caption:
        metrics.league.quoteFidelity === null
          ? "Nobody has gone on the record in this window."
          : "Share of the quotes managers gave that made it into print.",
    },
    {
      label: "Padding index",
      value: formatMetric(metrics.league.paddingIndex, 2),
      caption: "Words spent per available fact. Word targets are ceilings, so lower is tighter.",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {tiles.map((tile) => (
        <Panel key={tile.label} padding="md" lifted className="flex flex-col gap-3">
          <StatBlock label={tile.label} value={tile.value} size="lg" />
          <p className="text-[13px] leading-snug text-bc-text-2">{tile.caption}</p>
        </Panel>
      ))}
    </div>
  );
}

function WriterTable({ metrics }: { metrics: Metrics }) {
  if (metrics.perWriter.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList className="size-6" strokeWidth={1.8} />}
        title="No articles in this window"
        description="Generate an article, or widen the window, and the desk's numbers will appear here."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-bc-hairline hover:bg-transparent">
            <TableHead className="bc-label-sm text-bc-text-3">Writer</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-right">Articles</TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-right">Ungrounded /1k</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right sm:table-cell">
              Quote fidelity
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right sm:table-cell">
              Padding
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.perWriter.map((writer) => (
            <TableRow key={writer.persona} className="border-bc-hairline hover:bg-bc-panel-2">
              <TableCell>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-display text-[17px] font-bold uppercase leading-none text-bc-ink">
                    {personaName(writer.persona)}
                  </span>
                  <span className="bc-label-sm truncate text-bc-text-3">
                    {personaRole(writer.persona)}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <span className="bc-num text-bc-ink">{writer.articles}</span>
              </TableCell>
              <TableCell className="text-right">
                <span
                  className={
                    writer.ungroundedPer1k !== null && writer.ungroundedPer1k > 0
                      ? "bc-num text-bc-red-text"
                      : "bc-num text-bc-ink"
                  }
                >
                  {formatMetric(writer.ungroundedPer1k, 2)}
                </span>
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                <span className="bc-num text-bc-text-2">{formatPercent(writer.quoteFidelity)}</span>
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                <span className="bc-num text-bc-text-2">
                  {formatMetric(writer.paddingIndex, 2)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RecentFlags({ metrics }: { metrics: Metrics }) {
  if (metrics.recentFlags.length === 0) {
    return (
      <p className="text-[14px] text-bc-text-2">
        Nothing flagged in this window. Every article came back clean.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-bc-hairline">
      {metrics.recentFlags.map((flag, index) => (
        <li
          key={`${flag.articleId}-${flag.kind}-${index}`}
          className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Chip variant={SEVERITY_VARIANT[flag.severity] ?? "outline"}>
              {SEVERITY_LABEL[flag.severity] ?? flag.severity}
            </Chip>
            <span className="bc-label-sm text-bc-text-3">
              {flag.kind.replace(/[_-]+/g, " ")}
              {flag.section ? ` · ${flag.section}` : ""}
            </span>
            <span className="bc-label-sm ml-auto text-bc-text-3">{formatWhen(flag.createdAt)}</span>
          </div>
          <p className="break-words text-[14px] leading-snug text-bc-body">{flag.detail}</p>
          <Link
            href={`/articles/${flag.articleId}`}
            className="bc-label-sm text-bc-red-text underline-offset-4 hover:underline"
          >
            {flag.title} · {personaName(flag.persona)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function DeskMetricsBody({ leagueId }: { leagueId: Id<"leagues"> }) {
  const [sinceDays, setSinceDays] = React.useState<number | undefined>(30);
  const metrics = useDeskMetrics(leagueId, sinceDays, true);

  const windowPicker = (
    <div className="flex flex-wrap gap-2">
      {WINDOWS.map((option) => (
        <Button
          key={option.label}
          size="sm"
          variant={option.days === sinceDays ? "default" : "outline"}
          onClick={() => setSinceDays(option.days)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Panel padding="md">
        <SectionHeader
          title="Desk metrics"
          kicker="How well the writers stayed inside the facts"
          actions={windowPicker}
        />
        <div className="mt-5">
          {metrics === undefined ? (
            <p className="bc-label-sm text-bc-text-3">Reading the desk&rsquo;s bookkeeping&hellip;</p>
          ) : (
            <div className="flex flex-col gap-6">
              <StatTiles metrics={metrics} />
              {metrics.truncated && (
                <p className="bc-label-sm text-bc-text-3">
                  Showing the 500 most recent articles.
                </p>
              )}
            </div>
          )}
        </div>
      </Panel>

      <Panel padding="md">
        <SectionHeader title="By writer" size="sm" />
        <div className="mt-5">
          {metrics === undefined ? (
            <p className="bc-label-sm text-bc-text-3">Loading&hellip;</p>
          ) : (
            <WriterTable metrics={metrics} />
          )}
        </div>
      </Panel>

      <Panel padding="md">
        <SectionHeader
          title="Recent flags"
          size="sm"
          kicker={metrics ? `${metrics.recentFlags.length} most recent` : undefined}
        />
        <div className="mt-5">
          {metrics === undefined ? (
            <p className="bc-label-sm text-bc-text-3">Loading&hellip;</p>
          ) : (
            <RecentFlags metrics={metrics} />
          )}
        </div>
      </Panel>
    </div>
  );
}

export interface DeskMetricsClientProps {
  leagueId: Id<"leagues">;
  isCommissioner: boolean;
}

export function DeskMetricsClient({ leagueId, isCommissioner }: DeskMetricsClientProps) {
  if (!isCommissioner) return <CommissionerOnly />;
  return (
    <CommissionerBoundary>
      <DeskMetricsBody leagueId={leagueId} />
    </CommissionerBoundary>
  );
}
