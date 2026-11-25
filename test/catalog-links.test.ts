import { describe, expect, test } from "vitest";
import { rewriteCatalogGraphLinks } from "../catalog/fixture-links.ts";

describe("rewriteCatalogGraphLinks", () => {
  test.each([
    {
      label: "rewrites a work graph node link from a nested story",
      html: '<a href="work.html#spoke:wire"><g class="node" data-id="n0"></g></a>',
      filePath: "/out/stories/Items/needs-graph/graph/index.html",
      expected:
        '<a href="../../../Pages/work/default/#spoke:wire"><g class="node" data-id="n0"></g></a>',
    },
    {
      label: "uses ./ when the file is already in the target story directory",
      html: '<a href="decisions.html#spoke:pick"><g class="node" data-id="n1"></g></a>',
      filePath: "/out/stories/Pages/decisions/default/index.html",
      expected: '<a href="./#spoke:pick"><g class="node" data-id="n1"></g></a>',
    },
    {
      label: "rewrites both work and decisions links in one SVG",
      html: '<a href="work.html#spoke:a"><g class="node"></a><a href="decisions.html#spoke:b"><g class="node"></a>',
      filePath: "/out/index.html",
      expected:
        '<a href="stories/Pages/work/default/#spoke:a"><g class="node"></a><a href="stories/Pages/decisions/default/#spoke:b"><g class="node"></a>',
    },
    {
      label: "leaves links to other pages untouched",
      html: '<a href="docs.html#spoke:a"><g class="node"></a>',
      filePath: "/out/index.html",
      expected: '<a href="docs.html#spoke:a"><g class="node"></a>',
    },
    {
      label: "leaves non-node links untouched",
      html: '<a href="work.html#spoke:a"><span>Wire</span></a>',
      filePath: "/out/index.html",
      expected: '<a href="work.html#spoke:a"><span>Wire</span></a>',
    },
    {
      label: "leaves node links without a hash untouched",
      html: '<a href="work.html"><g class="node"></a>',
      filePath: "/out/index.html",
      expected: '<a href="work.html"><g class="node"></a>',
    },
  ])("$label", ({ html, filePath, expected }) => {
    expect(rewriteCatalogGraphLinks(html, filePath, "/out")).toBe(expected);
  });
});
