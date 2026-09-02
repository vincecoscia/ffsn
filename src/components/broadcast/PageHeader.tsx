import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  kicker?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Sub-page header: kicker label, a big responsive `bc-display` title, optional description and an actions slot. */
export function PageHeader({ kicker, title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        {kicker && <span className="bc-label text-bc-text-2">{kicker}</span>}
        <h1 className="bc-display text-[32px] text-bc-ink sm:text-[40px] lg:text-[48px]">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-[15px] leading-relaxed text-bc-text-2 sm:text-[16px]">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-none items-center gap-3">{actions}</div>}
    </div>
  );
}
