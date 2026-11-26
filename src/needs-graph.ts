import type { Item } from "./items.ts";
import { diagram } from "./diagrams.ts";
import type { ViewItem } from "./site-data.ts";

export function openPrerequisites(item: Item, byId: ReadonlyMap<string, Item>): string[] {
  if (!item.needs?.length) return [];
  const seen = new Set([item.id]);
  const pending = [...item.needs];
  const open: string[] = [];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = byId.get(id);
    if (!target) continue;
    for (const need of target.needs ?? []) pending.push(need);
    if (target.status === "open") open.push(id);
  }
  return open;
}

export function prerequisiteSummary(items: readonly Item[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const waitingOn = new Map<string, string[]>();
  const waitingCount = new Map<string, number>();
  for (const item of items) {
    if (!item.needs?.length) continue;
    const open = openPrerequisites(item, byId);
    if (item.status === "open")
      for (const id of open) waitingCount.set(id, (waitingCount.get(id) ?? 0) + 1);
    waitingOn.set(item.id, open.sort());
  }
  return { waitingOn, waitingCount };
}

export function needsGraphItems(items: ViewItem[]) {
  const ids = new Set(items.map((i) => i.id));
  const connected = new Set<string>();
  for (const item of items)
    for (const id of item.needs ?? [])
      if (id !== item.id && ids.has(id)) {
        connected.add(item.id);
        connected.add(id);
      }
  return items.filter((i) => connected.has(i.id));
}

export function needsGraph(items: ViewItem[]) {
  const nodes = new Map(items.map((item, index) => [item.id, { id: `n${index}`, item }]));
  const source = ["flowchart LR"];
  for (const { id, item } of nodes.values()) {
    const title = item.title.replace(
      /["&<\])\\*~\r\n\u2028\u2029]/g,
      (c) => `&amp;#${c.charCodeAt(0)};`,
    );
    const label = `"${title}"`;
    const shape =
      item.status !== "open" ? `(${label})` : item.waitingOn.length ? `[${label}]` : `([${label}])`;
    source.push(id + shape);
  }
  for (const { id, item } of nodes.values())
    for (const need of new Set(item.needs)) {
      const prerequisite = nodes.get(need);
      if (need === item.id || !prerequisite) continue;
      const arrow = prerequisite.item.status === "open" ? "-->" : "-.->";
      source.push(`${prerequisite.id} ${arrow} ${id}`);
    }
  const rendered = diagram(source.join("\n"), "admin-needs-");
  if (rendered.startsWith("<figure")) return rendered.replace(/&amp;#(\d+);/g, "&#$1;");
}
