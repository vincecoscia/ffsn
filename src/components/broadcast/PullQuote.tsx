import { LowerThird } from "./LowerThird";
import { PersonaAvatar } from "./PersonaAvatar";
import { personaName } from "./personaRoster";
import { cn } from "@/lib/utils";

export interface PullQuoteProps {
  /** The verbatim ledger quote, without surrounding quotation marks. */
  quote: string;
  /** Who said it, e.g. "Priya Natarajan". */
  speaker: string;
  /** The speaker's team, shown in the byline plate's role line. */
  team?: string;
  /** Week the interview ran, for the red strip. */
  week?: number;
  /** The writer's in-voice reply to this quote (`quotes[].writerResponse`). */
  writerResponse?: string;
  /** Writer slug for the reply byline, e.g. "mel-diaper". */
  writerPersona?: string;
  /** Where the quote came from (spec §17.4): the default sideline interview, or a manager's public
   *  post on The Wire — changes the red strip's label to "Said on The Wire". */
  source?: "interview" | "wire";
  className?: string;
}

/**
 * A sideline quote as it appears under an article: the verbatim line, a `LowerThird`
 * naming the manager and their team, and — when the writer answered it — the reply
 * in the writer's own byline (spec §4.2 `ArticleQuote.writerResponse`).
 */
export function PullQuote({
  quote,
  speaker,
  team,
  week,
  writerResponse,
  writerPersona,
  source = "interview",
  className,
}: PullQuoteProps) {
  const base = source === "wire" ? "Said on The Wire" : "Told FFSN Sideline";
  const tag = typeof week === "number" ? `${base} · Week ${week}` : base;

  return (
    <figure className={cn("flex flex-col gap-3.5", className)}>
      {/*
        The `!` markers are deliberate: a pull quote placed inline by a `:::quote{id=…}`
        directive (spec §8.3) renders inside the page's `.bc-prose` wrapper, whose
        `blockquote` rule is a two-part selector and would otherwise outrank these
        single-class utilities and repaint the quote as a plain red prose block.
      */}
      <blockquote className="m-0! border-l-[5px] border-bc-red bg-bc-panel-2! px-4! py-4! [clip-path:none]! sm:px-5!">
        <p className="font-display! m-0! text-[19px]! leading-[1.2]! font-bold text-bc-ink! italic sm:text-[22px]!">
          &ldquo;{quote}&rdquo;
        </p>
      </blockquote>

      <figcaption className="flex flex-col gap-3">
        <LowerThird className="self-start" name={speaker} role={team} tag={tag} />

        {writerResponse && writerPersona && (
          <div className="flex items-start gap-3 border-t border-bc-hairline pt-3">
            <PersonaAvatar
              persona={writerPersona}
              size={32}
              className="mt-0.5 flex-none border border-bc-border-strong"
            />
            <p className="m-0! text-[15px]! leading-relaxed! text-bc-body">
              <span className="bc-label-sm mr-2 text-bc-red-text">
                {personaName(writerPersona)}
              </span>
              {writerResponse}
            </p>
          </div>
        )}
      </figcaption>
    </figure>
  );
}
