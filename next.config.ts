import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The link-preview cards (src/app/opengraph-image.tsx, articles/[id]/opengraph-image.tsx)
  // read Barlow Condensed and Archivo from src/app/og-fonts at request time; list the files
  // so Vercel's function bundling ships them with those routes.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./src/app/og-fonts/**/*"],
    "/twitter-image": ["./src/app/og-fonts/**/*"],
    "/articles/[id]/opengraph-image": ["./src/app/og-fonts/**/*"],
    "/articles/[id]/twitter-image": ["./src/app/og-fonts/**/*"],
  },
};

export default nextConfig;
