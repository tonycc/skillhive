import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "integrations/**/*.test.mjs", "scripts/**/*.test.mjs"],
    environment: "node",
    passWithNoTests: false,
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
