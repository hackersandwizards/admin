import NeedsGraph from "../../../site/src/components/NeedsGraph.astro";
import { needsGraphItems } from "../../../src/needs-graph";
import { items, page, repo } from "../../story";

export default { component: NeedsGraph };

export const Graph = {
  args: {
    svg: repo.needsSvg,
    items: needsGraphItems(items),
    from: page("work").path,
    open: true,
  },
};
