import { dirname, join, relative } from "node:path";

export function rewriteCatalogGraphLinks(html: string, filePath: string, outputDir: string) {
  return html.replace(
    /href="(work|decisions)\.html(#[^"]+)">(?=<g class="node")/g,
    (_, page: string, hash: string) => {
      const story = relative(dirname(filePath), join(outputDir, "stories/Pages", page, "default"));
      return `href="${story ? `${story}/` : "./"}${hash}">`;
    },
  );
}
