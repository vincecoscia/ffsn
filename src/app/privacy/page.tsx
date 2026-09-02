import Link from "next/link";
import fs from "fs";
import path from "path";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import { SiteHeader, SiteFooter, PageHeader, Panel } from "@/components/broadcast";

export const metadata = {
  title: "Privacy Policy",
  description: "How FFSN collects, uses, and protects your information.",
};

export default async function PrivacyPolicyPage() {
  // Read the markdown content at build time
  const policyPath = path.join(process.cwd(), "src", "content", "privacy-policy.md");
  const policyContent = fs.readFileSync(policyPath, "utf-8");

  return (
    <div className="flex min-h-screen flex-col bg-bc-ground">
      <SiteHeader />

      <main className="flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-12">
        <div className="mx-auto flex w-full max-w-[72ch] flex-col gap-10">
          <PageHeader
            kicker="Legal"
            title="Privacy Policy"
            description="What we collect, how we use it, and the choices you have."
          />

          <Panel padding="lg">
            <div className="bc-prose">
              <MarkdownPreview content={policyContent} />
            </div>
          </Panel>

          <p className="text-center text-[15px] leading-relaxed text-bc-text-2">
            Questions about this policy? Email{" "}
            <a
              href="mailto:support@ffsn.ai"
              className="text-bc-red-text underline-offset-4 hover:underline"
            >
              support@ffsn.ai
            </a>{" "}
            or visit our{" "}
            <Link href="/contact" className="text-bc-red-text underline-offset-4 hover:underline">
              contact page
            </Link>
            .
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
