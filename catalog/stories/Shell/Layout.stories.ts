import Layout from "../../../site/src/components/Layout.astro";
import { page } from "../../story";

export default { component: Layout };

export const Repository = {
  args: {
    page: page("dashboard"),
    lead: "The top bar names the place and switches repos; the rail holds the repo's pages under the way back to the hub.",
  },
};
export const Hub = { args: { page: page("hub"), lead: "The hub's menu and every repository." } };
