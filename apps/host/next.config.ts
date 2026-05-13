import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  serverExternalPackages: ["dockerode", "docker-modem", "ssh2"],
};

export default nextConfig;
