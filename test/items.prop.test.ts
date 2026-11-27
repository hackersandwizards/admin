import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { compareItems, dueSoon, imagesOf, ITEMS_DIR, parseItem, type Item } from "../src/items.ts";
import { itemDefects, usable } from "../src/item-validation.ts";
import { inZone } from "./admin-fixtures.ts";

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

const renderItemFile = (item: Item) => ({
  id: item.id,
  text: `---\nkind: ${item.kind}\nstatus: ${item.status}\npriority: ${item.priority}\nowner: ${JSON.stringify(item.owner)}\n---\n\n# ${item.title}\n\n${item.body}\n`,
  expected: { ...item, title: item.title.trim(), body: item.body.trim() },
});

const itemFileCase = fc
  .record({
    id,
    owner: unicodeString,
    title: unicodeString.map((heading) => `Draft ${heading.replace(/[\r\n]/g, " ")}`),
    body: unicodeString,
  })
  .map((fields) => renderItemFile({ ...work, ...fields }));

test.prop([itemFileCase], {
  examples: [
    [renderItemFile({ ...work, id: "draft", owner: "", title: "Draft ", body: "" })],
    [
      renderItemFile({
        ...work,
        id: "constructor",
        owner: "__proto__",
        title: "Draft é",
        body: "Line 1\n---\nLine 2",
      }),
    ],
    [
      renderItemFile({
        ...work,
        id: "tostring",
        owner: "字".repeat(1024),
        title: "Draft e\u0301",
        body: "🧪".repeat(1024),
      }),
    ],
    [renderItemFile({ ...work, id: "title", owner: "", title: "Draft \u2028!", body: "" })],
    [
      renderItemFile({
        ...work,
        id: "title",
        owner: "Alex",
        title: "Draft Before\u2029after",
        body: "",
      }),
    ],
  ],
})("item text round-trips its frontmatter, heading and body", (fileCase) => {
  expect(parseItem(fileCase.id, fileCase.text)).toEqual(fileCase.expected);
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
  expect(() => parseItem(itemId, text)).toThrow(
    `Unrecognized item fields: ${unknown}. Remove them or use a supported field from docs/items.md.`,
  );
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
  ).toEqual([
    `Recommended key ${missing} has no choice. Use an option key in recommended.`,
    `Image key ${missing} has no matching choice. Use a key from options in the images mapping or use an images list for the item as a whole.`,
  ]);
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
    "Duplicate option keys make references ambiguous. Give each options entry a unique key and update any recommended or images references to the renamed key.",
  ]);
});

const imageCasesFor = ({
  itemId,
  group,
  src,
  resolved,
  caption,
}: {
  itemId: string;
  group: string;
  src: string;
  resolved: string;
  caption: string;
}) => ({
  absent: { item: { ...work, id: itemId }, expected: { "": [] } },
  plainList: {
    item: { ...work, id: itemId, images: [src] },
    expected: { "": [{ src: resolved }] },
  },
  captionedList: {
    item: { ...work, id: itemId, images: [{ src, caption }] },
    expected: { "": [{ src: resolved, caption }] },
  },
  plainGroup: {
    item: { ...work, id: itemId, images: { [group]: src } },
    expected: { [group]: [{ src: resolved }] },
  },
  captionedGroup: {
    item: { ...work, id: itemId, images: { [group]: { src, caption } } },
    expected: { [group]: [{ src: resolved, caption }] },
  },
});

const bareImageCase = fc
  .record({
    itemId: id,
    group: optionKey,
    src: unicodeString.map((name) => `${name.replaceAll("/", "_")}.png`),
    caption: unicodeString,
  })
  .map((entry) =>
    imageCasesFor({ ...entry, resolved: `${ITEMS_DIR}/${entry.itemId}/${entry.src}` }),
  );

test.prop([bareImageCase], {
  examples: [
    [
      imageCasesFor({
        itemId: "draft",
        group: "__proto__",
        src: ".png",
        resolved: `${ITEMS_DIR}/draft/.png`,
        caption: "",
      }),
    ],
    [
      imageCasesFor({
        itemId: "draft",
        group: "toString",
        src: `${"字".repeat(1024)}.png`,
        resolved: `${ITEMS_DIR}/draft/${"字".repeat(1024)}.png`,
        caption: "字".repeat(1024),
      }),
    ],
  ],
})("bare image filenames resolve under the item folder in list and option-key forms", (entry) => {
  expect(imagesOf(entry.absent.item)).toEqual(entry.absent.expected);
  expect(imagesOf(entry.plainList.item)).toEqual(entry.plainList.expected);
  expect(imagesOf(entry.captionedList.item)).toEqual(entry.captionedList.expected);
  expect(imagesOf(entry.plainGroup.item)).toEqual(entry.plainGroup.expected);
  expect(imagesOf(entry.captionedGroup.item)).toEqual(entry.captionedGroup.expected);
});

const repoImageCase = fc
  .record({
    itemId: id,
    group: optionKey,
    src: fc.tuple(unicodeString, unicodeString).map(([dir, file]) => `${dir}/${file}.png`),
    caption: unicodeString,
  })
  .map((entry) => imageCasesFor({ ...entry, resolved: entry.src }));

test.prop([repoImageCase], {
  examples: [
    [
      imageCasesFor({
        itemId: "draft",
        group: "constructor",
        src: "é/私.png",
        resolved: "é/私.png",
        caption: "é/私",
      }),
    ],
  ],
})(
  "image paths containing a slash stay relative to the repository root in list and option-key forms",
  (entry) => {
    expect(imagesOf(entry.plainList.item)).toEqual(entry.plainList.expected);
    expect(imagesOf(entry.captionedList.item)).toEqual(entry.captionedList.expected);
    expect(imagesOf(entry.plainGroup.item)).toEqual(entry.plainGroup.expected);
    expect(imagesOf(entry.captionedGroup.item)).toEqual(entry.captionedGroup.expected);
  },
);

const calendarDay = fc.record({
  year: fc.integer({ min: 2000, max: 2090 }),
  month: fc.integer({ min: 0, max: 11 }),
  day: fc.integer({ min: 1, max: 31 }),
});

const ZONE = "Europe/Berlin";

const dueCheckAt = (
  today: { year: number; month: number; day: number },
  offset: number,
  expected: boolean,
) =>
  inZone(ZONE, () => {
    const now = new Date(today.year, today.month, today.day, 23, 59);
    const civilDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const due = new Date(civilDay + offset * 86_400_000).toISOString().slice(0, 10);
    return { now: now.getTime(), due, expected };
  });

const dueWindowCase = fc.oneof(
  fc
    .tuple(calendarDay, fc.integer({ min: -365, max: 7 }))
    .map(([today, offset]) => dueCheckAt(today, offset, true)),
  fc
    .tuple(calendarDay, fc.integer({ min: 8, max: 365 }))
    .map(([today, offset]) => dueCheckAt(today, offset, false)),
);

test.prop([dueWindowCase], {
  examples: [
    [dueCheckAt({ year: 2011, month: 11, day: 23 }, 8, false)],
    [dueCheckAt({ year: 2024, month: 1, day: 22 }, 7, true)],
    [dueCheckAt({ year: 2024, month: 1, day: 22 }, 8, false)],
    [dueCheckAt({ year: 2026, month: 2, day: 27 }, 7, true)],
    [dueCheckAt({ year: 2026, month: 9, day: 31 }, 8, false)],
    [dueCheckAt({ year: 2026, month: 11, day: 31 }, -1, true)],
  ],
})("due soon includes local calendar days through the seventh day", (windowCase) => {
  const [onDue, onMissing, onEmpty] = inZone(ZONE, () => [
    dueSoon(windowCase.due, windowCase.now),
    dueSoon(undefined, windowCase.now),
    dueSoon("", windowCase.now),
  ]);
  expect(onDue).toBe(windowCase.expected);
  expect(onMissing).toBe(false);
  expect(onEmpty).toBe(false);
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
