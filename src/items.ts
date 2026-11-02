// The item file: docs/tracking/items/<id>.md, YAML frontmatter plus a Markdown body whose first
// line is "# <title>". Decisions, review requests, assumptions, open work and goals share it.
// A decided or finished item is deleted; git keeps it.

export const ITEMS_DIR = "docs/tracking/items";
export const KINDS = ["decision", "review", "work", "goal"] as const;
export const STATUSES = ["open", "assumed", "decided"] as const;

export type Option = { key: string; label: string; detail?: string };
export type Item = {
  id: string;
  kind: (typeof KINDS)[number];
  status: (typeof STATUSES)[number];
  priority?: number;
  order?: number;
  area?: string;
  owner?: string;
  due?: string;
  recommended?: string;
  options?: Option[];
  images?: Record<string, string>;
  assumption?: string;
  decision?: string;
  by?: string;
  quote?: string;
  evidence?: string;
  page?: string;
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
  "options",
  "images",
  "assumption",
  "decision",
  "by",
  "quote",
  "evidence",
  "page",
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

export function serializeItem(item: Item): string {
  const front: Record<string, unknown> = {};
  for (const k of FIELDS) {
    const v = (item as Record<string, unknown>)[k];
    if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) front[k] = v;
  }
  const yaml = Bun.YAML.stringify(front, null, 2).trimEnd();
  return `---\n${yaml}\n---\n\n# ${item.title}\n${item.body ? `\n${item.body.trim()}\n` : ""}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

// Defects of one item; `exists` answers whether a repo-relative path is present.
export function itemDefects(item: Item, exists: (path: string) => boolean): string[] {
  const d: string[] = [];
  const { kind, status } = item;
  if (!ID.test(item.id)) d.push(`id ${item.id} is not lower-case kebab`);
  if (!KINDS.includes(kind)) d.push(`kind ${kind}`);
  if (!STATUSES.includes(status)) d.push(`status ${status}`);
  if (kind !== "goal" && ![1, 2, 3].includes(item.priority as number))
    d.push(`priority ${item.priority}`);
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
  if (item.recommended !== undefined && !keys.includes(item.recommended))
    d.push(`recommended ${item.recommended} is not an option`);
  if (status === "assumed" && !item.assumption && !item.recommended)
    d.push("assumed without assumption or recommended");
  if (status === "decided" && (!item.decision || !item.by))
    d.push("decided without decision or by");
  for (const [k, file] of Object.entries(item.images ?? {})) {
    if (!keys.includes(k)) d.push(`image key ${k} is not an option`);
    if (!exists(file)) d.push(`image ${file} not found`);
  }
  if (item.page && !exists(item.page)) d.push(`page ${item.page} not found`);
  return d;
}

// Sort: priority, then due date, then order, then the newest change, then id.
export function compareItems(a: Item & { changed?: number }, b: Item & { changed?: number }) {
  return (
    (a.priority ?? 9) - (b.priority ?? 9) ||
    (a.due ?? "9").localeCompare(b.due ?? "9") ||
    (a.order ?? 1e9) - (b.order ?? 1e9) ||
    (b.changed ?? 0) - (a.changed ?? 0) ||
    a.id.localeCompare(b.id)
  );
}
