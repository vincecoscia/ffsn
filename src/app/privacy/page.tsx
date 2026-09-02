import { MarkdownPreview } from '@/components/MarkdownPreview';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import fs from 'fs';
import path from 'path';

export const metadata = {
  title: 'Privacy Policy',
  description: 'How FFSN collects, uses, and protects your information.',
};

export default async function PrivacyPolicyPage() {
  // Read the markdown content at build time
  const policyPath = path.join(process.cwd(), 'src', 'content', 'privacy-policy.md');
  const policyContent = fs.readFileSync(policyPath, 'utf-8');

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
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Privacy Policy</h1>
          <p className="text-gray-600">
            What we collect, how we use it, and the choices you have.
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-8">
          <MarkdownPreview content={policyContent} />
        </div>

        <div className="mt-8 text-center text-sm text-gray-600">
          <p>
            Questions about this policy? Email{' '}
            <a href="mailto:support@ffsn.ai" className="text-blue-600 hover:text-blue-800 underline">
              support@ffsn.ai
            </a>{' '}
            or visit our{' '}
            <Link href="/contact" className="text-blue-600 hover:text-blue-800 underline">
              contact page
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
