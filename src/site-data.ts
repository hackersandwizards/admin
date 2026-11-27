import { join } from "node:path";
import { version } from "../package.json";
import { compareItems, imagesOf, ITEMS_DIR, type Item } from "./items.ts";
import { renderItemMarkdown } from "./markdown.ts";
import { needsGraph, needsGraphItems, prerequisiteSummary } from "./needs-graph.ts";
import type { Doc, RepoData } from "./repo.ts";
import { docSlug, fileHref } from "./repo-paths.ts";

export type ViewItem = Item & {
  // The item file's last commit, in seconds.
  changed?: number;
  version?: string;
  repo: string;
  repoLabel: string;
  who: string;
  // Owned by an agent rather than a person: no person filter hides it.
  agent: boolean;
  html: string;
  // Option key to its images, "" for the item's own, each with its file URL.
  optionImages: Record<string, { src: string; caption?: string }[]>;
  recommendedKeys: string[];
  recommendedLabel?: string;
  waitingOn: string[];
  waitingCount: number;
};

export const PAGE_TYPES = [
  "hub",
  "hub-architecture",
  "dashboard",
  "decisions",
  "work",
  "reviews",
  "docs",
  "doc",
  "catalog",
  "product",
  "architecture",
  "checks",
  "log",
  "missing",
] as const;

export type Page = {
  path: string;
  type: (typeof PAGE_TYPES)[number];
  repo?: string;
  doc?: string;
  topic?: true;
  topicGraph?: string;
  // A doc page's own doc, where no list of the repository holds it: the shell's marks.
  article?: Doc;
  product?: number;
  title: string;
};

export type SiteData = {
  version: string;
  people: string[];
  // People other than the hub's user, and companies and teams, who own an open item: its
  // "Waiting on others".
  others: string[];
  repos: (Omit<RepoData, "items" | "workFiles" | "label"> & {
    label: string;
    items: ViewItem[];
    needsSvg?: string;
    prefix: string;
    dashboard: string;
  })[];
  pages: Page[];
  // Set by buildSite, never by the catalog: the nonce its pages' own scripts carry.
  nonce?: string;
};

type OwnerClass = { who: string; as: "person" | "agent" | "party" };
type OwnerClassifier = (owner?: string) => OwnerClass;
type ItemHtmlRenderer = (repo: RepoData, item: Item) => string;

export function createItemHtmlRenderer(repos: readonly RepoData[]): ItemHtmlRenderer {
  const byKey = new Map(repos.map((r) => [r.key, r]));
  const files = new Map(repos.map((r) => [r, new Set(r.workFiles)]));
  const named = (before: string, after: string) => {
    const keys = [
      before.match(/([\w.-]+)\s+(?:<code[^>]*>)?$/)?.[1],
      after.match(/^(?:<\/code>)?\s+in\s+([\w.-]+)/)?.[1],
    ];
    for (const key of keys) {
      if (key === undefined) continue;
      const target = byKey.get(key);
      if (target !== undefined) return target;
    }
  };
  return (repo: RepoData, item: Item) => {
    const html = renderItemMarkdown(repo.path, `${ITEMS_DIR}/${item.id}.md`, item.body);
    // A link or a tag goes through whole, so no path inside an attribute becomes a link.
    return html.replace(
      /<svg\b[\s\S]*?<\/svg>|<a\b[\s\S]*?<\/a>|<[^>]*>|(?<![\w/"=])docs\/agent-work\/[\w./äöüÄÖÜß-]*\w/g,
      (whole, at: number) => {
        if (whole.startsWith("<")) return whole;
        const target =
          named(html.slice(Math.max(0, at - 80), at), html.slice(at + whole.length)) ?? repo;
        const workFiles = files.get(target);
        if (workFiles === undefined) throw new Error(`Work files missing: ${target.key}`);
        return workFiles.has(whole)
          ? `<a class="hw-link" href="${Bun.escapeHTML(fileHref(join(target.path, whole)))}">${whole}</a>`
          : whole;
      },
    );
  };
}

export const firstWord = (owner = "") => owner.match(/^[\p{L}\p{N}-]+/u)?.[0] ?? owner;

export function createOwnerClassifier(repos: readonly RepoData[], you?: string): OwnerClassifier {
  const agents = new Set(repos.flatMap((r) => r.agents));
  const isAgent = (w: string) =>
    /^\p{Ll}[\p{Ll}\p{N}-]*$/u.test(w) ||
    /^(a|an|the|agent|claude|codex)$/i.test(w) ||
    agents.has(w);
  const open = repos.flatMap((r) => r.items.filter((i) => i.status === "open"));
  const joined = (owner: string) => /^[+&]/.test(owner.slice(firstWord(owner).length));
  const names = [
    ...new Set([you ?? "", ...open.map((i) => (joined(i.owner ?? "") ? "" : firstWord(i.owner)))]),
  ]
    .filter((p) => /^\p{Lu}/u.test(p) && !isAgent(p))
    .map((p) => ({ p, re: new RegExp(`(?<![\\p{L}\\p{N}-])${p}(?![\\p{L}\\p{N}-])`, "u") }));
  return (owner = ""): OwnerClass => {
    const person = names
      .map(({ p, re }) => ({ p, at: owner.search(re) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0]?.p;
    if (person) return { who: person, as: "person" };
    const [firstPart] = owner.split(/[,;(]/);
    if (firstPart === undefined) throw new Error(`Owner name part missing: ${owner}`);
    const party = firstPart.trim();
    return !party || (!joined(owner) && isAgent(firstWord(owner)))
      ? { who: firstWord(owner), as: "agent" }
      : { who: party, as: "party" };
  };
}

export function summarizeOwners(
  items: readonly Item[],
  classify: OwnerClassifier,
  you?: string,
): { people: string[]; others: string[] } {
  const asked = new Map<string, number>();
  const owned = new Map<string, number>();
  const parties = new Set<string>();
  for (const i of items) {
    if (i.status !== "open") continue;
    const { who: p, as } = classify(i.owner);
    if (as === "party") parties.add(p);
    if (as !== "person") continue;
    owned.set(p, (owned.get(p) ?? 0) + 1);
    if (i.kind === "decision" || i.kind === "review") asked.set(p, (asked.get(p) ?? 0) + 1);
  }
  const n = (m: Map<string, number>, p: string) => m.get(p) ?? 0;
  const people = [...owned.keys()].sort(
    (a, b) =>
      +(b === you) - +(a === you) ||
      n(asked, b) - n(asked, a) ||
      n(owned, b) - n(owned, a) ||
      a.localeCompare(b),
  );
  const others = [...people.slice(1), ...parties].sort();
  return { people, others };
}

export function repoViewItems(
  repo: RepoData,
  classify: OwnerClassifier,
  renderHtml: ItemHtmlRenderer,
): ViewItem[] {
  const repoLabel = repo.label ?? repo.key;
  const { waitingOn, waitingCount } = prerequisiteSummary(repo.items);
  return [...repo.items].sort(compareItems).map((i) => {
    const recommendedKeys = [i.recommended ?? []].flat();
    const { who, as } = classify(i.owner);
    return {
      ...i,
      waitingOn: waitingOn.get(i.id) ?? [],
      waitingCount: waitingCount.get(i.id) ?? 0,
      repo: repo.key,
      repoLabel,
      who,
      html: renderHtml(repo, i),
      agent: !!i.owner && as === "agent",
      optionImages: Object.fromEntries(
        Object.entries(imagesOf(i)).map(([k, list]) => [
          k,
          list.map((m) => ({ ...m, src: fileHref(join(repo.path, m.src)) })),
        ]),
      ),
      recommendedKeys,
      recommendedLabel:
        recommendedKeys.length > 3
          ? `${recommendedKeys.length} options`
          : i.options
              ?.filter((o) => recommendedKeys.includes(o.key))
              .map((o) => o.label)
              .join(", "),
    };
  });
}

export function repoPages(repo: RepoData, items: readonly ViewItem[]): Page[] {
  const prefix = `${repo.key}/`;
  const label = repo.label ?? repo.key;
  const pages: Page[] = [];
  const add = (p: Omit<Page, "repo" | "path"> & { path: string }) =>
    pages.push({ ...p, path: prefix + p.path, repo: repo.key });
  // A slug ending in "index" collides with the folder's own route, so a repo's dashboard is
  // <repo>/dashboard.
  const dashboard = `${prefix}dashboard`;
  pages.push({ path: dashboard, type: "dashboard", repo: repo.key, title: `${label} admin` });
  add({ path: "decisions", type: "decisions", title: "Decisions" });
  add({ path: "work", type: "work", title: "Work" });
  add({ path: "reviews", type: "reviews", title: "Reviews" });
  add({ path: "docs", type: "docs", title: "Docs" });
  if (repo.designSystem) add({ path: "catalog", type: "catalog", title: "Catalog" });
  repo.products.forEach((p, n) =>
    add({ path: `products-${n + 1}`, type: "product", product: n, title: p.label }),
  );
  add({ path: "architecture", type: "architecture", title: "Architecture" });
  add({ path: "checks", type: "checks", title: "Checks" });
  add({ path: "log", type: "log", title: "Log" });
  const topics = Map.groupBy(items, (i) => i.topic);
  for (const d of [...repo.reports, ...repo.docs]) {
    const topic = "stem" in d && typeof d.stem === "string" ? (topics.get(d.stem) ?? []) : [];
    const topicGraph = topic.some((i) => i.kind === "work" || i.kind === "goal")
      ? needsGraph(topic)
      : undefined;
    add({
      path: docSlug(d.path),
      type: "doc",
      doc: d.path,
      title: d.title,
      topic: topic.length ? true : undefined,
      topicGraph,
    });
  }
  return pages;
}

export function siteData(repos: RepoData[], you?: string): SiteData {
  const classify = createOwnerClassifier(repos, you);
  const { people, others } = summarizeOwners(
    repos.flatMap((r) => r.items),
    classify,
    you,
  );
  const pages: Page[] = [
    { path: "index", type: "hub", title: "Admin hub" },
    { path: "architecture", type: "hub-architecture", title: "Packages" },
    { path: "404", type: "missing", title: "No such page" },
  ];
  const named = repos
    .map((r) => ({ ...r, label: r.label ?? r.key }))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));
  const renderHtml = createItemHtmlRenderer(named);
  const out = named.map((r) => {
    const prefix = `${r.key}/`;
    const dashboard = `${prefix}dashboard`;
    const items = repoViewItems(r, classify, renderHtml);
    for (const page of repoPages(r, items)) pages.push(page);
    const { workFiles: _, ...rest } = r;
    const connected = needsGraphItems(items);
    const needsSvg = connected.length ? needsGraph(connected) : undefined;
    return { ...rest, items, prefix, dashboard, ...(needsSvg && { needsSvg }) };
  });
  return { version, people, others, repos: out, pages };
}
