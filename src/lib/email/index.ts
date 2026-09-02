/**
 * FFSN email templates (Broadcast design system).
 *
 * Usage from Convex:
 *
 *   import { renderLocalTemplate, localTemplateId } from "../src/lib/email";
 *   // queue: templateId = localTemplateId("comment_request"), data = CommentRequestEmailData
 *   // send:  const email = renderLocalTemplate(templateId, data)
 *
 * Usage for a one-off send:
 *
 *   const { subject, html, text, fromName } = renderArticlePublishedEmail({ ... });
 */

export * from "./templates";
export {
  contentTypeLabel,
  firstName,
  interviewerDisplay,
  personaInitials,
  shortName,
  writerDisplay,
} from "./labels";
export { SENDGRID_UNSUBSCRIBE_TAG, escapeHtml } from "./shell";
export { LIGHT_PALETTE, DARK_PALETTE, FONT_DISPLAY, FONT_TEXT } from "./theme";
