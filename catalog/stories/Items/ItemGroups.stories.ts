import ItemGroups from "../../../site/src/components/ItemGroups.astro";
import { items } from "../../story";

export default { component: ItemGroups };

export const ByPriority = { args: { items } };
export const UnderATitle = { args: { items, title: "Assumptions and decided items" } };
