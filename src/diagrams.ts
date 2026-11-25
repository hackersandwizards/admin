import { createRequire } from "node:module";
import { entities } from "./entities.ts";

export type MermaidRenderer = typeof import("beautiful-mermaid").renderMermaidSVG;

export function resolveMermaidRenderer(
  load: (id: string) => unknown,
  resolveId: (id: string) => string,
): MermaidRenderer | null {
  let entry: string;
  try {
    entry = resolveId("beautiful-mermaid");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND")
      throw error;
    return null;
  }
  return (load(entry) as typeof import("beautiful-mermaid")).renderMermaidSVG;
}

export function createMermaidLoader(
  load: (id: string) => unknown,
  resolveId: (id: string) => string,
): () => MermaidRenderer | null {
  let cached: MermaidRenderer | null | undefined;
  return () => {
    if (cached === undefined) cached = resolveMermaidRenderer(load, resolveId);
    return cached;
  };
}

const requireMermaid = createRequire(import.meta.url);
const cachedMermaidRenderer = createMermaidLoader(requireMermaid, (id) =>
  requireMermaid.resolve(id),
);

export function cleanMermaidSource(source: string): string {
  const lines = entities(source)
    .replace(/^\s*%%\{[\s\S]*?\}%%[^\S\n]*/gm, "")
    .split("\n")
    .filter((line) => !/^\s*%%|^\s*(?:classDef|style|linkStyle|click)\s/.test(line));
  const header = lines.find((line) => line.trim())?.trim();
  const body = /^classDiagram(?:\s*;|$)/i.test(header ?? "")
    ? lines
    : lines.filter((line) => !/^\s*class\s/.test(line));
  return body.join("\n");
}

export const scopeLocalUrls = (value: string, prefix: string) =>
  value.replace(/\burl\((["']?)#([^\s"')]+)\1\)/g, `url($1#${prefix}$2$1)`);

export function scopeSvgCss(css: string, prefix: string): string {
  const scoped = css
    .replace(/^[ \t]*@import url\([^\n]*fonts\.googleapis\.com[^\n]*\);\n/gm, "")
    .replace(/^[ \t]*(?:text|\.mono)\s*\{[^}]*\}\n/gm, "")
    .replace(
      /^([ \t]*)((?:svg\b|[a-z]*\.[\w-]+)[^{}\n]*)\{/gm,
      (_, space: string, selectors: string) =>
        `${space}${selectors
          .split(",")
          .map((s) => `#${prefix}svg${s.trim() === "svg" ? "" : ` ${s.trim()}`}`)
          .join(", ")} {`,
    );
  return scopeLocalUrls(scoped, prefix);
}

export function scopeSvgAttribute(name: string, value: string, prefix: string): string | undefined {
  if (name === "href" || name === "xlink:href")
    return value.startsWith("#") ? `#${prefix}${value.slice(1)}` : undefined;
  if (name === "id" || name === "aria-labelledby" || name === "aria-describedby")
    return value.replace(/\S+/g, (id) => prefix + id);
  return name.startsWith("data-") ? undefined : scopeLocalUrls(value, prefix);
}

export function scopeSvg(svg: string, prefix: string): string {
  return svg
    .replace(
      /<style>([\s\S]*?)<\/style>/g,
      (_, css: string) => `<style>${scopeSvgCss(css, prefix)}</style>`,
    )
    .replace(/<[a-z][^<>]*>/gi, (tag) =>
      tag.replace(/\s([\w:-]+)="([^"]*)"/g, (all, name: string, value: string) => {
        const scoped = scopeSvgAttribute(name, value, prefix);
        return scoped === undefined ? all : ` ${name}="${scoped}"`;
      }),
    )
    .replace("<svg ", `<svg id="${prefix}svg" `);
}

export function diagram(source: string, prefix: string) {
  const code = `<pre><code class="language-mermaid">${source}</code></pre>`;
  try {
    const renderer = cachedMermaidRenderer();
    if (renderer === null) return code;
    // The renderer decodes XML on entry. Keep it from decoding a second layer after filtering.
    const svg = renderer(Bun.escapeHTML(cleanMermaidSource(source)), {
      bg: "var(--background)",
      fg: "var(--foreground)",
      transparent: true,
    });
    return `<figure class="admin-diagram not-prose" tabindex="0">${scopeSvg(svg, prefix)}</figure>`;
  } catch (error) {
    const message = Bun.escapeHTML(error instanceof Error ? error.message : String(error));
    return `${code}<p>This diagram did not render: ${message}</p>`;
  }
}
