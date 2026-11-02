// The engine holds no design value: every colour, size and font comes from brand (decision
// design-system-hub-spoke, strict). Fails on a colour literal, a custom property the engine
// defines (other than setting a brand element's --hw-* to a brand token), a Tailwind arbitrary
// value and a length in a style attribute.
// Usage: bun test/no-values.ts [<file> ...]   default: every file under site/src and design-system, and src/build.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name.startsWith(".")
      ? []
      : e.isDirectory()
        ? walk(join(dir, e.name))
        : [join(dir, e.name)],
  );
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      ...walk(join(root, "site/src")),
      ...walk(join(root, "design-system")),
      join(root, "src/build.ts"),
    ];
const RULES: [RegExp, string][] = [
  [/#[0-9a-f]{3,8}\b(?![\w-])/gi, "colour literal"],
  [/\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/gi, "colour function"],
  [/(?<![\w-])--(?!hw-)[\w-]+\s*:/g, "custom property defined"],
  [/--hw-[\w-]+\s*:(?!\s*var\(--)/g, "--hw-* set to something other than a brand token"],
  [/[\w:-]-\[[^\]]*\d[^\]]*\]/g, "Tailwind arbitrary value"],
  [/style="[^"]*\d(?:px|rem|em|pt|%)/g, "length in a style attribute"],
];
let found = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  for (const [re, what] of RULES)
    for (const m of text.matchAll(re)) {
      // A URL fragment or an HTML entity is no colour.
      if (what === "colour literal" && /[&"'`/]$/.test(text.slice(0, m.index).slice(-1))) continue;
      console.error(`${file.replace(root + "/", "")}: ${what}: ${m[0]}`);
      found++;
    }
}
if (found) process.exit(1);
console.log(`ok: no design values in ${files.length} file(s)`);
