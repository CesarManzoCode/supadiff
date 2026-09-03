// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "supadiff-artifacts/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["fast-check", "fast-check/*"],
              message:
                "fast-check MUST NOT be exposed in public scenario/generator interfaces (Architecture Contract §10.1).",
            },
          ],
        },
      ],
    },
  },
  {
    // The one module allowed to import the pinned property adapter directly (§10.1):
    // every other file in the repo, this package included, only ever sees the plain
    // `GenerationPlan`/`ScenarioSpec` values it produces.
    files: ["packages/generators/src/model/arbitraries.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
