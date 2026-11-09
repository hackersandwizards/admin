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

export function parseItem(id: string, text: string): Item {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new ItemError("no frontmatter between --- lines");
  let front: Record<string, unknown>;
  try {
    front = (Bun.YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new ItemError(`frontmatter: ${(e as Error).message}`);
  }
  if (typeof front !== "object" || Array.isArray(front))
    throw new ItemError("frontmatter is not a mapping");
  const unknown = Object.keys(front).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new ItemError(`unknown field ${unknown.join(", ")}`);
  const rest = m[2]!.replace(/^\s*\n/, "");
  const title = rest.match(/^# (.+)\n?/);
  if (!title) throw new ItemError('body does not start with "# <title>"');
  return {
    ...(front as Partial<Item>),
    id,
    title: title[1]!.trim(),
    body: rest.slice(title[0].length).trim(),
  } as Item;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

export function itemDefects(item: Item, exists: (path: string) => boolean): string[] {
  const d: string[] = [];
  const { kind, status } = item;
  if (!ID.test(item.id)) d.push(`id ${item.id} is not lower-case kebab`);
  if (!KINDS.includes(kind)) d.push(`kind ${kind}`);
  if (!STATUSES.includes(status)) d.push(`status ${status}`);
  if (kind !== "goal" && ![1, 2, 3].includes(item.priority as number))
    d.push(`priority ${item.priority}`);
  if (kind === "goal" && item.priority !== undefined) d.push("goal has a priority");
  if (item.order !== undefined && typeof item.order !== "number") d.push(`order ${item.order}`);
  if (kind !== "goal" && !item.owner) d.push("lacks owner");
  if (item.due !== undefined && !ISO.test(String(item.due))) d.push(`due ${item.due} not ISO`);
  if ((kind === "work" || kind === "goal") && status !== "open") d.push(`${kind} is ${status}`);
  const options = item.options ?? [];
  if (!Array.isArray(options)) d.push("options is not a list");
  const keys = Array.isArray(options) ? options.map((o) => o?.key) : [];
  if (Array.isArray(options))
    options.forEach((o, i) => {
      if (!o?.key || !o?.label) d.push(`option ${i + 1} lacks key or label`);
    });
  if (new Set(keys).size !== keys.length) d.push("duplicate option key");
  if (kind === "decision" && status === "open" && keys.length < 2)
    d.push("open decision with fewer than two options (a review request is kind: review)");
  if (item.multiple !== undefined && typeof item.multiple !== "boolean")
    d.push(`multiple ${item.multiple} is not true or false`);
  const recommended = [item.recommended ?? []].flat();
  if (recommended.length > 1 && !item.multiple) d.push("several recommended without multiple");
  for (const r of recommended) if (!keys.includes(r)) d.push(`recommended ${r} is not an option`);
  if (Array.isArray(options))
    for (const o of options) {
      if (o?.score !== undefined && typeof o.score !== "number")
        d.push(`option ${o.key} score ${o.score} is not a number`);
      if (o?.noise !== undefined && (typeof o.noise !== "number" || o.score === undefined))
        d.push(`option ${o.key} noise without a numeric score`);
    }
  if (status === "assumed" && !item.assumption && !recommended.length)
    d.push("assumed without assumption or recommended");
  if (status === "decided" && (!item.decision || !item.by))
    d.push("decided without decision or by");
  const images = item.images ?? [];
  const groups: [string | undefined, unknown][] = Array.isArray(images)
    ? [[undefined, images]]
    : typeof images === "object"
      ? Object.entries(images)
      : [];
  if (typeof images !== "object") d.push("images is neither a list nor a mapping");
  for (const [k, value] of groups) {
    if (k !== undefined && !keys.includes(k)) d.push(`image key ${k} is not an option`);
    for (const image of [value].flat()) {
      const { src, caption, ...rest } =
        typeof image === "string" ? { src: image } : ((image ?? {}) as Record<string, unknown>);
      if (
        typeof src !== "string" ||
        !["string", "undefined"].includes(typeof caption) ||
        Object.keys(rest).length
      )
        d.push(`image ${JSON.stringify(image)} is not a path or {src, caption}`);
      else if (!exists(imagePath(item.id, src)))
        d.push(`image ${imagePath(item.id, src)} not found`);
    }
  }
  return d;
}

// The item with each field its pages read in the shape its type states, so a malformed field shows
// as its defect rather than failing the build of every page.
export function usable(item: Item): Item {
  const text = (v: unknown) => (v == null ? undefined : String(v));
  const shots = (v: unknown) =>
    [v]
      .flat()
      .filter(
        (i): i is Image =>
          typeof i === "string" || typeof (i as { src?: unknown })?.src === "string",
      );
  const { images } = item;
  return {
    ...item,
    priority: [1, 2, 3].includes(item.priority as number) ? item.priority : undefined,
    owner: text(item.owner),
    due: text(item.due),
    options: Array.isArray(item.options) ? item.options.filter((o) => o?.key) : undefined,
    images: Array.isArray(images)
      ? shots(images)
      : images && typeof images === "object"
        ? Object.fromEntries(Object.entries(images).map(([k, v]) => [k, shots(v)]))
        : undefined,
  };
}

// Within a priority `order` ranks, and a due date leads only once it is this close or past: one
// week before it, an item tops its group, while a date further out leaves the ranking alone.
export const DUE_SOON_DAYS = 7;
// Compared as local days, the days the hub rebuilds on.
export const dueSoon = (due: string | undefined, now = Date.now()) => {
  const last = new Date(now);
  last.setDate(last.getDate() + DUE_SOON_DAYS);
  return !!due && due <= last.toLocaleDateString("sv-SE");
};

export function compareItems(a: Item & { changed?: number }, b: Item & { changed?: number }) {
  const soon = (i: Item) => (dueSoon(i.due) ? i.due! : "9");
  return (
    (a.priority ?? 9) - (b.priority ?? 9) ||
    soon(a).localeCompare(soon(b)) ||
    (a.order ?? 1e9) - (b.order ?? 1e9) ||
    (a.due ?? "9").localeCompare(b.due ?? "9") ||
    (b.changed ?? 0) - (a.changed ?? 0) ||
    a.id.localeCompare(b.id)
  );
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
