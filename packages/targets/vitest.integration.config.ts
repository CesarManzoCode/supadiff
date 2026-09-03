import { defineConfig } from "vitest/config";

/** Real-target integration tests only (§15, L6+). Never run by `pnpm check`. */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    reporters: ["default"],
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});
