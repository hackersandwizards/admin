import ItemRow from "../../../site/src/components/ItemRow.astro";
import { item } from "../../story";

export default { component: ItemRow };

export const Decision = { args: { item: item("pick-a-variant") } };
export const DecisionOpen = { args: { item: item("pick-a-variant"), open: true } };
export const Review = { args: { item: item("check-the-copy") } };
export const Work = { args: { item: item("work-wire-the-gate"), open: true } };
export const Assumed = { args: { item: item("cache-folder"), open: true } };
export const InTheHub = { args: { item: item("pick-a-variant"), showRepo: true } };
