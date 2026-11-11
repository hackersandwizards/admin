import WhoFilter from "../../../site/src/components/WhoFilter.astro";

export default { component: WhoFilter };

export const People = {};
// The hub's: a third row chooses which repositories show.
export const OnTheHub = { args: { repos: true } };
