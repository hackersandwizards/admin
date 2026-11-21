import { mergeConfig, type ViteUserConfig } from "vitest/config";
import config from "../vitest.config.ts";

const { test, ...vite }: ViteUserConfig = config;

export default mergeConfig(vite, {
  test: {
    ...test,
    include: ["test/admin-fast.test.ts", "test/**/*.prop.test.ts"],
  },
});
