window.DECISION_REPOS = window.DECISION_REPOS || {};
// A comment line.
window.DECISION_AREAS = { product: "Product" };
window.DECISION_REPOS["legacy-key"] = [
  {
    id: "pick-a-name",
    title: "Which name does the tool take?",
    area: "product",
    priority: 2,
    order: 3,
    status: "open",
    context: "Two names were tested. Report: docs/tracking/2026-01-15-naming.md.",
    options: [
      { key: "a", label: "Name A", detail: "Short." },
      { key: "b", label: "Name B" },
    ],
    recommended: "a",
  },
  {
    id: "look-at-logo",
    title: "Look at the logo draft",
    area: "product",
    priority: 1,
    order: 1,
    status: "open",
    owner: "Sam",
    context: "Answer fine or what to change.",
  },
  {
    id: "colour-default",
    title: "Default colour",
    area: "product",
    priority: 3,
    order: 9,
    status: "assumed",
    context: "Picked by an agent.",
    detail: "Measured on two screens.",
    options: [
      { key: "teal", label: "Teal" },
      { key: "purple", label: "Purple" },
    ],
    recommended: "teal",
    assumption: "Teal, as the brand leads with it.",
    source: "a stray field",
  },
  {
    id: "ship-date",
    title: "Ship date",
    area: "product",
    priority: 2,
    order: 2,
    status: "decided",
    context: "When to ship.",
    decision: "Sam 02.01.: ship on Monday.",
    options: [
      { key: "mon", label: "Monday" },
      { key: "fri", label: "Friday" },
    ],
  },
];
