import type { NextConfig } from "next";
import path from "node:path";

const distDir = process.env.NEXT_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Next 16 blocks cross-origin dev-resource (HMR) requests by default; Core proxies the
  // app over the loopback IPs, so allow them explicitly in dev.
  allowedDevOrigins: ["127.0.0.1", "localhost", "[::1]"],
  ...(distDir ? { distDir } : {}),
};

export default nextConfig;
