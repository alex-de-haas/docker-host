import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // The real `server-only` throws outside a React Server Component environment by
      // design; route tests exercise SDK server code directly, so stub it out.
      "server-only": path.resolve(__dirname, "../../packages/app-sdk/test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
