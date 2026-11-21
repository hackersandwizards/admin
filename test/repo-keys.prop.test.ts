import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { uniqueKeys } from "../src/repo-keys.ts";
import type { RepoData } from "../src/repo.ts";

function checkout(key: string, path: string, label?: string): RepoData {
  return {
    key,
    path,
    label,
    head: "",
    items: [],
    defects: ["existing defect"],
    reports: [],
    reviews: [],
    docs: [],
    workFiles: [],
    pkg: { dependencies: {}, scripts: {}, bin: {} },
    products: [],
    links: [],
    agents: [],
    checkSteps: [],
    scripts: [],
    trackingLog: [],
    log: [],
  };
}

const collidingKey = fc.oneof(
  fc.constantFrom(
    "constructor",
    "__proto__",
    "toString",
    "index",
    "architecture",
    "404",
    "catalog",
    "_astro",
    "_file",
  ),
  fc.nat().map((n) => `checkout-${n}`),
);

test.prop(
  [collidingKey, fc.option(unicodeString, { nil: undefined }), fc.integer({ min: 2, max: 10 })],
  {
    examples: [
      ["constructor", "", 2],
      ["__proto__", "é", 3],
      ["toString", undefined, 2],
      ["catalog", "字".repeat(1024), 10],
    ],
  },
)(
  "colliding keys use the first free suffix and leave existing keys untouched",
  (key, label, blocked) => {
    const base = `at-here-${key}`;
    const claimed = Array.from({ length: blocked }, (_, n) =>
      checkout(n === 0 ? base : `${base}-${n + 1}`, `/elsewhere/${n}`),
    );
    const first = checkout(key, "/at here/first", label);
    const second = checkout(key, "/at here/second");
    const next = `${base}-${blocked + 1}`;
    const following = `${base}-${blocked + 2}`;
    const reason = ["index", "architecture", "404", "catalog", "_astro", "_file"].includes(key)
      ? "names a page of the hub"
      : "names another checkout too";
    expect(uniqueKeys([first, ...claimed, second])).toEqual([
      {
        ...first,
        key: next,
        label: label && `${label} (at here)`,
        defects: [...first.defects, `key ${key} ${reason}: its pages are under ${next}`],
      },
      ...claimed,
      {
        ...second,
        key: following,
        defects: [...second.defects, `key ${key} ${reason}: its pages are under ${following}`],
      },
    ]);
  },
);

test.prop(
  [fc.constantFrom("index", "architecture", "404", "catalog", "_astro", "_file"), fc.nat()],
  {
    examples: [
      ["index", 0],
      ["architecture", 0],
      ["404", 0],
      ["catalog", 0],
      ["_astro", 0],
      ["_file", 0],
    ],
  },
)("a reserved key is renamed even for a single checkout", (key, folder) => {
  const repo = checkout(key, `/${folder}/repo`);
  const renamed = uniqueKeys([repo]);
  expect(renamed.map((entry) => entry.key)).toEqual([`${folder}-${key}`]);
});
