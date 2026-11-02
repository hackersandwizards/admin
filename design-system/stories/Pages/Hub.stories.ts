import Page from "../../../site/src/pages/[...slug].astro";
import { page } from "../../story";

export default { component: Page };

export const Default = { args: { page: page("hub") } };
