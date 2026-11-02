import styles from "@hackersandwizards/scaffolding/stylelint";

// The admin pages load brand's expert set and elements (src/build.ts), whose roles layout.css reads.
export default styles({
  importFrom: ["@hackersandwizards/brand/expert.css", "@hackersandwizards/brand/elements.css"],
});
