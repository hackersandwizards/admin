// Runs in every admin page's head, before the first paint: the theme the header's switch stored
// under "theme", the key every h&w app keeps, else the system's. A catalog page without
// data-hw-night (a state alone, a tile's frame) stays day: the shell set it so in its head and
// draws it without the night ground.
let chosen = null;
try {
  chosen = localStorage.getItem("theme");
} catch {}
const { adminCatalog, hwNight } = document.documentElement.dataset;
if (
  (adminCatalog === undefined || hwNight !== undefined) &&
  (chosen === "dark" || (chosen !== "light" && matchMedia("(prefers-color-scheme: dark)").matches))
)
  document.documentElement.dataset.theme = "dark";
