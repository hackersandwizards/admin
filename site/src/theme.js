// Runs in every admin page's head, before the first paint: the theme the header's switch stored
// under "theme", the key every h&w app keeps, else the system's.
let chosen = null;
try {
  chosen = localStorage.getItem("theme");
} catch {}
if (chosen === "dark" || (chosen !== "light" && matchMedia("(prefers-color-scheme: dark)").matches))
  document.documentElement.dataset.theme = "dark";
