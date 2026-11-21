import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { readItems } from "../src/item-source.ts";
import { ITEMS_DIR } from "../src/items.ts";

const stem = unicodeString.map((text) => text.replaceAll("/", "-").replaceAll("\0", ""));

test.prop([fc.nat(), stem, fc.constantFrom("jpg", "JPEG", "png", "GIF", "webp", "svg", "AVIF")], {
  examples: [
    [0, "", "jpg"],
    [1, "constructor", "JPEG"],
    [2, "__proto__", "png"],
    [3, "toString", "GIF"],
    [4, "é%?", "webp"],
    [5, "字".repeat(1024), "svg"],
    [6, "file.ext", "AVIF"],
  ],
})(
  "only direct items and one-level images with an owning item are accepted",
  (n, name, extension) => {
    const id = `item-${n}`;
    const item = `${ITEMS_DIR}/${id}.md`;
    const image = `${ITEMS_DIR}/${id}/${name}.${extension}`;
    const orphan = `${ITEMS_DIR}/${id}-missing/${name}.${extension}`;
    const nested = `${ITEMS_DIR}/${id}/nested.${extension}/${name}.txt`;
    const bare = `${ITEMS_DIR}/${id}.txt`;
    const other = `${ITEMS_DIR}/${id}/${name}.${extension}.txt`;
    const outside = `${ITEMS_DIR}-adjacent/${id}.md`;
    const invalid = `${ITEMS_DIR}/${id}-invalid.md`;
    const unreadable = `${ITEMS_DIR}/${id}-unreadable.md`;
    const misplaced = `docs/tracking/${id}.md`;
    const read = (path: string) => {
      if (path === item)
        return `---\nkind: goal\nstatus: open\nimages: [${JSON.stringify(`${name}.${extension}`)}]\n---\n# Goal`;
      if (path === invalid) return "Malformed";
      if (path === unreadable) return undefined;
      throw new Error(`unexpected read of ${path}`);
    };
    const paths = [
      outside,
      item,
      image,
      orphan,
      nested,
      other,
      bare,
      invalid,
      unreadable,
      misplaced,
      "GOAL.md",
    ];
    expect(readItems({ paths, read })).toEqual({
      items: [expect.objectContaining({ id, title: "Goal" })],
      defects: [
        `${orphan}: no item ${id}-missing.md`,
        `${nested}: only <id>.md files and <id>/<image> belong in ${ITEMS_DIR}`,
        `${other}: only <id>.md files and <id>/<image> belong in ${ITEMS_DIR}`,
        `${bare}: only <id>.md files and <id>/<image> belong in ${ITEMS_DIR}`,
        `${invalid}: no frontmatter between --- lines`,
        `${unreadable}: no frontmatter between --- lines`,
        "GOAL.md: legacy file, items live in docs/agent-work/items",
        `${misplaced}: legacy folder, move it to docs/agent-work`,
      ],
    });
  },
);

test.prop([fc.nat(), unicodeString], {
  examples: [
    [0, ""],
    [1, "é".repeat(1024)],
  ],
})("a source failure propagates to the repository reader", (n, message) => {
  const error = new Error(message);
  expect(() =>
    readItems({
      paths: [`${ITEMS_DIR}/item-${n}.md`],
      read: () => {
        throw error;
      },
    }),
  ).toThrow(error);
});
