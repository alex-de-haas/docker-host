import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.hosty.localhost"],
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@hosty-sdk/app"],
  experimental: { turbopackFileSystemCacheForDev: false, optimizePackageImports: ["lucide-react"] },
  distDir: process.env.NEXT_DIST_DIR || (process.env.NODE_ENV === "development" ? ".next-dev" : ".next"),
  devIndicators: false,
  webpack(config) { config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] }; return config; },
  async headers() { return [{ source: "/:path*", headers: [
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ] }]; },
};
export default config;
