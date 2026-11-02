import Layout from "../../../site/src/components/Layout.astro";
import { page } from "../../story";

export default { component: Layout };

export const Repository = {
  args: { page: page("dashboard"), lead: "The repository's menu in the rail, the page beside it." },
};
export const Hub = { args: { page: page("hub"), lead: "The hub's menu and every repository." } };
