import Link from "next/link";

import { cn } from "@/lib/utils";

export interface BrandLogoProps {
  /** Rendered logo height: 32 / 44 / 58px. */
  size?: "sm" | "md" | "lg";
  /** Where the logo links to. Pass `null` to render a plain (non-link) mark. */
  href?: string | null;
  className?: string;
}

/** Rendered heights. `lg` steps down to 44px below the `sm` breakpoint so the 76px bar fits a phone. */
const SIZE_CLASS: Record<NonNullable<BrandLogoProps["size"]>, string> = {
  sm: "h-8",
  md: "h-10",
  lg: "h-10 sm:h-[50px]",
};

/** The FFSN wordmark image, fixed-height / auto-width, linking home by default. */
export function BrandLogo({ size = "md", href = "/", className }: BrandLogoProps) {
  const mark = (
    <img
      src="/FFSN.png"
      alt="FFSN"
      className={cn("block w-auto", SIZE_CLASS[size])}
    />
  );

  if (!href) {
    return (
      <span className={cn("inline-flex flex-none items-center", className)}>{mark}</span>
    );
  }

  return (
    <Link
      href={href}
      aria-label="FFSN home"
      className={cn("inline-flex flex-none items-center", className)}
    >
      {mark}
    </Link>
  );
}
