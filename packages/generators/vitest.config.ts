import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

/**
 * `test/live-smoke/**` spawns a real Supalite target (`@supadiff/engine` +
 * `@supadiff/targets`) — deliberately excluded from the default `test`/`pnpm check`
 * run so routine work stays fast and hermetic. It runs only via the dedicated
 * `test:live-smoke` / `pnpm test:generated-smoke` script.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      exclude: ["dist/**", "node_modules/**", "test/live-smoke/**"],
    },
  }),
);
