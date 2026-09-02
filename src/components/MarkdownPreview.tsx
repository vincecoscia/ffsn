"use client";

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentPropsWithoutRef } from 'react';
import type { GeneratedArticleT } from '@/lib/ai/content-generation-service';
import { PullQuote } from '@/components/broadcast';
import { cn } from '@/lib/utils';

/**
 * A ledger quote as it is stored on `aiContent.quotes` (spec §4.2). Structurally the
 * generator's `ArticleQuote`, with `writerResponse` optional because the stored
 * validator allows an older article to have none.
 */
export type ArticleQuote = Omit<GeneratedArticleT['quotes'][number], 'writerResponse'> & {
  writerResponse?: string;
};

/**
 * The body directive a writer uses to place a ledger quote (spec §8.3):
 * a paragraph that is exactly `:::quote{id=Q1}`.
 */
const QUOTE_DIRECTIVE = /^:::quote\{id=([A-Za-z0-9_-]+)\}$/;

/** Same directive, line-anchored, for scanning raw markdown. */
const QUOTE_DIRECTIVE_LINE = /^[ \t]*:::quote\{id=([A-Za-z0-9_-]+)\}[ \t]*$/gm;

/**
 * The quote ids a body places inline. The article page uses this to keep the trailing
 * "From the sideline" block to the quotes that were *not* placed in the prose.
 */
export function placedQuoteIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const match of content.matchAll(QUOTE_DIRECTIVE_LINE)) {
    ids.add(match[1]);
  }
  return ids;
}

/** Strip directive lines out of text that is shown as plain prose (previews, excerpts). */
function stripQuoteDirectives(content: string): string {
  return content.replace(QUOTE_DIRECTIVE_LINE, '');
}

/** Minimal shape of the hast node react-markdown hands each renderer. */
type HastNode = { type?: string; value?: string; children?: HastNode[] };

/** Concatenated text of a rendered node, so a paragraph can be matched against the directive. */
function nodeText(node: HastNode | undefined): string {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  preview?: boolean; // If true, shows a truncated preview
  maxLines?: number; // For preview mode
  /**
   * The article's ledger quotes (`aiContent.quotes`). When given, every
   * `:::quote{id=…}` directive in the body renders as a `PullQuote`. A directive whose
   * id isn't in this list renders nothing — never the raw directive text.
   */
  quotes?: ArticleQuote[];
  /** Week for the pull quote's red strip ("Told FFSN Sideline · Week 7"). */
  quoteWeek?: number;
  /** Writer slug, for the byline on the writer's in-voice reply under each quote. */
  quotePersona?: string;
  /** Resolves a quote's `teamId` (a FACTS id or a Convex team id) to a team name. */
  resolveTeamName?: (teamId: string) => string | undefined;
}

export function MarkdownPreview({
  content,
  className,
  preview = false,
  maxLines = 3,
  quotes,
  quoteWeek,
  quotePersona,
  resolveTeamName,
}: MarkdownPreviewProps) {
  // Helper function to get static line-clamp class
  const getLineClampClass = (lines: number) => {
    switch (lines) {
      case 1: return 'line-clamp-1';
      case 2: return 'line-clamp-2';
      case 3: return 'line-clamp-3';
      case 4: return 'line-clamp-4';
      case 5: return 'line-clamp-5';
      case 6: return 'line-clamp-6';
      default: return 'line-clamp-3'; // fallback to 3 lines
    }
  };

  // For preview mode, we'll show plain text instead of rendered markdown
  // to avoid complexity in truncation
  if (preview) {
    // Simple text extraction from markdown
    const plainText = stripQuoteDirectives(content)
      .replace(/#{1,6}\s+/g, '') // Remove headers
      .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.*?)\*/g, '$1') // Remove italic
      .replace(/`(.*?)`/g, '$1') // Remove inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
      .replace(/^\s*[-*+]\s+/gm, '') // Remove list markers
      .replace(/^\s*\d+\.\s+/gm, '') // Remove numbered list markers
      .trim();

    return (
      <p className={cn(
        "text-bc-body leading-relaxed",
        getLineClampClass(maxLines),
        className
      )}>
        {plainText}
      </p>
    );
  }

  // Quotes are addressed by the FACTS id the writer put in the directive.
  const quoteById = new Map((quotes ?? []).map((quote) => [quote.quoteId, quote]));

  // Rendered markdown: no typographic classes of our own — headings, lists,
  // blockquotes, tables and links are styled entirely by the `.bc-prose`
  // wrapper the consuming page provides (see globals.css), so this stays a
  // plain semantic render and never fights those tokens.
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Customize link rendering for security
          a: ({ ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
          // A paragraph that is only a `:::quote{id=…}` directive is a placed pull
          // quote, not prose (spec §8.3). Replacing the <p> outright matters: the
          // quote renders a <figure>/<blockquote>, which may not sit inside one.
          p: ({ node, children, ...props }: ComponentPropsWithoutRef<'p'> & { node?: HastNode }) => {
            const directive = QUOTE_DIRECTIVE.exec(nodeText(node).trim());
            if (directive) {
              const quote = quoteById.get(directive[1]);
              // An id we can't resolve prints nothing at all — the reader must never
              // see the directive, and the verifier already flags the unknown id.
              if (!quote) return null;
              return (
                <PullQuote
                  className="my-8"
                  quote={quote.text}
                  speaker={quote.speaker}
                  team={resolveTeamName?.(quote.teamId)}
                  week={quoteWeek}
                  writerResponse={quote.writerResponse}
                  writerPersona={quotePersona}
                />
              );
            }
            return <p {...props}>{children}</p>;
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
