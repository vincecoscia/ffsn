"use client";

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  preview?: boolean; // If true, shows a truncated preview
  maxLines?: number; // For preview mode
}

export function MarkdownPreview({
  content,
  className,
  preview = false,
  maxLines = 3
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
    const plainText = content
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
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
