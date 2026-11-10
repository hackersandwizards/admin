import ItemGroups from "../../../site/src/components/ItemGroups.astro";
import { items } from "../../story";

export default { component: ItemGroups };

export const ByPriority = { args: { items } };
// The hub: within a priority, one run per repository under its name.
export const ByRepository = { args: { items, byRepo: true } };
export const AsLinks = { args: { items, from: "index", openUpTo: 3 } };
export const UnderATitle = { args: { items, title: "Assumed and decided" } };
