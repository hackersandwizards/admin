import LinkRow from "../../../site/src/components/LinkRow.astro";
import { item } from "../../story";

export default { component: LinkRow };

// An agent's work, as the hub lists it under "Agents on it".
export const AgentWork = { args: { item: item("sort-the-samples"), from: "index" } };
export const Decision = { args: { item: item("pick-a-variant"), from: "index" } };
