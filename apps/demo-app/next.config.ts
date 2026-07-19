import type { NextConfig } from "next";
import path from "node:path";

const distDir = process.env.NEXT_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  output: "standalone",
  // The SDK ships TypeScript source from the workspace; Next transpiles it in place.
  transpilePackages: ["@haas/hosty-app-sdk"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  ...(distDir ? { distDir } : {}),
};

export default nextConfig;
