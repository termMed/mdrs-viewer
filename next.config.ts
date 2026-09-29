import type { NextConfig } from "next";

// `STATIC_EXPORT=1 npm run build` produces a self-contained static site in ./out
// (everything runs in the browser; no server features are used).
const nextConfig: NextConfig = {
  output: process.env.STATIC_EXPORT ? "export" : undefined,
  assetPrefix: process.env.STATIC_EXPORT ? "./" : undefined,
  images: { unoptimized: true },
};

export default nextConfig;
