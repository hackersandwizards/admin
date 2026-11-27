import {
  KINDS,
  ITEM_ID,
  STATUSES,
  WORK_DIR,
  imagePath,
  isPlainReportName,
  type Image,
  type Item,
  type Option,
} from "./items.ts";

const isDay = (v: unknown) => {
  const t = Date.parse(`${v}T00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(String(v)) &&
    !Number.isNaN(t) &&
    new Date(t).toISOString().startsWith(String(v))
  );
};
// The fields a page prints as text.
const TEXTS = ["area", "owner", "assumption", "decision", "by", "quote", "evidence"] as const;
const isText = (v: unknown) => typeof v === "string" || typeof v === "number";
const asText = (v: unknown) => (isText(v) ? String(v) : undefined);
// An option key as the pages store and compare it: text.
const optionKey = (v: unknown) => (v == null || v === "" ? undefined : String(v));
const isPriority = (v: unknown): v is number => [1, 2, 3].includes(v as number);

export function priorityDefects(kind: Item["kind"], priority: unknown): string[] {
  if (kind === "goal") return priority !== undefined ? ["goal has a priority"] : [];
  return isPriority(priority) ? [] : [`priority ${priority}`];
}

export function coreFieldDefects(
  item: Pick<Item, "id" | "kind" | "status" | "priority" | "order" | "owner">,
): string[] {
  const defects: string[] = [];
  if (!ITEM_ID.test(item.id)) defects.push(`id ${item.id} is not lower-case kebab`);
  if (!KINDS.includes(item.kind)) defects.push(`kind ${item.kind}`);
  if (!STATUSES.includes(item.status)) defects.push(`status ${item.status}`);
  defects.push(...priorityDefects(item.kind, item.priority));
  if (item.order !== undefined && typeof item.order !== "number")
    defects.push(`order ${item.order}`);
  if (item.kind !== "goal" && !item.owner) defects.push("lacks owner");
  return defects;
}

export function textFieldDefects(item: Pick<Item, (typeof TEXTS)[number]>): string[] {
  const defects: string[] = [];
  for (const field of TEXTS) {
    if (item[field] !== undefined && !isText(item[field])) defects.push(`${field} is not text`);
  }
  return defects;
}

export function dueDefects(due: unknown): string[] {
  return due !== undefined && !isDay(due) ? [`due ${due} not ISO`] : [];
}

export function topicDefects(topic: unknown, exists: (path: string) => boolean): string[] {
  if (topic === undefined) return [];
  if (!isPlainReportName(topic))
    return [
      "topic must be a plain report name: YYYY-MM-DD- followed by lower-case letters, digits and hyphens, without .md. Rename the report or correct the field",
    ];
  if (!exists(`${WORK_DIR}/${topic}.md`))
    return [`topic report ${WORK_DIR}/${topic}.md not found. Add the report or correct topic`];
  return [];
}

export function parseNeeds(raw: unknown): { value: string[] | undefined; defects: string[] } {
  if (raw === undefined) return { value: undefined, defects: [] };
  if (!Array.isArray(raw))
    return { value: undefined, defects: ["needs must be a list. Use a list of item ids"] };
  const value: string[] = [];
  const defects: string[] = [];
  const seen = new Set<string>();
  (raw as unknown[]).forEach((id, i) => {
    if (typeof id !== "string") {
      defects.push(`needs entry ${i + 1} must be a string. Use an item id`);
    } else {
      value.push(id);
      if (seen.has(id))
        defects.push(`needs has duplicate item ${JSON.stringify(id)}. Remove entry ${i + 1}`);
      else seen.add(id);
    }
  });
  return { value, defects };
}

export function openKindDefects(kind: Item["kind"], status: Item["status"]): string[] {
  return (kind === "work" || kind === "goal") && status !== "open" ? [`${kind} is ${status}`] : [];
}

export function openDecisionDefects(
  kind: Item["kind"],
  status: Item["status"],
  optionCount: number,
): string[] {
  return kind === "decision" && status === "open" && optionCount < 2
    ? ["open decision with fewer than two options (a review request is kind: review)"]
    : [];
}

export function optionEntryDefect(option: unknown, index: number): string | undefined {
  const o = option as Partial<Option> | null | undefined;
  if (o == null || !optionKey(o.key) || !optionKey(o.label))
    return `option ${index + 1} lacks key or label`;
  if (!isText(o.key) || /[\s,]/.test(String(o.key)))
    return `option ${index + 1} key ${JSON.stringify(o.key)} is not one word`;
  if (!isText(o.label) || (o.detail !== undefined && !isText(o.detail)))
    return `option ${o.key} label or detail is not text`;
  return undefined;
}

type RawOption = Partial<Record<keyof Option, unknown>> | null | undefined;

export function parseOptions(raw: unknown): {
  value: Option[] | undefined;
  keys: (string | undefined)[];
  defects: string[];
} {
  if (raw == null) return { value: undefined, keys: [], defects: [] };
  if (!Array.isArray(raw))
    return { value: undefined, keys: [], defects: ["options is not a list"] };
  const entries = raw as RawOption[];
  const keys = entries.map((o) => optionKey(o?.key));
  const defects: string[] = [];
  entries.forEach((o, i) => {
    const defect = optionEntryDefect(o, i);
    if (defect) defects.push(defect);
  });
  if (new Set(keys).size !== keys.length) defects.push("duplicate option key");
  const value: Option[] = entries
    .filter((o): o is NonNullable<RawOption> => Boolean(optionKey(o?.key)))
    .map((o) => ({
      ...(o as Option),
      key: String(o.key),
      label: asText(o.label) ?? String(o.key),
      detail: asText(o.detail),
    }));
  return { value, keys, defects };
}

export function parseRecommended(raw: unknown, defects: string[] = []): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const entries: unknown[] = Array.isArray(raw) ? raw : [raw];
  const keys: string[] = [];
  entries.forEach((entry, index) => {
    if (isText(entry)) keys.push(String(entry));
    else
      defects.push(`recommended entry ${index + 1} must be a string or number. Use an option key`);
  });
  return keys;
}

export function recommendationDefects(
  rawRecommended: unknown,
  multiple: unknown,
  keys: (string | undefined)[],
): string[] {
  const defects: string[] = [];
  if (multiple !== undefined && typeof multiple !== "boolean")
    defects.push(`multiple ${multiple} is not true or false`);
  const recommended = parseRecommended(rawRecommended, defects) ?? [];
  if (recommended.length > 1 && !multiple) defects.push("several recommended without multiple");
  for (const r of recommended) {
    if (!keys.includes(r)) defects.push(`recommended ${r} is not an option`);
  }
  return defects;
}

export function optionScoreDefects(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const defects: string[] = [];
  for (const o of options as RawOption[]) {
    if (o?.score !== undefined && typeof o.score !== "number")
      defects.push(`option ${String(o.key)} score ${String(o.score)} is not a number`);
    if (o?.noise !== undefined && (typeof o.noise !== "number" || o.score === undefined))
      defects.push(`option ${String(o.key)} noise without a numeric score`);
  }
  return defects;
}

export function settledStatusDefects(
  item: Pick<Item, "status" | "assumption" | "recommended" | "decision" | "by">,
): string[] {
  const defects: string[] = [];
  const recommended = parseRecommended(item.recommended) ?? [];
  if (item.status === "assumed" && !item.assumption && !recommended.length)
    defects.push("assumed without assumption or recommended");
  if (item.status === "decided" && (!item.decision || !item.by))
    defects.push("decided without decision or by");
  return defects;
}

export function imageEntryDefect(
  itemId: string,
  image: unknown,
  exists: (path: string) => boolean,
): string | undefined {
  const { src, caption, ...rest } =
    typeof image === "string" ? { src: image } : ((image ?? {}) as Record<string, unknown>);
  if (
    typeof src !== "string" ||
    !["string", "undefined"].includes(typeof caption) ||
    Object.keys(rest).length
  )
    return `image ${JSON.stringify(image)} is not a path or {src, caption}`;
  const path = imagePath(itemId, src);
  if (!exists(path)) return `image ${path} not found`;
  return undefined;
}

export function imageDefects(
  item: Pick<Item, "id" | "images">,
  keys: (string | undefined)[],
  exists: (path: string) => boolean,
): string[] {
  const images = item.images ?? [];
  if (typeof images !== "object") return ["images is neither a list nor a mapping"];
  const groups: [string | undefined, unknown][] = Array.isArray(images)
    ? [[undefined, images]]
    : Object.entries(images);
  const defects: string[] = [];
  for (const [k, value] of groups) {
    if (k !== undefined && !keys.includes(k)) defects.push(`image key ${k} is not an option`);
    for (const image of [value].flat()) {
      const defect = imageEntryDefect(item.id, image, exists);
      if (defect) defects.push(defect);
    }
  }
  return defects;
}

export function itemDefects(item: Item, exists: (path: string) => boolean): string[] {
  const beforeOptions = [
    ...coreFieldDefects(item),
    ...textFieldDefects(item),
    ...dueDefects(item.due),
    ...topicDefects(item.topic, exists),
    ...parseNeeds(item.needs).defects,
    ...openKindDefects(item.kind, item.status),
  ];
  const { keys, defects: optionErrors } = parseOptions(item.options);
  return [
    ...beforeOptions,
    ...optionErrors,
    ...openDecisionDefects(item.kind, item.status, keys.length),
    ...recommendationDefects(item.recommended, item.multiple, keys),
    ...optionScoreDefects(item.options),
    ...settledStatusDefects(item),
    ...imageDefects(item, keys, exists),
  ];
}

const usableShots = (v: unknown): Image[] =>
  [v]
    .flat()
    .filter(
      (i): i is Image => typeof i === "string" || typeof (i as { src?: unknown })?.src === "string",
    );

export function usableImages(images: unknown): Item["images"] {
  if (Array.isArray(images)) return usableShots(images);
  if (images && typeof images === "object")
    return Object.fromEntries(Object.entries(images).map(([k, v]) => [k, usableShots(v)]));
  return undefined;
}

export function usable(item: Item): Item {
  return {
    ...item,
    ...Object.fromEntries(TEXTS.map((f) => [f, asText(item[f])])),
    priority: isPriority(item.priority) ? item.priority : undefined,
    order: typeof item.order === "number" ? item.order : undefined,
    due: isDay(item.due) ? String(item.due) : undefined,
    topic: isPlainReportName(item.topic) ? item.topic : undefined,
    needs: parseNeeds(item.needs).value,
    recommended: parseRecommended(item.recommended),
    options: parseOptions(item.options).value,
    images: usableImages(item.images),
  };
}
