export const WORK_DIR = "docs/agent-work";
export const ITEMS_DIR = `${WORK_DIR}/items`;
export const ITEM_ID = /^[a-z0-9][a-z0-9-]*$/;
export const KINDS = ["decision", "review", "work", "goal"] as const;
export const STATUSES = ["open", "assumed", "decided"] as const;

export type Option = {
  key: string;
  label: string;
  detail?: string;
  score?: number;
  noise?: number;
};
export type Image = string | { src: string; caption?: string };
export type Item = {
  id: string;
  kind: (typeof KINDS)[number];
  status: (typeof STATUSES)[number];
  priority?: number;
  order?: number;
  area?: string;
  owner?: string;
  due?: string;
  needs?: string[];
  topic?: string;
  recommended?: string | string[];
  multiple?: boolean;
  options?: Option[];
  images?: Record<string, Image | Image[]> | Image[];
  assumption?: string;
  decision?: string;
  by?: string;
  quote?: string;
  evidence?: string;
  title: string;
  body: string;
};

const FIELDS = [
  "kind",
  "status",
  "priority",
  "order",
  "area",
  "owner",
  "due",
  "needs",
  "topic",
  "recommended",
  "multiple",
  "options",
  "images",
  "assumption",
  "decision",
  "by",
  "quote",
  "evidence",
];

export class ItemError extends Error {}

export function parseFrontmatter(yaml: string): Partial<Item> {
  let front: Record<string, unknown>;
  try {
    front = (Bun.YAML.parse(yaml) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new ItemError(
      `frontmatter: ${(e as Error).message}. Correct the YAML between the opening and closing --- lines in the item file.`,
    );
  }
  if (typeof front !== "object" || Array.isArray(front))
    throw new ItemError(
      "The check reads item fields from a YAML mapping. Write each frontmatter field as a key-value pair, such as kind: goal.",
    );
  const unknown = Object.keys(front).filter((k) => !FIELDS.includes(k));
  if (unknown.length)
    throw new ItemError(
      `Unrecognized item fields: ${unknown.join(", ")}. Remove them or use a supported field from node_modules/@hackersandwizards/admin/docs/items.md.`,
    );
  // The parser keeps a repeated key's last value without a word; a top-level key starts a line.
  const keys = [...yaml.matchAll(/^(["']?)([\w-]+)\1[ \t]*:/gm)].map(([line, , key]) => {
    if (key === undefined) throw new ItemError(`frontmatter key missing: ${line}`);
    return key;
  });
  const repeated = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (repeated.length)
    throw new ItemError(
      `Repeated frontmatter fields overwrite earlier values: ${repeated.join(", ")}. Keep each listed field once with the intended value.`,
    );
  return front as Partial<Item>;
}

export function splitItemBody(markdown: string): { title: string; body: string } {
  const rest = markdown.replace(/^\s*\n/, "");
  const heading = rest.match(/^# ([^\r\n]+)\n?/);
  const title = heading?.[1]?.trim();
  if (!heading || !title)
    throw new ItemError(
      'The hub gets the item title from the first heading. Start the body after frontmatter with "# " followed by a nonempty title.',
    );
  return { title, body: rest.slice(heading[0].length).trim() };
}

export function parseItem(id: string, text: string): Item {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m)
    throw new ItemError(
      "The check cannot read item fields without YAML frontmatter. Put the fields between two --- lines at the top of the item file.",
    );
  const [, yaml, markdown] = m;
  if (yaml === undefined) throw new ItemError(`${id}: frontmatter capture missing`);
  const front = parseFrontmatter(yaml);
  if (markdown === undefined) throw new ItemError(`${id}: body capture missing`);
  const { title, body } = splitItemBody(markdown);
  return { ...front, id, title, body } as Item;
}

export const isPlainReportName = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/.test(value);

export const DUE_SOON_DAYS = 7;
// Compared as local days, the days the hub rebuilds on.
export const dueSoon = (due: string | undefined, now = Date.now()) => {
  const last = new Date(now);
  last.setDate(last.getDate() + DUE_SOON_DAYS);
  return !!due && due <= last.toLocaleDateString("sv-SE");
};

export type RankedItem = Item & { changed?: number };
export type RankKey = readonly [number, string, number, number, string, number, string];
const AFTER_LAST_DAY = "9999-12-32";

export function itemRankKey(item: RankedItem): RankKey {
  const due = item.due;
  const soon = dueSoon(due) && due !== undefined ? due : AFTER_LAST_DAY;
  return [
    item.priority ?? 9,
    soon,
    Number(item.kind === "work"),
    item.order ?? 1e9,
    item.due ?? AFTER_LAST_DAY,
    0 - (item.changed ?? 0),
    item.id,
  ];
}

export function compareItems(a: RankedItem, b: RankedItem): number {
  const left = itemRankKey(a);
  const right = itemRankKey(b);
  for (const [i, l] of left.entries()) {
    const r = right[i];
    if (r === undefined) throw new Error(`Rank field ${i} missing: ${b.id}`);
    const diff = typeof l === "number" ? l - (r as number) : l.localeCompare(r as string);
    if (diff) return diff;
  }
  return 0;
}

export const imagePath = (id: string, src: string) =>
  src.includes("/") ? src : `${ITEMS_DIR}/${id}/${src}`;

export function imagesOf(item: Item): Record<string, { src: string; caption?: string }[]> {
  const norm = (v: Image | Image[]) =>
    [v]
      .flat()
      .map((i) => (typeof i === "string" ? { src: i } : i))
      .map((i) => ({ ...i, src: imagePath(item.id, i.src) }));
  const images = item.images ?? [];
  return Array.isArray(images)
    ? { "": norm(images) }
    : Object.fromEntries(Object.entries(images).map(([k, v]) => [k, norm(v)]));
}
