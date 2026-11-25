export const WORK_DIR = "docs/agent-work";
export const ITEMS_DIR = `${WORK_DIR}/items`;
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
    throw new ItemError(`frontmatter: ${(e as Error).message}`);
  }
  if (typeof front !== "object" || Array.isArray(front))
    throw new ItemError("frontmatter is not a mapping");
  const unknown = Object.keys(front).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new ItemError(`unknown field ${unknown.join(", ")}`);
  // The parser keeps a repeated key's last value without a word; a top-level key starts a line.
  const keys = [...yaml.matchAll(/^(["']?)([\w-]+)\1[ \t]*:/gm)].map((k) => k[2]!);
  const repeated = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (repeated.length) throw new ItemError(`repeated field ${repeated.join(", ")}`);
  return front as Partial<Item>;
}

export function splitItemBody(markdown: string): { title: string; body: string } {
  const rest = markdown.replace(/^\s*\n/, "");
  const heading = rest.match(/^# ([^\r\n]+)\n?/);
  const title = heading?.[1]?.trim();
  if (!heading || !title) throw new ItemError('body does not start with "# <title>"');
  return { title, body: rest.slice(heading[0].length).trim() };
}

export function parseItem(id: string, text: string): Item {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new ItemError("no frontmatter between --- lines");
  const front = parseFrontmatter(m[1]!);
  const { title, body } = splitItemBody(m[2]!);
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

type RankedItem = Item & { changed?: number };
const AFTER_LAST_DAY = "9999-12-32";
const soonDue = (item: RankedItem) => (dueSoon(item.due) ? item.due! : AFTER_LAST_DAY);

const ITEM_RANK_CRITERIA: readonly {
  name: string;
  compare: (a: RankedItem, b: RankedItem) => number;
}[] = [
  { name: "priority", compare: (a, b) => (a.priority ?? 9) - (b.priority ?? 9) },
  { name: "dueSoon", compare: (a, b) => soonDue(a).localeCompare(soonDue(b)) },
  {
    name: "nonWorkFirst",
    compare: (a, b) => Number(a.kind === "work") - Number(b.kind === "work"),
  },
  { name: "order", compare: (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) },
  {
    name: "due",
    compare: (a, b) => (a.due ?? AFTER_LAST_DAY).localeCompare(b.due ?? AFTER_LAST_DAY),
  },
  { name: "latestChange", compare: (a, b) => (b.changed ?? 0) - (a.changed ?? 0) },
  { name: "id", compare: (a, b) => a.id.localeCompare(b.id) },
];

export function compareItems(a: RankedItem, b: RankedItem) {
  for (const { compare } of ITEM_RANK_CRITERIA) {
    const diff = compare(a, b);
    if (diff !== 0) return diff;
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
