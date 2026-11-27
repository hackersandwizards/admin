import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { scratch } from "./admin-fixtures.ts";

test.each([
  [
    "p { color: #123456 }",
    "colour literal: #123456. Use a shared colour token such as var(--foreground) so the colour follows the theme.",
  ],
  [
    "p { color: rgb(0 0 0) }",
    "colour function: rgb(. Use a shared colour token such as var(--foreground) so the colour follows the theme.",
  ],
  [
    "p { --local-gap: 10px }",
    "custom property defined: --local-gap:. Remove the local declaration and use a shared token where it was consumed so design values have one source.",
  ],
  [
    "p { --hw-pill-hue: red }",
    "--hw-* set to something other than a brand token: --hw-pill-hue:. Set the element property with var() around a shared token so the override follows the theme.",
  ],
  [
    '<div class="gap-[10px]"></div>',
    "Tailwind arbitrary value: p-[10px]. Replace the class with a token-backed utility so the value comes from the shared scale.",
  ],
  [
    '<div style="gap: 10px"></div>',
    'length in a style attribute: style="gap: 10px. Use a shared spacing utility to keep spacing on the shared scale, or move a shell layout length into site/src/layout.css.',
  ],
])("reports the design value in %s", async (source, message) => {
  const file = join(scratch(), "sample.txt");
  await Bun.write(file, source);
  const path = relative(process.cwd(), file);
  const result = Bun.spawnSync(["bun", "run", "check:values", path]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString().trimEnd().split("\n")).toContain(`${path}: ${message}`);
});
