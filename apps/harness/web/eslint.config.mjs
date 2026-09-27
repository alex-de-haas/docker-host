import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".next*/**",
    "out/**",
    // This project's distDir: the export is generated, and linting minified output reports
    // hundreds of failures that belong to the bundler.
    "out-build/**",
    "build/**",
    "next-env.d.ts"
  ])
]);

export default eslintConfig;
