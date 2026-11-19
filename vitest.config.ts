import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000),
    // The server starts a Bun subprocess from its own import.meta.path.
    server: { deps: { external: [/\/src\/serve\.ts$/] } },
  },
});
