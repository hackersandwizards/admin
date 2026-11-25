import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  mutate: [
    "src/diagrams.ts",
    "src/display.ts",
    "src/entities.ts",
    "src/git.ts",
    "src/item-source.ts",
    "src/item-validation.ts",
    "src/items.ts",
    "src/markdown.ts",
    "src/repo-config.ts",
    "src/repo.ts",
    "src/repo-keys.ts",
    "src/repo-paths.ts",
    "site/src/data.ts",
  ],
  incremental: false,
  vitest: { ...base.vitest, configFile: "test/vitest.mutation.config.ts", pool: "forks" },
  ignorePatterns: [
    ...base.ignorePatterns,
    "/bin/",
    "/site/src/admin.js",
    "/site/src/theme.js",
    "/src/build.ts",
    "/src/hub.ts",
    "/src/serve.ts",
    "/test/admin.test.ts",
  ],
};
