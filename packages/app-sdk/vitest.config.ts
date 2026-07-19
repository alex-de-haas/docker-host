import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // The real `server-only` throws outside a React Server Component environment by
      // design; tests exercise the server slice directly, so stub it out.
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
});
