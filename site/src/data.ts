import { readFileSync } from "node:fs";
import { relative, dirname } from "node:path/posix";
import type { Page, SiteData, ViewItem } from "../../src/build.ts";

export type { Page, SiteData, ViewItem };
import { encodePath } from "../../src/repo.ts";
export { docSlug, fileHref, thumbnail, when } from "../../src/repo.ts";

let cached: SiteData | undefined;
export function data(): SiteData {
  cached ??= JSON.parse(readFileSync(process.env.ADMIN_DATA!, "utf8")) as SiteData;
  return cached;
}

export const fileOf = (path: string) => `${path}.html`;

// Relative, so the output opens from disk.
export function href(from: string, to: string) {
  return encodePath(relative(dirname(fileOf(from)), fileOf(to)) || fileOf(to).split("/").pop()!);
}

export const repoOf = (key?: string) => data().repos.find((r) => r.key === key);

let paths: Set<string> | undefined;
export const hasPage = (path: string) =>
  (paths ??= new Set(data().pages.map((p) => p.path))).has(path);

// What admin-serve says went wrong fills this mark on every page it serves; a comment leaves the
// notice :empty, so it stays hidden where nothing went wrong.
export const NOTICE = "<!--admin-notice-->";

// The start of a row's meta line where its item changed since the last visit (admin.js).
export const UPDATED = "updated since your last visit · ";

// An item's row id on a page, which a link to the item names after #.
export const keyOf = (i: ViewItem) => `${i.repo}:${i.id}`;
export const isQuestion = (i: ViewItem) => i.kind === "decision" || i.kind === "review";
// An item's full row on its repository's page.
export const itemHref = (from: string, i: ViewItem) =>
  `${href(from, `${i.repo}/${isQuestion(i) ? "decisions" : "work"}`)}#${keyOf(i)}`;
export const openQuestions = (items: ViewItem[]) =>
  items.filter((i) => i.status === "open" && isQuestion(i));
export const forPerson = (items: ViewItem[]) =>
  items.filter((i) => i.kind === "work" && data().people.includes(i.who));

const DAY = 864e5;
export const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: Date.now() - seconds * 1000 > 300 * DAY ? "numeric" : undefined,
  });
