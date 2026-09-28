import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@hosty-sdk/app/install/react": fileURLToPath(new URL("../../packages/app-sdk/src/install-react.tsx", import.meta.url)), "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "jsdom", include: ["test/*.test.tsx", "test/resource-data.test.ts"] },
});
