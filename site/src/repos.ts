import { describeHiddenRepos, loadHiddenRepos } from "./filter-rules.ts";
import type { AdminStore } from "./storage.ts";

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
    this.#renderRows();
    const summary = this.#doc.querySelector("[data-repo-said]");
    if (summary === null) throw new Error("repository choice summary missing: data-repo-said");
    summary.textContent = view.summary;
    const showAll = this.#doc.querySelector<HTMLElement>("[data-repo-all]");
    if (showAll === null)
      throw new Error("repository choice Show all button missing: data-repo-all");
    showAll.hidden = view.hideShowAll;
    const hideAll = this.#doc.querySelector<HTMLElement>("[data-repo-none]");
    if (hideAll === null)
      throw new Error("repository choice Hide all button missing: data-repo-none");
    hideAll.hidden = view.hideHideAll;
    const count = this.#doc.querySelector("[data-repo-count]");
    if (count === null) throw new Error("repository choice count missing: data-repo-count");
    count.textContent = view.countText;
  }

  #renderRows(): void {
    for (const row of this.#doc.querySelectorAll<HTMLElement>("[data-repo-row]")) {
      const mark = row.querySelector<HTMLElement>("[data-repo-off]");
      const key = row.dataset.repoRow ?? "";
      if (mark === null) throw new Error(`hidden repository mark missing: ${key}`);
      mark.hidden = !this.#off.has(key);
    }
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
