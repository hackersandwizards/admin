import { mergeConfig, type ViteUserConfig } from "vitest/config";
import config from "../vitest.config.ts";

const { test, ...vite }: ViteUserConfig = config;

export default mergeConfig(vite, {
  test: {
    ...test,
    include: [
      "test/admin-fast.test.ts",
      "test/diagrams.test.ts",
      "test/display.test.ts",
      "test/entities.test.ts",
      "test/git.test.ts",
      "test/items.test.ts",
      "test/item-validation.test.ts",
      "test/item-source.test.ts",
      "test/markdown.test.ts",
      "test/repo-config.test.ts",
      "test/repo.test.ts",
      "test/**/*.prop.test.ts",
    ],
  },
});
