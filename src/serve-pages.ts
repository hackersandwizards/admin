import { join } from "node:path";
import { MISSING, NOTICE } from "../site/src/data.ts";
import { reportBody } from "../site/src/report.ts";
import { SHELL, shellPath } from "./build.ts";
import { when } from "./display.ts";
import { isPlainReportName } from "./items.ts";
import type { Doc, RepoData, Report } from "./repo.ts";
import { docSlug, encodeFile, encodePath, fileHref } from "./repo-paths.ts";
import type { UnreadNotice } from "./serve-repos.ts";
import type { Page } from "./site-data.ts";

type Linker = ReturnType<typeof linker>;

export type Site = {
  key: string;
  built: number;
  files: ReadonlyMap<string, Buffer>;
  repos: readonly RepoData[];
  // A doc page's path to its doc, each repository's shells by their paths, and the doc pages
  // filled so far.
  docs: ReadonlyMap<string, { repo: RepoData; doc: Doc | Report }>;
  docPage(name: string): Buffer | undefined;
};

type DocTarget = { name: string; repoKey: string; doc: Doc | Report };
export type BuildNotice = { at: number; message: string; builtAt?: number };

export interface PageDecorator {
  setNotice(next: string): void;
  withNotice(html: Buffer): Buffer;
  stamp(html: Buffer, page: string, repos: readonly RepoData[]): Buffer;
}

// file:// links as the hub serves them: one to a doc with a page opens that page, any other the
// committed file under /_file/<repo>/.
export function linker(repos: RepoData[]) {
  const pageOf = new Map(
    repos.flatMap((r) =>
      [...r.reports, ...r.docs].map((d) => {
        const slug = docSlug(d.path);
        return [
          fileHref(join(r.path, d.path)),
          `/${encodePath(`${r.key}/${slug}`)}${slug.endsWith(".html") ? ".html" : ""}`,
        ] as const;
      }),
    ),
  );
  // Longest path first: a repository nested in another keeps its own prefix.
  const prefixes = [...repos]
    .sort((a, b) => b.path.length - a.path.length)
    .map((r) => [fileHref(r.path) + "/", `/_file/${encodeURIComponent(r.key)}/`] as const);
  const files = (html: string) => {
    for (const [from, to] of prefixes) html = html.replaceAll(from, to);
    return html;
  };
  const pages = (html: string) =>
    html.replace(
      /(?<!data-doc-source )href="(file:\/\/[^"?#]*)([?#][^"]*)?"/g,
      (link, file: string, rest = "") => {
        const to = pageOf.get(file);
        return to ? `href="${to}${rest}"` : link;
      },
    );
  return { files, pages };
}

export function extractShells(
  files: Map<string, Buffer>,
  pages: readonly Page[],
  links: Linker,
): Map<string, string> {
  const shellPaths = new Set(pages.filter((p) => p.article === SHELL).map((p) => p.path));
  const shells = new Map<string, string>();
  for (const [name, bytes] of files) {
    if (!name.endsWith(".html")) continue;
    const html = links.files(links.pages(bytes.toString("utf8")));
    const page = name.slice(0, -".html".length);
    if (shellPaths.has(page)) {
      shells.set(page, html);
      files.delete(name);
    } else files.set(name, Buffer.from(html));
  }
  return shells;
}

// A doc's page is its repository's key and its slug, as siteData names it.
export function indexDocs(repos: readonly RepoData[]) {
  return new Map(
    repos.flatMap((repo) =>
      [...repo.reports, ...repo.docs].map(
        (doc) => [`${repo.key}/${docSlug(doc.path)}`, { repo, doc }] as const,
      ),
    ),
  );
}

// As Astro escapes, so a filled page is the page a build renders.
const escapeHtml = (text: string) => Bun.escapeHTML(text).replaceAll("&#x27;", "&#39;");

export function renderDocShell(shell: string, target: DocTarget, links: Linker): string {
  const { name, repoKey, doc } = target;
  const report = "stem" in doc ? doc : undefined;
  const marks: Record<string, string> = {
    [` id="${SHELL.titleId}"`]: doc.titleId ? ` id="${escapeHtml(doc.titleId)}"` : "",
    [`/${SHELL.path}"`]: `/${escapeHtml(encodeFile(doc.path))}"`,
    [SHELL.path]: escapeHtml(doc.path),
    [SHELL.title]: escapeHtml(doc.title),
    [`"${SHELL.name}.html"`]: `"${encodeURIComponent(name.slice(name.lastIndexOf("/") + 1))}.html"`,
    [SHELL.html]: links.files(links.pages(report ? reportBody(repoKey, report) : doc.html)),
  };
  return shell
    .replace(
      /<div class="admin-action bg-background" data-shell-action(?:="[^"]*")?>[\s\S]*?<\/div>/,
      (bar) =>
        isPlainReportName(report?.stem) ? bar.replace(/ data-shell-action(?:="[^"]*")?/, "") : "",
    )
    .replace(new RegExp(Object.keys(marks).map(RegExp.escape).join("|"), "g"), (mark) => {
      const value = marks[mark];
      if (value === undefined) throw new Error(`Shell mark missing: ${mark} in ${name}`);
      return value;
    });
}

// A doc page, its doc filled into the shell for its depth, once per build.
export function createDocFiller(
  shells: ReadonlyMap<string, string>,
  docs: ReadonlyMap<string, { repo: RepoData; doc: Doc | Report }>,
  links: Linker,
) {
  const filled = new Map<string, Buffer>();
  return function docPage(name: string): Buffer | undefined {
    const hit = docs.get(name);
    if (!hit) return undefined;
    const done = filled.get(name);
    if (done) return done;
    const { repo, doc } = hit;
    const path = shellPath(`${repo.key}/`, name.split("/").length);
    const shell = shells.get(path);
    if (shell === undefined) throw new Error(`Document shell missing: ${path} for ${name}`);
    const page = Buffer.from(renderDocShell(shell, { name, repoKey: repo.key, doc }, links));
    filled.set(name, page);
    return page;
  };
}

// An address no page answers: the hub's own 404 page, its relative addresses made absolute so
// they hold at any depth.
export function rewriteMissingPage(template: string, missingPath: string): string {
  return template
    .replace(/((?:href|src)=")(?:\.\/)?(?![a-z][\w+.-]*:|#|\/)/gi, "$1/")
    .replaceAll(MISSING, () => Bun.escapeHTML(missingPath));
}

// What went wrong, for the notice on every page: the build that failed, and each repository
// that could not be read at its current state. Set once a refresh ends.
export function formatNotice(unread: readonly UnreadNotice[], buildFailure?: BuildNotice): string {
  const lines = unread.map(
    (u) =>
      `${u.name} could not be read: ${u.message}. ${u.hasLastRead ? "Its pages show its last read." : "It is left out."}`,
  );
  if (buildFailure) lines.unshift(`The build stopped: ${buildFailure.message}`);
  if (!lines.length) return "";
  const head = buildFailure
    ? `The hub could not rebuild on ${when(buildFailure.at)}.`
    : `The hub could not read ${lines.length === 1 ? "a repository" : `${lines.length} repositories`}.`;
  const shows =
    buildFailure && buildFailure.builtAt !== undefined
      ? ` These pages show the repositories as of ${when(buildFailure.builtAt)}.`
      : "";
  return `<p><b>${head}</b>${shows} It tries again a minute later, or once a repository changes; nothing to do unless this stays, and then the terminal running admin-serve shows the whole error.</p><ul class="hw-marker-list">${lines.map((l) => `<li>${Bun.escapeHTML(l)}</li>`).join("")}</ul>`;
}

// A fetch time this request found that differs from the one its pages print.
export function stampTime(
  repo: RepoData | undefined,
  fetched: number | undefined,
  now: number,
): number | undefined {
  if (!repo) return now;
  return repo.fetched && fetched && fetched !== repo.fetched ? fetched : undefined;
}

export function createPageDecorator(
  fetchedTime: (repoPath: string) => number | undefined,
): PageDecorator {
  let notice = "";
  let noticed = new WeakMap<Buffer, Buffer>();
  // Every request checks each repository first, so a page is current when it is served: a hub
  // page's provenance line ends on the request's time, and a repository page's on the fetch time this
  // request found, once a fetch that moved no ref left the page unbuilt.
  const stamped = new WeakMap<Buffer, { key: string; page: Buffer }>();

  function setNotice(next: string) {
    if (next !== notice) [notice, noticed] = [next, new WeakMap()];
  }

  function withNotice(html: Buffer): Buffer {
    if (!notice) return html;
    let page = noticed.get(html);
    if (!page)
      noticed.set(html, (page = Buffer.from(html.toString("utf8").replace(NOTICE, () => notice))));
    return page;
  }

  function stamp(html: Buffer, page: string, repos: readonly RepoData[]): Buffer {
    const repo = repos.find((r) => page.startsWith(`${r.key}/`));
    const at = stampTime(repo, repo ? fetchedTime(repo.path) : undefined, Date.now());
    if (!at) return html;
    const key = when(at);
    const done = stamped.get(html);
    if (done?.key === key) return done.page;
    const text = html
      .toString("utf8")
      .replace(/(<span data-stamp>)[^<]*/, (_, mark: string) => mark + Bun.escapeHTML(key));
    const next = Buffer.from(text);
    stamped.set(html, { key, page: next });
    return next;
  }

  return { setNotice, withNotice, stamp };
}
