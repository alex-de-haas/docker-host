import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@hosty-sdk/app"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  allowedDevOrigins: ["127.0.0.1", "localhost", "[::1]", "*.hosty.localhost"],
  ...(process.env.NEXT_DIST_DIR?.trim() ? { distDir: process.env.NEXT_DIST_DIR.trim() } : {}),
};
export default nextConfig;
