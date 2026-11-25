import {
  assumptionsText,
  changedSinceText,
  classifyRow,
  decodeHash,
  matchesPerson,
  noMatchSentence,
  type ActiveFilters,
  type HiddenMatches,
  type RowFilterInfo,
} from "./filter-rules.ts";
import { HiddenRepos } from "./repos.ts";
import type { AdminStore } from "./storage.ts";

const STRIP_MARKS = "[data-updated], .mark, .saved, [data-stale], [data-repo-off]";

function isElementShown(el: Element): boolean {
  return !el.closest("[hidden]");
}

function createRowTextCache(): (row: HTMLElement) => string {
  // What a row says, without the marks this script writes or shows on it.
  const said = new Map<HTMLElement, string>();
  return (row) => {
    if (!said.has(row)) {
      const copy = row.cloneNode(true) as HTMLElement;
      for (const mark of copy.querySelectorAll(STRIP_MARKS)) mark.remove();
      said.set(row, (copy.textContent ?? "").toLowerCase());
    }
    return said.get(row)!;
  };
}

function narrowOptionRows(row: HTMLElement, term: string): void {
  // Options narrow only where one matches: a row found by its title keeps all of them.
  const options = [...row.querySelectorAll<HTMLElement>("[data-option-row]")];
  const hits = options.map(
    (option) => Boolean(term) && (option.textContent ?? "").toLowerCase().includes(term),
  );
  const anyHit = hits.includes(true);
  options.forEach((option, index) => {
    option.hidden = anyHit && !hits[index];
  });
}

function rowIdentityOf(row: HTMLElement, target: HTMLElement | null) {
  return {
    who: row.dataset.who ?? "",
    repo: row.dataset.repo ?? "",
    isTarget: row === target,
  };
}

function filterRows(
  rows: readonly HTMLElement[],
  filters: ActiveFilters,
  inspect: (row: HTMLElement) => RowFilterInfo,
): HiddenMatches {
  let elsewhere = 0;
  let unseen = 0;
  for (const row of rows) {
    const outcome = classifyRow(inspect(row), filters);
    row.hidden = outcome !== "shown";
    if (outcome === "unseen") unseen++;
    else if (outcome === "elsewhere") elsewhere++;
    narrowOptionRows(row, filters.term);
  }
  return { elsewhere, unseen };
}

function updateGroups(doc: Document, filters: ActiveFilters): void {
  for (const group of doc.querySelectorAll<HTMLDetailsElement>("[data-group]")) {
    const count = group.querySelectorAll("[data-row]:not([hidden])").length;
    // The selected person's own rows stand under "Needs you", not again under "Waiting on others".
    group.hidden = !count || (filters.person !== null && group.dataset.whoGroup === filters.person);
    const countEl = group.querySelector<HTMLElement>(":scope > summary [data-count]");
    if (countEl) countEl.textContent = String(count);
    const updatedEl = group.querySelector<HTMLElement>(":scope > summary [data-updated-count]");
    if (updatedEl) {
      const changed = group.querySelectorAll(
        "[data-row]:not([hidden]) [data-updated]:not([hidden])",
      );
      updatedEl.hidden = !changed.length;
      updatedEl.textContent = `· ${changed.length} updated`;
    }
    if (filters.term && count) group.open = true;
  }
}

function updateSections(doc: Document, filterAnchor: Element | null): void {
  // A section left without a row to show steps aside, but the one holding the filters.
  for (const section of doc.querySelectorAll<HTMLElement>("main section"))
    if (section.querySelector("[data-row]") && !section.contains(filterAnchor))
      section.hidden = ![...section.querySelectorAll<HTMLElement>("[data-row]")].some(
        (row) => !row.hidden && !row.closest<HTMLElement>("[data-group]")?.hidden,
      );
}

function openDefaultFold(scope: Element): void {
  const groups = [...scope.querySelectorAll<HTMLDetailsElement>("details[data-group]")].filter(
    isElementShown,
  );
  const ask = groups.find((group) =>
    group.querySelector("[data-row][data-status=open]:not([hidden]):not([data-kind=work])"),
  );
  if (ask) ask.open = true;
  if (groups.length && !groups.some((group) => group.open)) groups[0]!.open = true;
}

function updatePersonButtons(
  buttons: readonly HTMLElement[],
  openRows: readonly HTMLElement[],
  matches: (row: HTMLElement, person: string | null) => boolean,
): void {
  for (const button of buttons) {
    const who = button.dataset.whoButton ?? "all";
    const person = who === "all" ? null : who;
    button.querySelector("[data-who-count]")!.textContent = String(
      openRows.filter((row) => matches(row, person)).length,
    );
  }
}

function updateKindButtons(
  kinds: readonly HTMLElement[],
  openMineRows: readonly HTMLElement[],
  activeKind: string,
): void {
  for (const button of kinds) {
    const kindKey = button.dataset.kindButton ?? "all";
    const count = openMineRows.filter(
      (row) => kindKey === "all" || row.dataset.kind === kindKey,
    ).length;
    button.setAttribute("aria-pressed", String(kindKey === activeKind));
    button.querySelector("[data-kind-count]")!.textContent = String(count);
    button.hidden = !count && kindKey !== "all" && kindKey !== activeKind;
  }
}

function updateAssumedCount(doc: Document, count: number): void {
  const veto = doc.querySelector<HTMLElement>("[data-assumed]");
  if (!veto) return;
  veto.hidden = !count;
  veto.querySelector("[data-assumed-count]")!.textContent = assumptionsText(count);
}

function updateChangedSince(
  doc: Document,
  updatedSince: number,
  isAway: (row: HTMLElement) => boolean,
): void {
  // The page's changed items, but those a hidden repository holds.
  const since = doc.getElementById("admin-since");
  if (!since) return;
  const marked = new Set(
    [...doc.querySelectorAll("[data-updated]:not([hidden])")]
      .map((el) => el.closest<HTMLElement>("[data-k]")!)
      .filter((row) => !row.hasAttribute("data-report") && !isAway(row))
      .map((row) => row.dataset.k),
  ).size;
  since.hidden = !marked;
  since.textContent = changedSinceText(marked, updatedSince);
}

function renderNoHit(doc: Document, sentence: string): void {
  const none = doc.getElementById("admin-nohit");
  if (!none) return;
  none.hidden = !sentence;
  none.textContent = sentence;
}

export class FiltersController {
  readonly #store: AdminStore;
  readonly #doc: Document;
  readonly #updatedSince: number;
  readonly #search: HTMLInputElement | null;
  readonly #buttons: HTMLElement[];
  readonly #kinds: HTMLElement[];
  readonly #repos: HiddenRepos;
  readonly #textOf: (row: HTMLElement) => string;
  readonly #scope: Element | null;
  #who: string;
  #kind = "all";
  #target: HTMLElement | null;
  #arrived = false;

  constructor(store: AdminStore, doc: Document, updatedSince: number) {
    this.#store = store;
    this.#doc = doc;
    this.#updatedSince = updatedSince;
    this.#search = doc.getElementById("admin-search") as HTMLInputElement | null;
    // Only a page with the person buttons filters by person: elsewhere a stored choice would hide
    // rows unseen. The filter starts on the first person, the hub's user where they answer a question.
    this.#buttons = [...doc.querySelectorAll<HTMLElement>("[data-who-button]")];
    this.#kinds = [...doc.querySelectorAll<HTMLElement>("[data-kind-button]")];
    this.#repos = new HiddenRepos(store, doc);
    this.#textOf = createRowTextCache();
    this.#scope = this.#buttons[0]?.closest("section, main") ?? null;
    this.#who = this.#initialWho();
    // A link to an item opens it and shows it whatever person the filter is on.
    this.#target = doc.getElementById(decodeHash(location.hash));
    if (this.#target?.dataset.who && this.#buttons.length) this.#who = this.#whoFor(this.#target);
    this.#bindEvents();
  }

  #initialWho(): string {
    const stored = this.#store.getText("who");
    if (stored && this.#buttons.some((b) => b.dataset.whoButton === stored)) return stored;
    return this.#buttons[0]?.dataset.whoButton ?? "all";
  }

  #whoFor(el: HTMLElement): string {
    return this.#buttons.some((b) => b.dataset.whoButton === el.dataset.who)
      ? (el.dataset.who ?? "all")
      : "all";
  }

  #activeFilters(): ActiveFilters {
    return {
      person: this.#buttons.length > 0 && this.#who !== "all" ? this.#who : null,
      kind: this.#kind,
      term: (this.#search?.value ?? "").trim().toLowerCase(),
      hiddenRepos: this.#repos.hidden,
    };
  }

  #bindEvents(): void {
    for (const button of this.#buttons)
      button.addEventListener("click", () => {
        this.#who = button.dataset.whoButton ?? "all";
        // storage blocked: the filter still applies on this page
        this.#store.setText("who", this.#who);
        this.apply(true);
      });
    for (const button of this.#kinds)
      button.addEventListener("click", () => {
        this.#kind = button.dataset.kindButton ?? "all";
        this.apply(true);
      });
    this.#repos.bind(() => this.apply(true));
    this.#search?.addEventListener("input", () => this.apply());
    addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if (
        keyEvent.key === "/" &&
        this.#doc.activeElement?.tagName !== "INPUT" &&
        !keyEvent.metaKey
      ) {
        if (this.#doc.activeElement?.tagName === "TEXTAREA") return;
        keyEvent.preventDefault();
        this.#search?.focus();
      }
    });
  }

  reloadRepos(): void {
    this.#repos.reload();
  }

  focusTarget(target: HTMLElement | null): void {
    this.#target = target;
    // A link followed on the page shows its row whatever the filters hid, and a row it named before
    // hides again where its repository is hidden.
    if (this.#target?.closest("[hidden]")) {
      if (this.#target.dataset.who && this.#buttons.length) this.#who = this.#whoFor(this.#target);
      this.#kind = "all";
      if (this.#search) this.#search.value = "";
    }
  }

  apply(picked = false): void {
    const filters = this.#activeFilters();
    const rows = [...this.#doc.querySelectorAll<HTMLElement>("[data-row]")];
    const inspect = (row: HTMLElement): RowFilterInfo => ({
      ...rowIdentityOf(row, this.#target),
      kind: row.dataset.kind ?? "",
      text: filters.term ? this.#textOf(row) : "",
    });
    const matches = (row: HTMLElement, person: string | null) =>
      matchesPerson(rowIdentityOf(row, this.#target), person, filters.hiddenRepos);
    const mine = (row: HTMLElement) => matches(row, filters.person);
    const misses = filterRows(rows, filters, inspect);
    updateGroups(this.#doc, filters);
    updateSections(this.#doc, this.#buttons[0] ?? null);
    if ((picked || !this.#arrived) && this.#scope) openDefaultFold(this.#scope);
    this.#arrived = true;
    for (const button of this.#buttons)
      button.setAttribute("aria-pressed", String(button.dataset.whoButton === this.#who));
    const openRows = [...this.#doc.querySelectorAll<HTMLElement>("details.item[data-status=open]")];
    updatePersonButtons(this.#buttons, openRows, matches);
    updateKindButtons(this.#kinds, openRows.filter(mine), filters.kind);
    const assumed = [...this.#doc.querySelectorAll<HTMLElement>("[data-row][data-status=assumed]")];
    updateAssumedCount(this.#doc, assumed.filter(mine).length);
    updateChangedSince(
      this.#doc,
      this.#updatedSince,
      (row) => filters.hiddenRepos.has(row.dataset.repo ?? "") && row !== this.#target,
    );
    const empty = Boolean(filters.term) && !rows.some((row) => !row.hidden && isElementShown(row));
    renderNoHit(this.#doc, empty ? noMatchSentence(filters.term, filters.person, misses) : "");
  }

  onStorage(key: string | null): void {
    if (key === null || key === this.#store.prefix + "repos") {
      this.#repos.reload();
      this.apply();
    }
  }
}

export function setupFilters(
  store: AdminStore,
  doc: Document,
  updatedSince: number,
): FiltersController {
  return new FiltersController(store, doc, updatedSince);
}
