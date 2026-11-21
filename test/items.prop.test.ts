import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import {
  compareItems,
  dueSoon,
  imagesOf,
  itemDefects,
  ITEMS_DIR,
  parseItem,
  usable,
  type Item,
} from "../src/items.ts";

const work: Item = {
  id: "draft",
  kind: "work",
  status: "open",
  priority: 2,
  owner: "Alex",
  title: "Draft",
  body: "",
};
const id = fc.nat().map((n) => `item-${n}`);

test.prop([id, unicodeString, unicodeString, unicodeString], {
  examples: [
    ["draft", "", "", ""],
    ["constructor", "__proto__", "é", "Line 1\n---\nLine 2"],
    ["tostring", "字".repeat(1024), "e\u0301", "🧪".repeat(1024)],
    ["title", "", "\u2028!", ""],
    ["title", "Alex", "Before\u2029after", ""],
  ],
})("item text round-trips its frontmatter, heading and body", (itemId, owner, heading, body) => {
  const title = `Draft ${heading.replace(/[\r\n]/g, " ")}`;
  const text = `---\nkind: work\nstatus: open\npriority: 2\nowner: ${JSON.stringify(owner)}\n---\n\n# ${title}\n\n${body}\n`;
  expect(parseItem(itemId, text)).toEqual({
    ...work,
    id: itemId,
    owner,
    title: title.trim(),
    body: body.trim(),
  });
});

test.prop([id, unicodeString], {
  examples: [
    ["draft", ""],
    ["draft", "__proto__"],
    ["draft", "constructor"],
    ["draft", "toString"],
    ["draft", "字".repeat(1024)],
  ],
})("unknown quoted top-level keys are reported as written", (itemId, key) => {
  const unknown = /^[a-z]+$/.test(key) ? `_${key}` : key;
  const text = `---\nkind: work\n${JSON.stringify(unknown)}: 1\n---\n# Draft`;
  expect(() => parseItem(itemId, text)).toThrow(`unknown field ${unknown}`);
});

const optionKey = unicodeString.map((key) => key.replace(/[\s,]/g, "_") || "option");
const optionKeys = fc.uniqueArray(optionKey, { maxLength: 5 });

test.prop([optionKeys], {
  examples: [[[]], [["constructor", "__proto__", "toString", "é", "字".repeat(1024)]]],
})("recommendations and image groups resolve only declared option keys", (keys) => {
  const item: Item = {
    ...work,
    multiple: true,
    options: keys.map((key) => ({ key, label: key })),
    recommended: keys,
    images: Object.fromEntries(keys.map((key) => [key, `${key.length}.png`])),
  };
  expect(itemDefects(item, () => true)).toEqual([]);
  const missing = `absent-${keys.join("_")}`;
  expect(
    itemDefects(
      {
        ...item,
        recommended: [...keys, missing],
        images: { ...item.images, [missing]: "cover.png" },
      },
      () => true,
    ),
  ).toEqual([`recommended ${missing} is not an option`, `image key ${missing} is not an option`]);
});

test.prop([optionKey, unicodeString], {
  examples: [
    ["constructor", ""],
    ["__proto__", "é"],
    ["toString", "字".repeat(1024)],
  ],
})("a repeated option key is a defect regardless of its spelling", (key, label) => {
  const option = { key, label: `Option ${label}` };
  expect(itemDefects({ ...work, options: [option, option] }, () => true)).toEqual([
    "duplicate option key",
  ]);
});

test.prop([id, optionKey, unicodeString, fc.boolean()], {
  examples: [
    ["draft", "__proto__", "", false],
    ["draft", "constructor", "é/私", true],
    ["draft", "toString", "字".repeat(1024), false],
  ],
})(
  "image normalization keeps the group and caption while resolving paths by their separators",
  (itemId, key, name, hasCaption) => {
    const src = `${name}.png`;
    const caption = name;
    const image = hasCaption ? { src, caption } : src;
    const resolved = name.includes("/") ? src : `${ITEMS_DIR}/${itemId}/${src}`;
    const expected = hasCaption ? { src: resolved, caption } : { src: resolved };
    expect(imagesOf({ ...work, id: itemId })).toEqual({ "": [] });
    expect(imagesOf({ ...work, id: itemId, images: [image] })).toEqual({ "": [expected] });
    expect(imagesOf({ ...work, id: itemId, images: { [key]: image } })).toEqual({
      [key]: [expected],
    });
  },
);

test.prop(
  [
    fc.integer({ min: 2000, max: 2090 }),
    fc.integer({ min: 0, max: 11 }),
    fc.integer({ min: 1, max: 31 }),
    fc.integer({ min: -365, max: 365 }),
  ],
  {
    examples: [
      [2011, 11, 23, 8],
      [2024, 1, 22, 7],
      [2024, 1, 22, 8],
      [2026, 2, 27, 7],
      [2026, 9, 31, 8],
      [2026, 11, 31, -1],
    ],
  },
)("due soon includes local calendar days through the seventh day", (year, month, day, offset) => {
  const now = new Date(year, month, day, 23, 59);
  const civilDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const dueDay = civilDay(now) + offset * 86_400_000;
  const due = new Date(dueDay).toISOString().slice(0, 10);
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 23, 59);
  expect(dueSoon(due, now.getTime())).toBe(dueDay <= civilDay(cutoff));
  expect(dueSoon(undefined, now.getTime())).toBe(false);
  expect(dueSoon("", now.getTime())).toBe(false);
});

test.prop([fc.integer({ min: 1, max: 100 }), fc.nat(), fc.integer({ min: 0, max: 9999 })], {
  examples: [
    [1, 0, 9999],
    [100, 2147483647, 0],
  ],
})(
  "earlier comparison criteria take precedence over contradictory later criteria",
  (distance, token, year) => {
    const review = {
      ...work,
      id: `a-${token}`,
      kind: "review" as const,
      order: distance,
      changed: distance,
    };
    const last = { ...review, id: `b-${token}`, order: 2 * distance, changed: 2 * distance };
    const now = new Date();
    const dateAt = (offset: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12).toLocaleDateString(
        "sv-SE",
      );
    const old = dateAt(-distance - 1);
    const recent = dateAt(-distance);
    const future = dateAt(8 + distance);
    const later = dateAt(9 + distance);
    const endOfYear = `${String(year).padStart(4, "0")}-12-31`;
    const pairs = [
      [
        { ...last, priority: 1 },
        { ...review, due: old },
      ],
      [
        { ...last, priority: 3 },
        { ...review, priority: undefined, due: old },
      ],
      [
        { ...last, kind: work.kind, due: old },
        { ...review, due: recent },
      ],
      [{ ...last, kind: work.kind, due: recent }, { ...review }],
      [
        { ...last, due: later },
        { ...review, kind: work.kind, due: future },
      ],
      [
        { ...review, due: later },
        { ...last, due: future },
      ],
      [
        { ...last, order: undefined },
        { ...review, order: 1e9 + distance },
      ],
      [
        { ...last, due: future },
        { ...review, due: later, order: last.order },
      ],
      [
        { ...last, due: endOfYear },
        { ...review, order: last.order },
      ],
      [{ ...last }, { ...review, order: last.order }],
      [
        { ...last, changed: 0 },
        { ...review, order: last.order, changed: -distance },
      ],
      [
        { ...last, changed: undefined },
        { ...review, order: last.order, changed: -distance },
      ],
      [review, { ...review, id: last.id }],
    ] as const;
    for (const [index, [first, second]] of pairs.entries()) {
      expect(compareItems(first, second), `pair ${index + 1}`).toBeLessThan(0);
      expect(compareItems(second, first), `reverse of pair ${index + 1}`).toBeGreaterThan(0);
    }
    expect(compareItems(review, review)).toBe(0);
  },
);

test.prop([optionKeys, unicodeString], {
  examples: [
    [[], ""],
    [["__proto__", "constructor", "toString"], "é".repeat(1024)],
  ],
})(
  "item normalization is idempotent for well-formed options, text, recommendations and images",
  (keys, owner) => {
    const item: Item = {
      ...work,
      owner,
      options: keys.map((key) => ({ key, label: key })),
      recommended: keys[0],
      images: Object.fromEntries(keys.map((key) => [key, `${key.length}.png`])),
    };
    const normalized = usable(item);
    expect(usable(normalized)).toEqual(normalized);
  },
);
