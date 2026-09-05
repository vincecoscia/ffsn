import { ImageResponse } from "next/og";
import { CARD_SIZE, SiteCard, loadCardFonts } from "@/lib/og/card";

export const alt = "FFSN, the sports network that only covers your league";
export const size = CARD_SIZE;
export const contentType = "image/png";

/** The site's link-preview card, in the Broadcast look. */
export default async function Image() {
  return new ImageResponse(<SiteCard />, { ...CARD_SIZE, fonts: await loadCardFonts() });
}
