import { ImageResponse } from "next/og";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ArticleCard, CARD_SIZE, SiteCard, loadCardFonts, loadLogoDataUrl } from "@/lib/og/card";
import { getPersonaDisplay } from "@/lib/ai/persona-prompts";
import { contentTypeLabel } from "@/components/broadcast/personaRoster";

export const alt = "FFSN story";
export const size = CARD_SIZE;
export const contentType = "image/png";
/** A published story's card can be cached; the headline does not change. */
export const revalidate = 3600;

const isConvexId = (value: string): boolean => /^[a-z0-9]{32}$/.test(value);

/**
 * The link-preview card for one story: headline, league, week and byline on the Broadcast
 * plate, with the story's banner art dimmed behind it when there is one. Anything that is
 * not a readable published article gets the site card instead of an error.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [fonts, logo] = await Promise.all([loadCardFonts(), loadLogoDataUrl().catch(() => undefined)]);

  if (!isConvexId(id) || !process.env.NEXT_PUBLIC_CONVEX_URL) {
    return new ImageResponse(<SiteCard logo={logo} />, { ...CARD_SIZE, fonts });
  }

  try {
    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
    const article = await convex.query(api.aiContent.getById, { articleId: id as Id<"aiContent"> });
    if (!article) return new ImageResponse(<SiteCard logo={logo} />, { ...CARD_SIZE, fonts });

    const league = await convex.query(api.leagues.getPublicInfo, { id: article.leagueId });
    const writer = getPersonaDisplay(article.persona);

    return new ImageResponse(
      (
        <ArticleCard
          title={article.title}
          leagueName={league?.name ?? "FFSN"}
          storyLabel={contentTypeLabel(article.type)}
          week={article.metadata?.week}
          writerName={writer.name}
          writerRole={writer.role}
          bannerUrl={article.bannerImageUrl ?? undefined}
          logo={logo}
        />
      ),
      { ...CARD_SIZE, fonts }
    );
  } catch (error) {
    console.error("Article card failed; serving the site card instead:", error);
    return new ImageResponse(<SiteCard logo={logo} />, { ...CARD_SIZE, fonts });
  }
}
