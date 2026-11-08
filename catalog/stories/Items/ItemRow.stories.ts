import ItemRow from "../../../site/src/components/ItemRow.astro";
import { item } from "../../story";

export default { component: ItemRow };

export const Decision = { args: { item: item("pick-a-variant") } };
export const DecisionOpen = { args: { item: item("pick-a-variant"), open: true } };
export const Review = { args: { item: item("check-the-copy") } };
export const Work = { args: { item: item("work-wire-the-gate"), open: true } };
export const Assumed = { args: { item: item("cache-folder"), open: true } };
export const InTheHub = { args: { item: item("pick-a-variant"), showRepo: true } };
// 18 candidates, each scored blind with a light and a dark image.
export const ManyVariants = { args: { item: item("pick-a-logo"), open: true } };
// 18 candidates without images, several to pick: one dense list.
export const PickSeveral = { args: { item: item("pick-recipients"), open: true } };
export const Decided = { args: { item: item("name-the-command"), open: true } };
export const Goal = { args: { item: item("goal"), open: true } };
