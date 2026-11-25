// Runs on every admin page. src/build.ts bundles it with brand's element script into one classic
// script, not a module, so a page opened from disk loads it; a file of its own, since admin-serve's
// Content-Security-Policy runs no inline script.
import { enhance } from "@hackersandwizards/brand/elements/behaviour.ts";
import { setupAnswers } from "./answers.ts";
import { setupFilters } from "./filters.ts";
import { setupReveal } from "./reveal.ts";
import { browserStorage, createStore } from "./storage.ts";
import { shortDateTime } from "./time.ts";
import { pruneAnswers, trackVisit } from "./visits.ts";

enhance();

// A shot's button names its file to Layout's image dialog, in the capture phase, so the file is
// set before brand's data-hw-open opens the dialog.
const zoom = document.getElementById("admin-zoom");
document.addEventListener(
  "click",
  (e) => {
    const shot = e.target.closest?.("[data-zoom]");
    if (!shot || !zoom) return;
    const img = zoom.querySelector("img");
    img.src = shot.dataset.zoom;
    img.alt = shot.dataset.alt;
    zoom.setAttribute("aria-label", shot.dataset.alt);
  },
  true,
);

const STORE =
  "adminCatalog" in document.documentElement.dataset ? "admin-catalog:" : "admin-answers:";
const store = createStore(browserStorage(), STORE);

// The header's theme switch: the moon by day, the sun by night (header.css), the choice stored
// under "theme", which theme.js reads before the first paint. On a catalog state's page the
// shell's header carries brand's own switch under the same id ahead of this one, and a catalog
// page without data-hw-night stays day (theme.js), so its switch turns nothing.
const themeToggle = document.querySelector("[data-admin-theme]");
const themePressed = () =>
  themeToggle?.setAttribute(
    "aria-pressed",
    String(document.documentElement.dataset.theme === "dark"),
  );
themePressed();
new MutationObserver(themePressed).observe(document.documentElement, {
  attributeFilter: ["data-theme"],
});
const { adminCatalog, hwNight } = document.documentElement.dataset;
if (adminCatalog === undefined || hwNight !== undefined)
  themeToggle?.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    store.setRaw("theme", theme);
  });

pruneAnswers(store, document);
const updatedSince = trackVisit(store, document);
const answers = setupAnswers(store, document);
const filters = setupFilters(store, document, updatedSince);
const reveal = setupReveal(document, filters);

addEventListener("storage", (e) => {
  answers.onStorage(e.key);
  filters.onStorage(e.key);
});

filters.reloadRepos();
filters.apply();
answers.syncCopyState();
reveal();

// A page left open says once it is over an hour old, since it shows the state it was loaded in.
const loaded = Date.now();
const age = document.getElementById("admin-age");
const aged = () => {
  if (!age || Date.now() - loaded < 36e5) return;
  age.hidden = false;
  age.textContent = `This page shows the state of ${shortDateTime(new Date(loaded).toISOString())}. Reload it before you answer: items may have changed or closed since.`;
};
setInterval(aged, 6e4);
addEventListener("visibilitychange", aged);

// A catalog link opens only while its dev server runs: an opaque no-cors request answers
// when the server listens and fails when nothing does.
for (const p of document.querySelectorAll("[data-dev]")) {
  const out = p.querySelector("[data-dev-state]");
  const port = new URL(p.dataset.dev).port;
  fetch(p.dataset.dev, { mode: "no-cors", cache: "no-store" }).then(
    () => (out.textContent = `A server answers on port ${port} now.`),
    () => (out.textContent = `Nothing answers on port ${port} now.`),
  );
}
