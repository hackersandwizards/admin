import {
  ITEMS_DIR,
  ItemError,
  WORK_DIR,
  itemDefects,
  parseItem,
  usable,
  type Item,
} from "./items.ts";
import { IMAGE } from "./repo-paths.ts";

const LEGACY = ["GOAL.md"];

export type Source = { paths: string[]; read: (path: string) => string | undefined };

export type ReadItems = { items: Item[]; defects: string[] };

export function readItems(src: Source): ReadItems {
  const items: Item[] = [];
  const defects: string[] = [];
  const has = new Set(src.paths);
  // An image is a file: a folder of that name has no picture to show.
  const exists = (p: string) => has.has(p);
  for (const p of src.paths) {
    if (!p.startsWith(`${ITEMS_DIR}/`)) continue;
    const name = p.slice(ITEMS_DIR.length + 1);
    const [folder, file, deeper] = name.split("/");
    if (file && !deeper && IMAGE.test(file)) {
      if (!has.has(`${ITEMS_DIR}/${folder}.md`)) defects.push(`${p}: no item ${folder}.md`);
      continue;
    }
    if (name.includes("/") || !name.endsWith(".md")) {
      defects.push(`${p}: only <id>.md files and <id>/<image> belong in ${ITEMS_DIR}`);
      continue;
    }
    try {
      const item = parseItem(name.slice(0, -3), src.read(p) ?? "");
      for (const d of itemDefects(item, exists)) defects.push(`${p}: ${d}`);
      items.push(usable(item));
    } catch (e) {
      if (!(e instanceof ItemError)) throw e;
      defects.push(`${p}: ${e.message}`);
    }
  }
  for (const p of LEGACY)
    if (has.has(p)) defects.push(`${p}: legacy file, items live in ${ITEMS_DIR}`);
  // The folder was renamed: a file left at the old path would vanish from every page unnoticed.
  for (const p of src.paths)
    if (p.startsWith("docs/tracking/")) defects.push(`${p}: legacy folder, move it to ${WORK_DIR}`);
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
  return { items, defects };
}
