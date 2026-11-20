import base from "@hackersandwizards/scaffolding/eslint/astro";

export default [...base, { ignores: ["site/.build-*/**", ".stryker-tmp/**"] }];
