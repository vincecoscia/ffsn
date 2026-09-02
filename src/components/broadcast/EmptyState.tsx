import type { ReactNode } from "react";

import { Panel } from "./Panel";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Icon + condensed title + description + optional action, sitting inside a `Panel`. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <Panel padding="lg" className={cn("flex flex-col items-center gap-4 text-center", className)}>
      {icon && (
        <span className="inline-flex size-14 items-center justify-center border border-bc-hairline bg-bc-panel-2 text-bc-text-2">
          {icon}
        </span>
      )}
      <div className="flex flex-col gap-2">
        <span className="font-display text-[20px] font-extrabold tracking-[0.01em] text-bc-ink uppercase">
          {title}
        </span>
        {description && (
          <p className="max-w-md text-[14px] leading-relaxed text-bc-text-2">{description}</p>
        )}
      </div>
      {action}
    </Panel>
  );
}
