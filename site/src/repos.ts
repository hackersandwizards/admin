import { describeHiddenRepos, loadHiddenRepos } from "./filter-rules.ts";
import type { AdminStore } from "./storage.ts";

// The hub's choice of repositories: the keys hidden, kept in this browser across visits until
// shown again. Elsewhere no row hides by its repository.
export class HiddenRepos {
  readonly #store: AdminStore;
  readonly #doc: Document;
  readonly #boxes: HTMLInputElement[];
  readonly #allRepos: string[];
  #off = new Set<string>();

  constructor(store: AdminStore, doc: Document) {
    this.#store = store;
    this.#doc = doc;
    this.#boxes = [...doc.querySelectorAll<HTMLInputElement>("[data-repo-box]")];
    this.#allRepos = this.#boxes.map((box) => box.value);
  }

  get hidden(): ReadonlySet<string> {
    return this.#off;
  }

  // `stored` reads the choice from storage first, as on load and when another tab changed it.
  // Split here into reload() and render().
  reload(): void {
    if (!this.#boxes.length) return;
    this.#off = loadHiddenRepos(this.#store.readJson("repos"), this.#allRepos);
    this.render();
  }

  render(): void {
    if (!this.#boxes.length) return;
    const names = this.#boxes
      .filter((box) => this.#off.has(box.value))
      .map((box) => box.dataset.label ?? "");
    const view = describeHiddenRepos(names, this.#allRepos.length);
    for (const box of this.#boxes) box.checked = !this.#off.has(box.value);
    for (const row of this.#doc.querySelectorAll<HTMLElement>("[data-repo-row]"))
      row.querySelector<HTMLElement>("[data-repo-off]")!.hidden = !this.#off.has(
        row.dataset.repoRow ?? "",
      );
    this.#doc.querySelector("[data-repo-said]")!.textContent = view.summary;
    this.#doc.querySelector<HTMLElement>("[data-repo-all]")!.hidden = view.hideShowAll;
    this.#doc.querySelector<HTMLElement>("[data-repo-none]")!.hidden = view.hideHideAll;
    this.#doc.querySelector("[data-repo-count]")!.textContent = view.countText;
  }

  // Storage tells the hub's other tabs; blocked, the choice holds for this page.
  #persist(onChange: () => void): void {
    this.#store.writeJson("repos", this.#off.size ? [...this.#off] : null);
    this.render();
    onChange();
  }

  bind(onChange: () => void): void {
    for (const box of this.#boxes)
      box.addEventListener("change", () => {
        if (box.checked) this.#off.delete(box.value);
        else this.#off.add(box.value);
        this.#persist(onChange);
      });
    // Each hides itself once pressed: focus goes to the choice's own button, whose count says the
    // result, rather than to the page's top or the other button, which a held Enter would press.
    const repoChoice = this.#doc.querySelector<HTMLElement>("[popovertarget=admin-repo-choice]");
    this.#doc.querySelector("[data-repo-all]")?.addEventListener("click", () => {
      this.#off.clear();
      this.#persist(onChange);
      repoChoice?.focus();
    });
    this.#doc.querySelector("[data-repo-none]")?.addEventListener("click", () => {
      for (const key of this.#allRepos) this.#off.add(key);
      this.#persist(onChange);
      repoChoice?.focus();
    });
  }
}
