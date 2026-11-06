import ItemGroups from "../../../site/src/components/ItemGroups.astro";
import { items } from "../../story";

export default { component: ItemGroups };

export const ByPriority = { args: { items } };
export const UnderATitle = { args: { items, title: "Assumptions and decided items" } };
// Every kind in one list, the goal among them, as the Reviews page lists items with images.
export const EveryKind = { args: { items, title: "Items with images" } };
