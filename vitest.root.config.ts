import { defineConfig } from "vitest/config";

/** Cross-package tests living at the repo root (§13.1: test/fault-lab, test/golden-artifacts). */
export default defineConfig({
  test: {
    include: ["test/fault-lab/**/*.test.ts", "test/golden-artifacts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default"],
    testTimeout: 30000,
    passWithNoTests: true,
  },
});
