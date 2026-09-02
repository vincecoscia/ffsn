import Link from "next/link";
import fs from "fs";
import path from "path";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import { SiteHeader, SiteFooter, PageHeader, Panel } from "@/components/broadcast";

export const metadata = {
  title: "Terms of Service",
  description: "Terms of Service for our fantasy football application",
};

export default async function TermsOfServicePage() {
  // Read the markdown content at build time
  const termsPath = path.join(process.cwd(), "src", "content", "terms-of-service.md");
  const termsContent = fs.readFileSync(termsPath, "utf-8");

  return (
    <div className="flex min-h-screen flex-col bg-bc-ground">
      <SiteHeader />

      <main className="flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-12">
        <div className="mx-auto flex w-full max-w-[72ch] flex-col gap-10">
          <PageHeader
            kicker="Legal"
            title="Terms of Service"
            description="Please read these terms carefully before using our service."
          />

          <Panel padding="lg">
            <div className="bc-prose">
              <MarkdownPreview content={termsContent} />
            </div>
          </Panel>

          <p className="text-center text-[15px] leading-relaxed text-bc-text-2">
            Last updated: {new Date().toLocaleDateString()}
            <br />
            If you have any questions about these Terms, please{" "}
            <Link href="/contact" className="text-bc-red-text underline-offset-4 hover:underline">
              contact us
            </Link>
            .
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
