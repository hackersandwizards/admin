import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  mutate: ["src/{items,repo}.ts", "site/src/data.ts"],
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
