import { MarkdownPreview } from '@/components/MarkdownPreview';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import fs from 'fs';
import path from 'path';

export const metadata = {
  title: 'Terms of Service',
  description: 'Terms of Service for our fantasy football application',
};

export default async function TermsOfServicePage() {
  // Read the markdown content at build time
  const termsPath = path.join(process.cwd(), 'src', 'content', 'terms-of-service.md');
  const termsContent = fs.readFileSync(termsPath, 'utf-8');

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Back to home link */}
        <Link 
          href="/" 
          className="inline-flex items-center text-gray-600 hover:text-gray-900 transition-colors mb-8"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Home
        </Link>

        {/* Header */}
        <div className="bg-white rounded-lg shadow-sm p-8 mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Terms of Service</h1>
          <p className="text-gray-600">
            Please read these terms carefully before using our service.
          </p>
        </div>

        {/* Terms Content */}
        <div className="bg-white rounded-lg shadow-sm p-8">
          <MarkdownPreview content={termsContent} />
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>
            Last updated: {new Date().toLocaleDateString()}
          </p>
          <p className="mt-2">
            If you have any questions about these Terms, please{' '}
            <Link href="/contact" className="text-blue-600 hover:text-blue-800 underline">
              contact us
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}