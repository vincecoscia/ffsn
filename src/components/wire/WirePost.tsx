"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { Panel, PersonaAvatar, personaName, personaRole } from "@/components/broadcast";
import { useNow } from "@/components/useNow";
import { ARTICLE_PATH_RE, extractArticleId, stripArticlePaths } from "@/lib/ai/wire/articleLink";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { ManagerPlate } from "./ManagerPlate";
import { WireReactionBar } from "./WireReactionBar";
import { WireReplyComposer } from "./WireReplyComposer";
import { WireTagChip } from "./WireTagChip";
import type { WireAuthorRefView, WireReactionsView, WireReplyItem } from "./useLeagueWire";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * "4m ago" while fresh, then "Sun 4:25 PM" through the week, then "Sep 5" once it's older than
 * that (spec deliverable #1). Exported so `WirePanel.tsx`'s compact rows use the same rule.
 */
export function formatWireTime(createdAt: number, now: number): string {
  const diffMs = Math.max(0, now - createdAt);
  if (diffMs < MINUTE_MS) return "Just now";
  if (diffMs < 60 * MINUTE_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < 7 * DAY_MS) {
    return new Date(createdAt).toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "ESPN" / "Sleeper" from a source's `type`, or `null` when the source can't be labeled. */
function sourceLabel(type: string): string | null {
  if (type.startsWith("espn")) return "ESPN";
  if (type === "sleeper") return "Sleeper";
  return null;
}

/**
 * A "Delete" text action with a two-tap confirm (spec §17.2, deliverable #5): the first tap asks
 * for confirmation, the second calls `wire.deletePost`; losing focus cancels the confirm state.
 */
function DeleteAction({ leagueId, postId }: { leagueId: Id<"leagues">; postId: string }) {
  const deletePost = useMutation(api.wire.deletePost);
  const [confirming, setConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleClick = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setIsDeleting(true);
    try {
      await deletePost({ leagueId, postId: postId as Id<"wireLeaguePosts"> });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete this post");
      setConfirming(false);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onBlur={() => setConfirming(false)}
      disabled={isDeleting}
      className={cn(
        "bc-label-sm transition-colors",
        confirming ? "text-bc-red-text" : "text-bc-text-3 hover:text-bc-red-text"
      )}
    >
      {isDeleting ? "Deleting..." : confirming ? "Confirm delete?" : "Delete"}
    </button>
  );
}

interface WireReplyRowProps {
  reply: WireReplyItem;
  leagueId: Id<"leagues">;
  now: number;
  replyAsTeamName?: string;
  viewerUserId?: string;
  isCommissioner?: boolean;
}

/** One reply in a thread: a manager plate or a writer byline, relative time, the text (or the
 *  removed placeholder), and — unless removed — its own reaction bar, Reply toggle and Delete
 *  action (spec §17, deliverable #4). */
function WireReplyRow({ reply, leagueId, now, replyAsTeamName, viewerUserId, isCommissioner }: WireReplyRowProps) {
  const [replyOpen, setReplyOpen] = useState(false);
  // `replyViewValidator` carries no `canDelete` of its own (see convex/wire.ts's contract note in
  // this workstream's report) — reconstructed client-side from the same rule `toLeaguePostView`
  // applies server-side; `wire.deletePost` re-checks authorship/commissioner itself regardless.
  const canDelete =
    !reply.deleted && viewerUserId !== undefined && (reply.author?.userId === viewerUserId || !!isCommissioner);

  return (
    <div className="flex min-w-0 flex-col gap-2 border-l-2 border-bc-hairline pl-3">
      <div className="flex min-w-0 items-start gap-3">
        {reply.author ? (
          <ManagerPlate author={reply.author} size={28} meta={formatWireTime(reply.createdAt, now)} className="min-w-0 flex-1" />
        ) : (
          <>
            <PersonaAvatar persona={reply.persona ?? ""} size={28} className="flex-none" />
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="truncate font-display text-[13px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                {personaName(reply.persona ?? "")}
              </span>
              <span className="bc-label-sm truncate text-bc-text-3">{personaRole(reply.persona ?? "")}</span>
              <span className="bc-label-sm flex-none text-bc-text-3" aria-hidden="true">
                &middot;
              </span>
              <span className="bc-label-sm flex-none text-bc-text-3">{formatWireTime(reply.createdAt, now)}</span>
            </div>
          </>
        )}
      </div>

      {reply.deleted ? (
        <p className="min-w-0 text-[14px] leading-relaxed text-bc-text-3 italic">{reply.text}</p>
      ) : (
        <>
          <p className="min-w-0 text-[14px] leading-relaxed text-bc-ink">{reply.text}</p>
          <WireReactionBar leagueId={leagueId} scope="league" postId={reply._id} reactions={reply.reactions} />
          <div className="flex items-center gap-4">
            {replyAsTeamName && !replyOpen && (
              <button
                type="button"
                onClick={() => setReplyOpen(true)}
                className="bc-label-sm text-bc-text-3 transition-colors hover:text-bc-red-text"
              >
                Reply
              </button>
            )}
            {canDelete && <DeleteAction leagueId={leagueId} postId={reply._id} />}
          </div>
          {replyOpen && replyAsTeamName && (
            <WireReplyComposer
              leagueId={leagueId}
              replyTo={{ scope: "league", id: reply._id }}
              teamName={replyAsTeamName}
              onPosted={() => setReplyOpen(false)}
              onCancel={() => setReplyOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

export interface WirePostCardProps {
  /** Writer slug for a desk post; absent on a manager post (then `author` is set instead). */
  persona?: string;
  /** The manager author of a `manager_post` — renders a `ManagerPlate` in place of the writer plate. */
  author?: WireAuthorRefView;
  text: string;
  /** Wire tags as plain strings — see `useLeagueWire.ts`. */
  tags: string[];
  createdAt: number;
  /** Only global posts carry a status; `"take_pending"` renders the "…is on it" line. */
  status?: string;
  source?: { type: string; url?: string };
  /** The published article this post announces (league `article_published` posts only) — renders a
   *  linked card in place of the old raw "/articles/<id>" text. */
  article?: { id: string; title: string; persona?: string };
  /** Nested overlay blocks for a global post — rendered beneath the text, above the reply thread. */
  children?: ReactNode;
  className?: string;

  /** Target for this post's reactions and for a reply posted directly to it. */
  leagueId: Id<"leagues">;
  scope: "global" | "league";
  postId: string;
  reactions: WireReactionsView;
  /** This post's thread, oldest first. Absent/empty renders no thread section. */
  replies?: WireReplyItem[];
  /** Soft-deleted by the author or the commissioner; `text` is already the placeholder. */
  deleted?: boolean;
  /** True when the viewer may delete this post (author or commissioner) — global posts never set this. */
  canDelete?: boolean;
  /** The viewer's claimed team name; absent hides every Reply affordance on this post and its thread
   *  (spec §17.2, deliverable #3: only members with a claimed team may reply). */
  replyAsTeamName?: string;
  /** Clerk user id of the signed-in viewer — needed to compute `canDelete` on replies client-side. */
  viewerUserId?: string;
  isCommissioner?: boolean;
}

/**
 * One Wire post: a writer or manager byline, relative time, tag chips, the text, an optional
 * source link, a reaction bar, Reply/Delete actions and — under any nested overlay blocks — the
 * reply thread (spec §2, §17).
 */
export function WirePost({
  persona,
  author,
  text,
  tags,
  createdAt,
  status,
  source,
  article,
  children,
  className,
  leagueId,
  scope,
  postId,
  reactions,
  replies,
  deleted,
  canDelete,
  replyAsTeamName,
  viewerUserId,
  isCommissioner,
}: WirePostCardProps) {
  const now = useNow(30_000);
  const [replyOpen, setReplyOpen] = useState(false);
  const firstName = persona ? personaName(persona).split(" ")[0] : undefined;
  const label = source ? sourceLabel(source.type) : null;
  // Old rows (written before the article-link change) still carry the raw "/articles/<id>" path in
  // `text`; `article` is absent on those, so this recovers the id to render an inline link. Deleted
  // posts keep their placeholder text verbatim either way.
  const legacyArticleId = !deleted && !article ? extractArticleId(text) : undefined;

  return (
    <Panel padding="md" className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {author ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <ManagerPlate author={author} size={40} meta={formatWireTime(createdAt, now)} />
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <WireTagChip key={tag} tag={tag} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <PersonaAvatar persona={persona ?? ""} size={40} className="flex-none" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="truncate font-display text-[15px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                  {personaName(persona ?? "")}
                </span>
                <span className="bc-label-sm truncate text-bc-text-3">{personaRole(persona ?? "")}</span>
                <span className="bc-label-sm flex-none text-bc-text-3" aria-hidden="true">
                  &middot;
                </span>
                <span className="bc-label-sm flex-none text-bc-text-3">{formatWireTime(createdAt, now)}</span>
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <WireTagChip key={tag} tag={tag} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <p className={cn("min-w-0 text-[15px] leading-relaxed", deleted ? "text-bc-text-3 italic" : "text-bc-ink")}>
        {article ? (
          stripArticlePaths(text)
        ) : legacyArticleId ? (
          <>
            {text.split(ARTICLE_PATH_RE)[0]}
            <Link
              href={`/articles/${legacyArticleId}`}
              className="underline decoration-bc-hairline underline-offset-2 transition-colors hover:text-bc-red-text"
            >
              Read it
            </Link>
            {text.split(ARTICLE_PATH_RE)[1]}
          </>
        ) : (
          text
        )}
      </p>

      {status === "take_pending" && (
        <p className="bc-label-sm text-bc-text-3">{firstName} is on it&hellip;</p>
      )}

      {label &&
        (source?.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit text-[13px] font-semibold text-bc-text-3 underline decoration-bc-hairline underline-offset-2 transition-colors hover:text-bc-red-text"
          >
            {label}
          </a>
        ) : (
          <span className="w-fit text-[13px] font-semibold text-bc-text-3">{label}</span>
        ))}

      {article && !deleted && (
        <Link
          href={`/articles/${article.id}`}
          className="group flex flex-col gap-1 border border-bc-hairline bg-bc-panel-2 p-3 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-bc-red/50"
        >
          <span className="bc-label-sm text-bc-text-3">
            {article.persona ? personaRole(article.persona) : "NEW PIECE"}
          </span>
          <span className="font-display text-[17px] font-bold uppercase tracking-[0.01em] text-bc-ink">
            {article.title}
          </span>
          <span className="bc-label-sm text-bc-text-3 transition-colors group-hover:text-bc-red-text">
            Read the piece
          </span>
        </Link>
      )}

      {children}

      {!deleted && (
        <>
          <WireReactionBar leagueId={leagueId} scope={scope} postId={postId} reactions={reactions} />
          <div className="flex items-center gap-4">
            {replyAsTeamName && !replyOpen && (
              <button
                type="button"
                onClick={() => setReplyOpen(true)}
                className="bc-label-sm text-bc-text-3 transition-colors hover:text-bc-red-text"
              >
                Reply
              </button>
            )}
            {canDelete && <DeleteAction leagueId={leagueId} postId={postId} />}
          </div>
          {replyOpen && replyAsTeamName && (
            <WireReplyComposer
              leagueId={leagueId}
              replyTo={{ scope, id: postId }}
              teamName={replyAsTeamName}
              onPosted={() => setReplyOpen(false)}
              onCancel={() => setReplyOpen(false)}
            />
          )}
        </>
      )}

      {replies && replies.length > 0 && (
        <div className="flex flex-col gap-4 border-t border-bc-hairline pt-3">
          {replies.map((reply) => (
            <WireReplyRow
              key={reply._id}
              reply={reply}
              leagueId={leagueId}
              now={now}
              replyAsTeamName={replyAsTeamName}
              viewerUserId={viewerUserId}
              isCommissioner={isCommissioner}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
