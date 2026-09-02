import Link from 'next/link';
import { ChevronLeft, Mail, CreditCard, ShieldCheck, FileText } from 'lucide-react';

export const metadata = {
  title: 'Contact FFSN',
  description: 'How to reach FFSN support for account, billing, and league questions.',
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <Link
          href="/"
          className="inline-flex items-center text-gray-600 hover:text-gray-900 transition-colors mb-8"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Home
        </Link>

        <div className="bg-white rounded-lg shadow-sm p-8 mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Contact Us</h1>
          <p className="text-gray-600">
            FFSN is an AI-written sports network for your fantasy football league. One inbox
            handles everything: account help, billing, league imports, and content questions.
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-8 mb-8">
          <div className="flex items-start gap-4">
            <Mail className="h-6 w-6 text-red-600 mt-1 shrink-0" />
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Support</h2>
              <p className="text-gray-600 mt-1">
                Email{' '}
                <a href="mailto:support@ffsn.ai" className="text-blue-600 hover:text-blue-800 underline">
                  support@ffsn.ai
                </a>
                . We reply within two business days, and faster during the NFL season.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-3 mb-8">
          <div className="bg-white rounded-lg shadow-sm p-6">
            <CreditCard className="h-5 w-5 text-gray-500 mb-3" />
            <h3 className="font-semibold text-gray-900">Billing</h3>
            <p className="text-sm text-gray-600 mt-1">
              Purchases are one-time credit packs and league setup fees, charged once. Your card
              statement shows <span className="font-mono">FFSN.AI</span>. Refunds are handled
              case by case; see the{' '}
              <Link href="/terms" className="text-blue-600 hover:text-blue-800 underline">
                Terms of Service
              </Link>
              .
            </p>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-6">
            <ShieldCheck className="h-5 w-5 text-gray-500 mb-3" />
            <h3 className="font-semibold text-gray-900">Privacy and data</h3>
            <p className="text-sm text-gray-600 mt-1">
              To access, correct, or delete your data, email us from the address on your account.
              Details are in the{' '}
              <Link href="/privacy" className="text-blue-600 hover:text-blue-800 underline">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-6">
            <FileText className="h-5 w-5 text-gray-500 mb-3" />
            <h3 className="font-semibold text-gray-900">Business</h3>
            <p className="text-sm text-gray-600 mt-1">
              FFSN is operated by VMEDIA LLC, doing business as FFSN, in the United States. FFSN is
              not affiliated with ESPN or the NFL.
            </p>
          </div>
        </div>

        <div className="text-center text-sm text-gray-600">
          <Link href="/terms" className="text-blue-600 hover:text-blue-800 underline">
            Terms of Service
          </Link>
          {' · '}
          <Link href="/privacy" className="text-blue-600 hover:text-blue-800 underline">
            Privacy Policy
          </Link>
        </div>
      </div>
    </div>
  );
}
