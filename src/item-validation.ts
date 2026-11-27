import { KINDS, ITEM_ID, STATUSES, WORK_DIR, imagePath, isPlainReportName } from "./items.ts";
import type { Image, Item, Option } from "./items.ts";

const isDay = (v: unknown) => {
  const t = Date.parse(`${v}T00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(String(v)) &&
    !Number.isNaN(t) &&
    new Date(t).toISOString().startsWith(String(v))
  );
};
const TEXTS = ["area", "owner", "assumption", "decision", "by", "quote", "evidence"] as const;
const isText = (v: unknown) => typeof v === "string" || typeof v === "number";
const asText = (v: unknown) => (isText(v) ? String(v) : undefined);
// An option key as the pages store and compare it: text.
const optionKey = (v: unknown) => (v == null || v === "" ? undefined : String(v));
const isPriority = (v: unknown): v is number => [1, 2, 3].includes(v as number);
const received = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

export function priorityDefects(kind: Item["kind"], priority: unknown): string[] {
  if (kind === "goal")
    return priority !== undefined
      ? ["Goals must use the default priority. Remove priority from the frontmatter."]
      : [];
  if (isPriority(priority)) return [];
  const fix = "Set priority to the number 1, 2 or 3.";
  if (priority === undefined) return [`No priority is set. ${fix}`];
  return [`Priority ${received(priority)} cannot rank this item. ${fix}`];
}

export function coreFieldDefects(
  item: Pick<Item, "id" | "kind" | "status" | "priority" | "order" | "owner">,
): string[] {
  const defects: string[] = [];
  if (!ITEM_ID.test(item.id))
    defects.push(
      `Item id ${item.id} cannot be used as a valid item reference. Rename the Markdown file using lowercase ASCII letters, digits or hyphens and start the id with a letter or digit.`,
    );
  if (!KINDS.includes(item.kind))
    defects.push(`Kind ${item.kind} is unsupported. Set kind to decision, review, work or goal.`);
  if (!STATUSES.includes(item.status))
    defects.push(`Status ${item.status} is unsupported. Set status to open, assumed or decided.`);
  defects.push(...priorityDefects(item.kind, item.priority));
  if (item.order !== undefined && typeof item.order !== "number")
    defects.push(`Order ${item.order} cannot sort the item. Use a number for order or omit it.`);
  if (item.kind !== "goal" && !item.owner)
    defects.push("No one is assigned to move this item. Set owner in the frontmatter.");
  return defects;
}

export function textFieldDefects(item: Pick<Item, (typeof TEXTS)[number]>): string[] {
  const defects: string[] = [];
  for (const field of TEXTS) {
    if (item[field] !== undefined && !isText(item[field]))
      defects.push(`${field} needs text for display. Use a string or number.`);
  }
  return defects;
}

export function dueDefects(due: unknown): string[] {
  return due !== undefined && !isDay(due)
    ? [`Due date ${due} is unusable for sorting. Set due to a valid YYYY-MM-DD date.`]
    : [];
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
  return (kind === "work" || kind === "goal") && status !== "open"
    ? [
        `A ${kind} item has status ${status}. Set status to open, the only state for work and goals.`,
      ]
    : [];
}

export function openDecisionDefects(
  kind: Item["kind"],
  status: Item["status"],
  optionCount: number,
): string[] {
  return kind === "decision" && status === "open" && optionCount < 2
    ? [
        "An open decision needs at least two options for a choice. Add entries under options or set kind to review for a review request.",
      ]
    : [];
}

export function optionEntryDefect(option: unknown, index: number): string | undefined {
  const o = option as Partial<Option> | null | undefined;
  if (o == null || !optionKey(o.key) || !optionKey(o.label))
    return `Option ${index + 1} needs a key for references and a label to display. Fill in both fields on that options entry.`;
  if (!isText(o.key) || /[\s,]/.test(String(o.key)))
    return `Option ${index + 1} has an invalid reference key ${JSON.stringify(o.key)}. Set its key to a string or number without whitespace or commas.`;
  if (!isText(o.label) || (o.detail !== undefined && !isText(o.detail)))
    return `The hub needs text to display the label and detail for option ${o.key}. Set label and any detail to strings or numbers.`;
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
    return {
      value: undefined,
      keys: [],
      defects: ["Choices need a list. Write options as YAML list entries with key and label."],
    };
  const entries = raw as RawOption[];
  const keys = entries.map((o) => optionKey(o?.key));
  const defects: string[] = [];
  entries.forEach((o, i) => {
    const defect = optionEntryDefect(o, i);
    if (defect) defects.push(defect);
  });
  if (new Set(keys).size !== keys.length)
    defects.push(
      "Duplicate option keys make references ambiguous. Give each options entry a unique key and update any recommended or images references to the renamed key.",
    );
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
    defects.push(
      `Multiple value ${multiple} does not specify whether several choices are allowed. Set multiple to true or false in the frontmatter.`,
    );
  const recommended = parseRecommended(rawRecommended, defects) ?? [];
  if (recommended.length > 1 && !multiple)
    defects.push("Multiple picks need opt-in. Set multiple to true or keep one recommendation.");
  for (const r of recommended) {
    if (!keys.includes(r))
      defects.push(`Recommended key ${r} has no choice. Use an option key in recommended.`);
  }
  return defects;
}

export function optionScoreDefects(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const defects: string[] = [];
  for (const o of options as RawOption[]) {
    if (o?.score !== undefined && typeof o.score !== "number")
      defects.push(
        `Option ${String(o.key)} has a score of ${received(o.score)}, which cannot be used as a numeric review score. Set score to a number.`,
      );
    if (o?.noise !== undefined && (typeof o.noise !== "number" || o.score === undefined))
      defects.push(
        `Noise requires a score for option ${String(o.key)}. Set both to numbers or omit noise.`,
      );
  }
  return defects;
}

export function settledStatusDefects(
  item: Pick<Item, "status" | "assumption" | "recommended" | "decision" | "by">,
): string[] {
  const defects: string[] = [];
  const recommended = parseRecommended(item.recommended) ?? [];
  if (item.status === "assumed" && !item.assumption && !recommended.length)
    defects.push("The hub shows what was assumed. Fill in assumption or recommended.");
  if (item.status === "decided" && (!item.decision || !item.by))
    defects.push("Record what was decided and who decided it. Fill in decision and by.");
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
    return `The hub cannot read the image entry ${JSON.stringify(image)}. Use a path string or an object with a string src and an optional string caption.`;
  const path = imagePath(itemId, src);
  if (!exists(path))
    return `The hub cannot display image ${path}. Add the missing file or fix its path in images.`;
  return undefined;
}

export function imageDefects(
  item: Pick<Item, "id" | "images">,
  keys: (string | undefined)[],
  exists: (path: string) => boolean,
): string[] {
  const images = item.images ?? [];
  if (typeof images !== "object")
    return ["The hub groups images by item or option. Use a list or mapping in images."];
  const groups: [string | undefined, unknown][] = Array.isArray(images)
    ? [[undefined, images]]
    : Object.entries(images);
  const defects: string[] = [];
  for (const [k, value] of groups) {
    if (k !== undefined && !keys.includes(k))
      defects.push(
        `Image key ${k} has no matching choice. Use a key from options in the images mapping or use an images list for the item as a whole.`,
      );
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
