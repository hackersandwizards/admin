import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { compareItems, dueSoon, imagesOf, ITEMS_DIR, parseItem, type Item } from "../src/items.ts";
import { itemDefects, usable } from "../src/item-validation.ts";

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

const itemMarkdownParts = fc.record({
  id,
  owner: unicodeString,
  heading: unicodeString,
  body: unicodeString,
});

test.prop([itemMarkdownParts], {
  examples: [
    [{ id: "draft", owner: "", heading: "", body: "" }],
    [{ id: "constructor", owner: "__proto__", heading: "é", body: "Line 1\n---\nLine 2" }],
    [{ id: "tostring", owner: "字".repeat(1024), heading: "e\u0301", body: "🧪".repeat(1024) }],
    [{ id: "title", owner: "", heading: "\u2028!", body: "" }],
    [{ id: "title", owner: "Alex", heading: "Before\u2029after", body: "" }],
  ],
})(
  "item text round-trips its frontmatter, heading and body",
  ({ id: itemId, owner, heading, body }) => {
    const title = `Draft ${heading.replace(/[\r\n]/g, " ")}`;
    const text = `---\nkind: work\nstatus: open\npriority: 2\nowner: ${JSON.stringify(owner)}\n---\n\n# ${title}\n\n${body}\n`;
    expect(parseItem(itemId, text)).toEqual({
      ...work,
      id: itemId,
      owner,
      title: title.trim(),
      body: body.trim(),
    });
  },
);

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

const bareItemImage = fc.record({
  itemId: id,
  group: optionKey,
  file: unicodeString.map((name) => `${name.replaceAll("/", "_")}.png`),
  caption: unicodeString,
});

test.prop([bareItemImage], {
  examples: [
    [{ itemId: "draft", group: "__proto__", file: ".png", caption: "" }],
    [
      {
        itemId: "draft",
        group: "toString",
        file: `${"字".repeat(1024)}.png`,
        caption: "字".repeat(1024),
      },
    ],
  ],
})(
  "bare image filenames resolve under the item folder for plain and captioned entries",
  ({ itemId, group, file, caption }) => {
    const resolved = `${ITEMS_DIR}/${itemId}/${file}`;
    expect(imagesOf({ ...work, id: itemId })).toEqual({ "": [] });
    expect(imagesOf({ ...work, id: itemId, images: [file] })).toEqual({
      "": [{ src: resolved }],
    });
    expect(imagesOf({ ...work, id: itemId, images: { [group]: { src: file, caption } } })).toEqual({
      [group]: [{ src: resolved, caption }],
    });
  },
);

const repoItemImage = fc.record({
  itemId: id,
  group: optionKey,
  path: fc.tuple(unicodeString, unicodeString).map(([dir, file]) => `${dir}/${file}.png`),
  caption: unicodeString,
});

test.prop([repoItemImage], {
  examples: [[{ itemId: "draft", group: "constructor", path: "é/私.png", caption: "é/私" }]],
})(
  "image paths containing a slash stay relative to the repository root",
  ({ itemId, group, path, caption }) => {
    expect(imagesOf({ ...work, id: itemId, images: [path] })).toEqual({
      "": [{ src: path }],
    });
    expect(imagesOf({ ...work, id: itemId, images: { [group]: { src: path, caption } } })).toEqual({
      [group]: [{ src: path, caption }],
    });
  },
);

const calendarDay = fc.record({
  year: fc.integer({ min: 2000, max: 2090 }),
  month: fc.integer({ min: 0, max: 11 }),
  day: fc.integer({ min: 1, max: 31 }),
});

test.prop([calendarDay, fc.integer({ min: -365, max: 365 })], {
  examples: [
    [{ year: 2011, month: 11, day: 23 }, 8],
    [{ year: 2024, month: 1, day: 22 }, 7],
    [{ year: 2024, month: 1, day: 22 }, 8],
    [{ year: 2026, month: 2, day: 27 }, 7],
    [{ year: 2026, month: 9, day: 31 }, 8],
    [{ year: 2026, month: 11, day: 31 }, -1],
  ],
})("due soon includes local calendar days through the seventh day", (today, offset) => {
  const now = new Date(today.year, today.month, today.day, 23, 59);
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
