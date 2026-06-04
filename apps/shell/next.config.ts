import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
