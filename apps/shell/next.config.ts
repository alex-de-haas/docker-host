import type { NextConfig } from "next";
import path from "node:path";
import { createRequire } from "node:module";

// Bake the Shell's own manifest version into the build so it can be surfaced in the UI.
const { version: shellVersion } = createRequire(import.meta.url)("./package.json") as { version: string };

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  env: {
    NEXT_PUBLIC_SHELL_VERSION: shellVersion,
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  output: "standalone",
  // The SDK ships TypeScript source from the workspace; Next transpiles it in place.
  transpilePackages: ["@hosty-sdk/app"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The Shell embeds runtime apps, but is never embedded itself.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
