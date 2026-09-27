import type { NextConfig } from "next";

// A static export, not a server. The gateway is one Node process and stays one: `next build` emits
// plain HTML/JS that that process serves, so the standard component stack costs no second runtime.
// See docs/features/app-ui-surfaces/plan.md — a telemetry-style `ui` service for a settings form
// would have been the heaviest possible reading of "one stack".
const nextConfig: NextConfig = {
  output: "export",
  distDir: "out-build",
  // Relative asset paths: the page is served from the gateway's own origin under both / and
  // /settings, and an absolute prefix baked at build time is exactly the bug the telemetry UI
  // shipped once (a localhost origin frozen into static layouts).
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
