import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

/**
 * `test/integration/**` requires a real, network-reachable `@supabase/lite@0.9.0`
 * install (and, for `supalite-postgres`, a real local PostgreSQL server) — it is
 * deliberately excluded from the default `test`/`pnpm check` run so routine work
 * stays fast and hermetic. It runs only via the dedicated `test:integration` /
 * `pnpm test:integration:supalite` script (Integration Honesty: never faked, but
 * also never silently smuggled into the default gate).
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      exclude: ["dist/**", "node_modules/**", "test/integration/**"],
    },
  }),
);
