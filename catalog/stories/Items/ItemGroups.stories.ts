import ItemGroups from "../../../site/src/components/ItemGroups.astro";
import { items } from "../../story";

export default { component: ItemGroups };

export const ByPriority = { args: { items } };
// The hub: every repository's rows in one order, each naming its repository.
export const AcrossRepositories = { args: { items, showRepo: true } };
export const AsLinks = { args: { items, from: "index", openUpTo: 3 } };
export const UnderATitle = { args: { items, title: "Assumed and decided" } };
