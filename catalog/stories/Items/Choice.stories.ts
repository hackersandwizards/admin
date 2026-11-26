import Choice from "../../../site/src/components/Choice.astro";
import type { ViewItem } from "../../../site/src/data";
import { item } from "../../story";

export default { component: Choice };

const one = item("pick-a-variant");
const several = item("pick-recipients");

function storyOption(item: ViewItem, position: number) {
  const option = item.options?.[position];
  if (option === undefined)
    throw new Error(`catalog option missing: ${item.id} at index ${position}`);
  return option;
}

export const Recommended = {
  args: { item: one, option: storyOption(one, 0), name: "c", score: "8.4 ± 0.5" },
};
export const Plain = { args: { item: one, option: storyOption(one, 1), name: "c", score: "6.1" } };
export const Unscored = {
  args: { item: several, option: storyOption(several, 0), name: "m", score: "" },
};
