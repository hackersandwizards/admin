import { readFileSync } from "node:fs";
import { relative, dirname } from "node:path/posix";
import type { Page, SiteData, ViewItem } from "../../src/build.ts";

export type { Page, SiteData, ViewItem };
import { dueSoon } from "../../src/items.ts";
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

// A row's mark where its item changed since the last visit, which admin.js words by what changed.
export const UPDATED = "updated since your last visit";

// An item's row id on a page, which a link to the item names after #.
export const keyOf = (i: ViewItem) => `${i.repo}:${i.id}`;
// The question an answer answers: its title and options, which admin.js stores with the answer, so
// an answer given before they changed says so. A new rank, body or status leaves it.
export const askedOf = (i: ViewItem) =>
  Bun.hash(
    JSON.stringify([
      i.title,
      !!i.multiple,
      (i.options ?? []).map((o) => [o.key, o.label, o.detail ?? ""]),
    ]),
  ).toString(36);
export const isQuestion = (i: ViewItem) => i.kind === "decision" || i.kind === "review";
// An item's full row on its repository's page.
export const itemHref = (from: string, i: ViewItem) =>
  `${href(from, `${i.repo}/${isQuestion(i) ? "decisions" : "work"}`)}#${keyOf(i)}`;
export const openQuestions = (items: ViewItem[]) =>
  items.filter((i) => i.status === "open" && isQuestion(i));
// The Reviews page's items: requests to look at something, and decisions between images.
export const reviewsOf = (items: ViewItem[]) =>
  openQuestions(items).filter((i) => i.kind === "review" || i.images);
export const forPerson = (items: ViewItem[]) =>
  items.filter((i) => i.kind === "work" && data().people.includes(i.who));

const DAY = 864e5;
export const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: Date.now() - seconds * 1000 > 300 * DAY ? "numeric" : undefined,
  });

// A due date as a row says it: past in the error's red, today in amber, within a week in the pill's
// own teal, later neutral (layout.css).
export function dueOf(due: string, now = Date.now()) {
  const today = new Date(now).toLocaleDateString("sv-SE");
  const date = day(Date.parse(due) / 1000);
  if (due < today) return { text: `was due ${date}`, tone: "overdue" };
  if (due === today) return { text: "due today", tone: "today" };
  return { text: `due ${date}`, tone: dueSoon(due, now) ? "soon" : "later" };
}

// A bare web address in rendered text becomes a link; one already in a link, in code or inside a
// tag stays, and an escaped quote or bracket ends it.
export const withLinks = (html: string) =>
  html.replace(
    /(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|\bhttps?:\/\/(?:(?!&(?:quot|#x27|#39|lt|gt);)[^\s<>"'])*[^\s<>"'.,;:!?)\]&]/g,
    (whole, tag?: string) => tag ?? `<a class="hw-link" href="${whole}">${whole}</a>`,
  );

// A one-line field (an option's detail, an assumption, evidence) as its Markdown is meant: code
// spans as inline code, addresses as links, the rest as text.
export const inline = (text: string) =>
  withLinks(Bun.escapeHTML(text).replace(/`([^`]+)`/g, '<code class="hw-inline-code">$1</code>'));
