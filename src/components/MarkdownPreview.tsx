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
        "text-gray-700 leading-relaxed",
        `line-clamp-${maxLines}`,
        className
      )}>
        {plainText}
      </p>
    );
  }

  return (
    <div className={cn("prose prose-sm max-w-none prose-a:text-red-600 prose-a:hover:text-red-800", className)}>
      <Markdown 
        remarkPlugins={[remarkGfm]}
        components={{
          // Customize link rendering for security
          a: ({ node, ...props }) => (
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