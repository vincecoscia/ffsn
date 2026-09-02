import { cn } from "@/lib/utils";

export interface TeamTileProps {
  initials: string;
  /** Team logo image; falls back to the diagonal-split monogram tile when omitted. */
  src?: string;
  alt?: string;
  /** Tile size in px. Default 36. */
  size?: number;
  /** `"accent"` renders a solid red tile (e.g. the viewer's own team, a commissioner avatar). */
  tone?: "default" | "accent";
  className?: string;
}

/** Square team monogram tile with the diagonal-split background, or a team logo image when `src` is given. */
export function TeamTile({ initials, src, alt, size = 36, tone = "default", className }: TeamTileProps) {
  if (src) {
    return (
      <span
        className={cn(
          "inline-flex flex-none overflow-hidden border border-bc-border-strong",
          className
        )}
        style={{ width: size, height: size }}
      >
        <img src={src} alt={alt ?? initials} className="h-full w-full object-cover" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center border font-display font-extrabold tracking-[0.04em]",
        tone === "accent"
          ? "border-bc-red bg-bc-red text-white"
          : "border-bc-border-strong text-bc-ink",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.4)),
        backgroundImage:
          tone === "accent"
            ? undefined
            : "linear-gradient(135deg, var(--bc-hairline) 50%, var(--bc-panel-2) 50%)",
      }}
    >
      {initials}
    </span>
  );
}
