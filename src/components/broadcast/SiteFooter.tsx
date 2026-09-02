import Link from "next/link";

import { BrandLogo } from "./BrandLogo";
import { cn } from "@/lib/utils";

export interface SiteFooterLink {
  label: string;
  href: string;
}

const DEFAULT_LINKS: SiteFooterLink[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Contact", href: "/contact" },
];

export interface SiteFooterProps {
  links?: SiteFooterLink[];
  className?: string;
}

/** Site-wide footer: logo, network label, a link row and the copyright line. */
export function SiteFooter({ links = DEFAULT_LINKS, className }: SiteFooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer
      className={cn(
        "flex flex-col gap-8 border-t border-bc-hairline bg-bc-ground px-4 py-10 sm:px-6 lg:px-12",
        className
      )}
    >
      <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-5">
          <BrandLogo size="sm" href="/" />
          <div className="hidden h-8 w-px flex-none bg-bc-hairline sm:block" aria-hidden="true" />
          <span className="bc-label-sm text-bc-text-3">Fantasy Football Sports Network</span>
        </div>
        <nav className="-mx-3 flex flex-wrap items-center" aria-label="Footer">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex h-11 items-center px-3 font-display text-[15px] font-semibold tracking-[0.08em] text-bc-text-2 uppercase hover:text-bc-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center justify-between border-t border-bc-hairline pt-5">
        <span className="bc-label-sm text-bc-text-3">© {year} FFSN</span>
      </div>
    </footer>
  );
}
