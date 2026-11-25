import NeedsGraph from "../../../site/src/components/NeedsGraph.astro";
import { needsGraphItems } from "../../../src/build";
import { items, page, site } from "../../story";

export default { component: NeedsGraph };

export const Graph = {
  args: {
    svg: site.repos[0]!.needsSvg,
    items: needsGraphItems(items),
    from: page("work").path,
    open: true,
  },
};
