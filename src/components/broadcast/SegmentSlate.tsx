import { cn } from "@/lib/utils";

export interface SegmentSlateProps {
  /** e.g. "Seg 01" */
  code: string;
  /** e.g. "On-air talent" */
  label: string;
  className?: string;
}

/** The "SEG 01" red plate + muted label pair used above marketing section headings. */
export function SegmentSlate({ code, label, className }: SegmentSlateProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="bc-label inline-flex h-[26px] flex-none items-center bg-bc-red px-2.5 text-white">
        {code}
      </span>
      <span className="bc-label text-bc-text-2">{label}</span>
    </div>
  );
}
