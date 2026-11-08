import Choice from "../../../site/src/components/Choice.astro";
import { item } from "../../story";

export default { component: Choice };

const one = item("pick-a-variant");
const several = item("pick-recipients");
export const Recommended = {
  args: { item: one, option: one.options![0], name: "c", score: "8.4 ± 0.5" },
};
export const Plain = { args: { item: one, option: one.options![1], name: "c", score: "6.1" } };
export const Unscored = {
  args: { item: several, option: several.options![0], name: "m", score: "" },
};
