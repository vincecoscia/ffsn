import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "@/components/convex-client-provider";
// import { AuthSync } from "@/components/auth-sync";
import { Toaster } from "@/components/ui/sonner";
import { Theme } from "@radix-ui/themes";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FFSN - Fantasy Football Sports Network",
  description: "AI-powered fantasy football content for your league",
  keywords: ["fantasy football", "NFL", "AI content", "league management", "fantasy sports"],
  authors: [{ name: "FFSN Team" }],
  creator: "FFSN",
  publisher: "FFSN",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://ffsn.ai'),
  openGraph: { 
    type: 'website',
    locale: 'en_US',
    url: process.env.NEXT_PUBLIC_SITE_URL || 'https://ffsn.ai',
    siteName: 'FFSN - Fantasy Football Social Network',
    title: 'FFSN - Fantasy Football Sports Network',
    description: 'AI-powered fantasy football content for your league',
    images: [
      {
        url: '/FFSN.png',
        width: 512,
        height: 512,
        alt: 'FFSN Logo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@ffsn_ai',
    creator: '@ffsn_ai',
    title: 'FFSN - Fantasy Football Sports Network',
    description: 'AI-powered fantasy football content for your league',
    images: ['/FFSN.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="apple-mobile-web-app-title" content="FFSN" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ClerkProvider>
          <ConvexClientProvider>
            {/* <AuthSync> */}
              <Theme>{children}</Theme>
            {/* </AuthSync> */}
            <Toaster />
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
