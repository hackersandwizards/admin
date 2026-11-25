import Page from "../../../site/src/pages/[...slug].astro";
import { page, site } from "../../story";

export default { component: Page };

export const Default = { args: { page: site.pages.find((p) => p.topic) ?? page("doc") } };
