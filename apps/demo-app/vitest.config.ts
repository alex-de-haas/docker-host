import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "server-only": fileURLToPath(new URL("../../packages/app-sdk/test/server-only-stub.ts", import.meta.url)),
  } },
  test: { environment: "jsdom", include: ["test/*.test.ts", "test/*.test.tsx"] },
});
