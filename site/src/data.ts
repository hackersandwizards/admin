import { readFileSync } from "node:fs";
import { relative, dirname } from "node:path/posix";
import type { Page, SiteData, ViewItem } from "../../src/build.ts";

export type { Page, SiteData, ViewItem };
export { fileHref } from "../../src/repo.ts";

let cached: SiteData | undefined;
export function data(): SiteData {
  cached ??= JSON.parse(readFileSync(process.env.ADMIN_DATA!, "utf8")) as SiteData;
  return cached;
}

export const fileOf = (path: string) => `${path}.html`;

// Relative, so the output opens from disk.
export function href(from: string, to: string) {
  const r = relative(dirname(fileOf(from)), fileOf(to));
  return r || fileOf(to).split("/").pop()!;
}

export const repoOf = (key?: string) => data().repos.find((r) => r.key === key);

let paths: Set<string> | undefined;
export const hasPage = (path: string) =>
  (paths ??= new Set(data().pages.map((p) => p.path))).has(path);

export const isQuestion = (i: ViewItem) => i.kind === "decision" || i.kind === "review";
export const openQuestions = (items: ViewItem[]) =>
  items.filter((i) => i.status === "open" && isQuestion(i));
export const forPerson = (items: ViewItem[]) =>
  items.filter((i) => i.kind === "work" && data().people.includes(i.who));

const DAY = 864e5;
export function age(ms?: number) {
  if (!ms) return "never";
  const h = Math.round((Date.now() - ms) / 3.6e6);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
export const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: Date.now() - seconds * 1000 > 300 * DAY ? "numeric" : undefined,
  });
