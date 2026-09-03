import { defineConfig } from "vitest/config";

/** Real-target live smoke only (§10, L12). Never run by `pnpm check`. */
export default defineConfig({
  test: {
    include: ["test/live-smoke/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    reporters: ["default"],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
