import { ITEMS_DIR, ItemError, WORK_DIR, parseItem, type Item } from "./items.ts";
import { itemDefects, usable } from "./item-validation.ts";
import { IMAGE } from "./repo-paths.ts";

const LEGACY = ["GOAL.md"];

export type Source = { paths: string[]; read: (path: string) => string | undefined };

export type ReadItems = { items: Item[]; defects: string[] };

export type ItemPathKind =
  | { kind: "outside" }
  | { kind: "image"; ownerId: string }
  | { kind: "stray" }
  | { kind: "item"; id: string };

export function classifyItemPath(path: string): ItemPathKind {
  if (!path.startsWith(`${ITEMS_DIR}/`)) return { kind: "outside" };
  const name = path.slice(ITEMS_DIR.length + 1);
  const [folder, file, deeper] = name.split("/");
  if (folder !== undefined && file && !deeper && IMAGE.test(file))
    return { kind: "image", ownerId: folder };
  if (name.includes("/") || !name.endsWith(".md")) return { kind: "stray" };
  return { kind: "item", id: name.slice(0, -3) };
}

export function loadItemFile(
  id: string,
  read: () => string | undefined,
  exists: (path: string) => boolean,
): { item?: Item; defects: string[] } {
  try {
    const item = parseItem(id, read() ?? "");
    const defects = itemDefects(item, exists);
    return { item: usable(item), defects };
  } catch (e) {
    if (!(e instanceof ItemError)) throw e;
    return { defects: [e.message] };
  }
}

export function legacyPathDefects(paths: readonly string[]): string[] {
  const has = new Set(paths);
  const defects: string[] = [];
  for (const p of LEGACY) {
    if (has.has(p))
      defects.push(
        `${p}: The hub reads goals as items. Move the goal to ${ITEMS_DIR}/goal.md with kind: goal and status: open, then remove the legacy file.`,
      );
  }
  // The folder was renamed: a file left at the old path would vanish from every page unnoticed.
  for (const p of paths) {
    if (p.startsWith("docs/tracking/"))
      defects.push(
        `${p}: This file sits outside the agent-work layout. Move it to the matching path under ${WORK_DIR}.`,
      );
  }
  return defects;
}

export function needsGraphDefects(items: readonly Item[]): string[] {
  const defects: string[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const visit = (item: Item) => {
    const { id, needs } = item;
    const file = `${ITEMS_DIR}/${id}.md`;
    checked.add(id);
    visiting.add(id);
    for (const need of new Set(needs)) {
      const target = byId.get(need);
      if (!target)
        defects.push(
          `${file}: needs unknown item ${JSON.stringify(need)}. Use an id for an item in this repository, or remove this entry once the needed item is done`,
        );
      else if (need === id) defects.push(`${file}: needs itself. Remove ${JSON.stringify(need)}`);
      else if (visiting.has(need)) {
        const path = [...visiting];
        const cycle = path.slice(path.indexOf(need)).concat(need).join(" → ");
        defects.push(
          `${file}: needs closes a cycle (${cycle}). Remove a prerequisite in this cycle`,
        );
      } else if (!checked.has(need)) visit(target);
    }
    visiting.delete(id);
  };
  for (const item of items) if (!checked.has(item.id)) visit(item);
  return defects;
}

export function readItems(src: Source): ReadItems {
  const items: Item[] = [];
  const defects: string[] = [];
  const has = new Set(src.paths);
  const exists = (p: string) => has.has(p);
  for (const p of src.paths) {
    const entry = classifyItemPath(p);
    if (entry.kind === "outside") continue;
    if (entry.kind === "image") {
      if (!has.has(`${ITEMS_DIR}/${entry.ownerId}.md`))
        defects.push(
          `${p}: The hub has no item ${entry.ownerId}.md to attach this image to. Add that item beside the image folder or move the image out of the items directory.`,
        );
      continue;
    }
    if (entry.kind === "stray") {
      defects.push(
        `${p}: The hub skips this path when reading items in ${ITEMS_DIR}. Move the file out of the items directory or place it at <id>.md for an item or <id>/<image> for an item image.`,
      );
      continue;
    }
    const loaded = loadItemFile(entry.id, () => src.read(p), exists);
    for (const d of loaded.defects) defects.push(`${p}: ${d}`);
    if (loaded.item) items.push(loaded.item);
  }
  return {
    items,
    defects: defects.concat(legacyPathDefects(src.paths), needsGraphDefects(items)),
  };
}
