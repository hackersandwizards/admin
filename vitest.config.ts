import base from "@hackersandwizards/scaffolding/vitest";
import { mergeConfig } from "vitest/config";

export default mergeConfig(base, {
  test: {
    include: ["test/**/*.test.ts"],
    // The server starts a Bun subprocess from its own import.meta.path.
    server: { deps: { external: [/\/src\/serve\.ts$/] } },
  },
});
