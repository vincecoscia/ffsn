import Link from "next/link";
import { CreditCard, FileText, Mail, ShieldCheck } from "lucide-react";

import { SiteHeader, SiteFooter, PageHeader, Panel } from "@/components/broadcast";

export const metadata = {
  title: "Contact FFSN",
  description: "How to reach FFSN support for account, billing, and league questions.",
};

export default function ContactPage() {
  return (
    <div className="flex min-h-screen flex-col bg-bc-ground">
      <SiteHeader />

      <main className="flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-12">
        <div className="mx-auto flex w-full max-w-[72ch] flex-col gap-10">
          <PageHeader
            kicker="Get in touch"
            title="Contact"
            description="FFSN is an AI-written sports network for your fantasy football league. One inbox handles everything: account help, billing, league imports, and content questions."
          />

          <Panel padding="lg" className="flex flex-col gap-8">
            <div className="flex items-start gap-4">
              <span className="flex size-11 flex-none items-center justify-center border border-bc-red bg-transparent text-bc-red-text">
                <Mail className="size-5" strokeWidth={1.8} />
              </span>
              <div className="flex flex-col gap-1.5">
                <h2 className="bc-h-title text-[22px]">Support</h2>
                <p className="text-[16px] leading-relaxed text-bc-text-2">
                  Email{" "}
                  <a
                    href="mailto:support@ffsn.ai"
                    className="text-bc-red-text underline-offset-4 hover:underline"
                  >
                    support@ffsn.ai
                  </a>
                  . We reply within two business days, and faster during the NFL season.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-8 border-t border-bc-hairline pt-8 sm:grid-cols-3">
              <div className="flex flex-col gap-2.5">
                <CreditCard className="size-5 text-bc-text-3" strokeWidth={1.8} />
                <h3 className="bc-label text-bc-ink">Billing</h3>
                <p className="text-[14px] leading-relaxed text-bc-text-2">
                  Purchases are one-time credit packs and league setup fees, charged once. Your
                  card statement shows <span className="font-mono">FFSN.AI</span>. Refunds are
                  handled case by case; see the{" "}
                  <Link
                    href="/terms"
                    className="text-bc-red-text underline-offset-4 hover:underline"
                  >
                    Terms of Service
                  </Link>
                  .
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                <ShieldCheck className="size-5 text-bc-text-3" strokeWidth={1.8} />
                <h3 className="bc-label text-bc-ink">Privacy and data</h3>
                <p className="text-[14px] leading-relaxed text-bc-text-2">
                  To access, correct, or delete your data, email us from the address on your
                  account. Details are in the{" "}
                  <Link
                    href="/privacy"
                    className="text-bc-red-text underline-offset-4 hover:underline"
                  >
                    Privacy Policy
                  </Link>
                  .
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                <FileText className="size-5 text-bc-text-3" strokeWidth={1.8} />
                <h3 className="bc-label text-bc-ink">Business</h3>
                <p className="text-[14px] leading-relaxed text-bc-text-2">
                  FFSN is operated by VMEDIA LLC, doing business as FFSN, in the United States.
                  FFSN is not affiliated with ESPN or the NFL.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-center gap-3 border-t border-bc-hairline pt-6">
              <Link
                href="/terms"
                className="bc-label text-bc-text-2 hover:text-bc-ink"
              >
                Terms of Service
              </Link>
              <span className="bc-sep bc-sep-muted" aria-hidden="true" />
              <Link
                href="/privacy"
                className="bc-label text-bc-text-2 hover:text-bc-ink"
              >
                Privacy Policy
              </Link>
            </div>
          </Panel>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
