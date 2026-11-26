import { join } from "node:path";
import { diagram } from "./diagrams.ts";
import { entities } from "./entities.ts";
import { decodePercentEncoding, parseYamlFrontmatter } from "./parse-text.ts";
import { fileHref, SCHEME, splitLinkPath } from "./repo-paths.ts";

const plainText = (html: string) =>
  html
    .replace(/<[^<>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function tableHeaderLabel(tableBody: string): string {
  const [firstRow] = tableBody.split(/<\/tr>/i, 1);
  return [...firstRow.matchAll(/<t[hd]\b[^<>]*>((?:(?!<t[hd]\b)[\s\S])*?)<\/t[hd]>/gi)]
    .map(([, cell]) => plainText(cell))
    .filter(Boolean)
    .join(" ");
}

export function wrapScrollableTable(tableBody: string, attrs: string, label: string): string {
  const region = label ? ` role="region" aria-label="${label.replaceAll('"', "&quot;")}"` : "";
  return `<div class="hw-table-scroll" tabindex="0"${region}><table${attrs || ' class="hw-table not-prose"'}>${tableBody}</div>`;
}

// brand's tableScroll (elements/table.ts) takes a hast tree: this is the same step on Bun's HTML
// string, held to brand's names by a test. Entities stay encoded, which the attribute decodes. A
// table holding another is left to the inner one, so no wrapper closes inside a cell; a raw table
// with attributes is wrapped as written. A tag ends before the next "<", so an unclosed one costs
// no scan to the end of the text.
const HEADING_OR_TABLE =
  /<(?<tag>h[1-6])\b[^<>]*>(?<heading>(?:(?!<h[1-6]\b)[\s\S])*?)<\/\k<tag>>|<table\b(?<attrs>[^<>]*)>(?<table>(?:(?!<table\b)[\s\S])*?<\/table>)/gi;

export function tableScroll(html: string): string {
  let title = "";
  const used = new Set<string>();
  let out = "";
  let cursor = 0;
  for (const match of html.matchAll(HEADING_OR_TABLE)) {
    const index = match.index;
    out += html.slice(cursor, index);
    cursor = index + match[0].length;
    const groups = match.groups;
    if (groups === undefined) throw new Error(`Heading or table groups missing: offset ${index}`);
    const { tag, heading, attrs, table } = groups;
    if (tag) {
      if (heading === undefined) throw new Error(`Heading content missing: offset ${index}`);
      title = plainText(heading);
      out += match[0];
      continue;
    }
    if (table === undefined || attrs === undefined)
      throw new Error(`Table content or attributes missing: offset ${index}`);
    const base = title || tableHeaderLabel(table);
    let name = base;
    for (let n = 2; name && used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    out += wrapScrollableTable(table, attrs, name);
  }
  return out + html.slice(cursor);
}

// brand's prose block asks for tables, quotes and code blocks to be not-prose. A link keeps hw-link
// for an item's text, which no prose block holds. A task list gets no marker beside its checkboxes,
// and its boxes are brand's read-only hw-check, a state shown rather than a control, each in a
// <label> with its line's text up to the next block, which names the box; a loose item's label sits
// inside its <p>. The text stops before the next <input, so a run of them costs no rescan each.
// A <meta> tag shows as text, since csp() in serve-http.ts cannot stop its refresh. The opening is
// escaped rather than the attributes matched, which quoting would defeat.
export const withElements = (html: string) =>
  tableScroll(html.replace(/<meta(?=[\s/>])/gi, "&lt;meta"))
    .replace(/<blockquote>/g, '<blockquote class="hw-quote not-prose">')
    .replace(/<a href=/g, '<a class="hw-link" href=')
    .replace(/<ul>(?!\s*<li class="task-list-item")/g, '<ul class="hw-marker-list">')
    .replace(
      /<input type="checkbox" class="task-list-item-checkbox"([^<>]*)>(\n<p>)?((?:(?!<input)[\s\S])*?)(?=<\/p>|\n<(?:[uo]l|blockquote|pre|table|figure|hr|div|h[1-6]|p)\b|<\/li>|<input)/g,
      '$2<label><input type="checkbox" class="task-list-item-checkbox hw-check" data-readonly$1>$3</label>',
    )
    .replace(/<pre>/g, '<pre class="hw-code not-prose">')
    .replace(/(?<!<pre[^>]*>)<code>/g, '<code class="hw-inline-code">');

// A link goes out only over http(s), to mailto or to a path; any other scheme shows its text,
// beside the pages' policy, which refuses a javascript: link too. HTMLRewriter reads tags as a
// browser does, a doc's raw HTML included. A browser decodes an href's entities, trims spaces and
// control characters around it and drops tabs and newlines inside before it reads the scheme; the
// test decodes the numeric entities and &amp; or &AMP; and drops every character below "!", and
// any other named entity before the first / ? or # leaves the link text. An SVG <set> or <animate>
// could write an href after this test, so one aimed at href goes.
export function isUnsafeLink(href: string): boolean {
  const h = entities(href).replace(/[^!-\uffff]/g, "");
  // Before decoding, since a decoded "&#38;" or "&amp;" is no entity.
  const prefix = href.match(/^(?:&#|[^/?#])*/);
  if (prefix === null) throw new Error(`Link prefix missing: ${href}`);
  const named = /&(?!amp;|AMP;|#)/.test(prefix[0]);
  return !/^(?:https?|mailto):/i.test(h) && (SCHEME.test(h) || named);
}

const links = new HTMLRewriter()
  .on("a, area", {
    element(el) {
      const hrefs = [el.getAttribute("href"), el.getAttribute("xlink:href")];
      if (hrefs.some((h) => h !== null && isUnsafeLink(h))) el.removeAndKeepContent();
    },
  })
  .on("set, animate", {
    element(el) {
      if (/href$/i.test(el.getAttribute("attributeName") ?? "")) el.remove();
    },
  });

export const stripUnsafeLinks = (html: string) => links.transform(html);

const ADMIN_ID = /^(?:admin-|copy$|state$|theme-toggle$|(?:sun|moon)-icon$)/;

// Front matter is a leading YAML mapping between --- lines; a leading rule renders, since "---"
// above a paragraph is no mapping.
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\n([\s\S]*?)\n---\n/, (all, yaml: string) => {
    const parsed = parseYamlFrontmatter(yaml);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "" : all;
  });
}

export function sanitizeMarkup(html: string): string {
  const used = new Set<string>();
  return new HTMLRewriter()
    .on("*", {
      element(el) {
        for (const [name] of [...el.attributes])
          if (name.toLowerCase().startsWith("data-")) el.removeAttribute(name);
        const id = el.getAttribute("id");
        if (id && !/^h[1-6]$/.test(el.tagName) && ADMIN_ID.test(entities(id)))
          el.removeAttribute("id");
      },
    })
    .on("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]", {
      element(el) {
        const originalId = el.getAttribute("id");
        if (originalId === null) throw new Error(`Heading ID missing: ${el.tagName}`);
        const slug = entities(originalId).replace(/[^\p{L}\p{M}\p{N}_-]/gu, "-") || "section";
        const base = ADMIN_ID.test(slug) ? `section-${slug}` : slug;
        let id = base;
        for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        el.setAttribute("id", id);
      },
    })
    .transform(html);
}

const MERMAID_BLOCK = /<pre><code class="language-mermaid">([^<]*)<\/code><\/pre>/;
const MERMAID_BLOCKS = new RegExp(MERMAID_BLOCK.source, "g");

export const hasMermaidBlock = (html: string) => MERMAID_BLOCK.test(html);

export function renderMermaidBlocks(html: string, documentId: string): string {
  let index = 0;
  return html.replace(MERMAID_BLOCKS, (_, source: string) =>
    diagram(source, `mermaid-${documentId}-${++index}-`),
  );
}

// A stray % in a hand-written link stays as written.
export function decodeLinkPath(path: string): string {
  return decodePercentEncoding(path) ?? path;
}

export function rewriteRelativeUrls(html: string, dir: string): string {
  return html.replace(
    /(src|href)="(?![a-z][\w+.-]*:|#|\/)([^"]*)"/gi,
    (all, attr: string, value: string) => {
      // "q&a.md" arrives as "q&amp;a.md", "roll's.md" as "roll&#x27;s.md".
      const text = entities(value);
      // Read as a browser does, without the spaces and controls around it and tabs or newlines.
      if (/^(?:[a-z][\w+.-]*:|#|\/)/i.test(text.replace(/^[\0- ]+|[\t\n\r]/g, ""))) return all;
      const [rawPath, rawRest] = splitLinkPath(text);
      const decodedPath = decodeLinkPath(rawPath);
      // Every markup character stays an entity, since this replace also reaches text.
      const rest = Bun.escapeHTML(rawRest);
      return `${attr}="${fileHref(join(dir, decodedPath))}${rest}"`;
    },
  );
}

export function finishRenderedHtml(html: string, dir: string, documentId: string): string {
  const withDiagrams = renderMermaidBlocks(html, documentId);
  const styled = withElements(withDiagrams);
  return rewriteRelativeUrls(stripUnsafeLinks(styled), dir);
}

export function renderDocMarkdown(repo: string, path: string, text: string): string {
  const cleaned = sanitizeMarkup(
    Bun.markdown.html(stripFrontmatter(text), { headings: { ids: true } }),
  );
  const documentId = hasMermaidBlock(cleaned)
    ? Bun.hash(JSON.stringify([repo, path, text])).toString(36)
    : "";
  return finishRenderedHtml(cleaned, join(repo, path, ".."), documentId);
}

// An item's body has no front matter and no HTML: a placeholder such as <id> shows as written,
// and an address in angle brackets is linked by the pages.
export function renderItemMarkdown(repo: string, path: string, text: string): string {
  const cleaned = sanitizeMarkup(
    Bun.markdown.html(text, { noHtmlSpans: true, noHtmlBlocks: true }),
  );
  const documentId = hasMermaidBlock(cleaned)
    ? Bun.hash(JSON.stringify([repo, path, text])).toString(36)
    : "";
  return finishRenderedHtml(cleaned, join(repo, path, ".."), documentId);
}

// A page's title is its first rendered h1, which leaves the article since the title shows above it.
export function extractTitle(html: string): { title?: string; titleId?: string; html: string } {
  // From the first <h1 on: an unanchored search would scan to the end once per <h1.
  const h1 = html
    .slice(Math.max(html.indexOf("<h1"), 0))
    .match(/^<h1(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>([\s\S]*?)<\/h1>\n?/);
  // Bun's renderer decodes every other entity itself.
  const title = h1?.[1] && entities(plainText(h1[1]));
  // An h1 without text, such as a lone image, stays in the article.
  if (!h1 || !title) return { html };
  let titleId: string | undefined;
  new HTMLRewriter()
    .on("h1", {
      element(el) {
        titleId ??= el.getAttribute("id") ?? undefined;
      },
    })
    .transform(h1[0]);
  return { title, titleId, html: html.replace(h1[0], "") };
}
