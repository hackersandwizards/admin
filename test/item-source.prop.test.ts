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
        `${orphan}: The hub has no item ${id}-missing.md to attach this image to. Add that item beside the image folder or move the image out of the items directory.`,
        `${nested}: The hub skips this path when reading items in ${ITEMS_DIR}. Move the file out of the items directory or place it at <id>.md for an item or <id>/<image> for an item image.`,
        `${other}: The hub skips this path when reading items in ${ITEMS_DIR}. Move the file out of the items directory or place it at <id>.md for an item or <id>/<image> for an item image.`,
        `${bare}: The hub skips this path when reading items in ${ITEMS_DIR}. Move the file out of the items directory or place it at <id>.md for an item or <id>/<image> for an item image.`,
        `${invalid}: The check cannot read item fields without YAML frontmatter. Put the fields between two --- lines at the top of the item file.`,
        `${unreadable}: The check cannot read item fields without YAML frontmatter. Put the fields between two --- lines at the top of the item file.`,
        "GOAL.md: The hub reads goals as items. Move the goal to docs/agent-work/items/goal.md with kind: goal and status: open, then remove the legacy file.",
        `${misplaced}: This file sits outside the agent-work layout. Move it to the matching path under docs/agent-work.`,
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
