import {
  assumptionsText,
  changedSinceText,
  classifyRow,
  countAssumedRows,
  countChangedItems,
  countOpenForPerson,
  countOpenOfKind,
  decodeHash,
  matchesPerson,
  noMatchSentence,
  type ActiveFilters,
  type ChangedRowInfo,
  type HiddenMatches,
  type PageRow,
} from "./filter-rules.ts";
import { HiddenRepos } from "./repos.ts";
import type { AdminStore } from "./storage.ts";

const STRIP_MARKS = "[data-updated], .mark, .saved, [data-stale], [data-repo-off]";

interface BoundRow {
  readonly element: HTMLElement;
  readonly info: PageRow;
}

function isElementShown(el: Element): boolean {
  return !el.closest("[hidden]");
}

function createRowTextCache(): (row: HTMLElement) => string {
  // What a row says, without the marks this script writes or shows on it.
  const said = new Map<HTMLElement, string>();
  return (row) => {
    const cached = said.get(row);
    if (cached !== undefined) return cached;
    const copy = row.cloneNode(true) as HTMLElement;
    for (const mark of copy.querySelectorAll(STRIP_MARKS)) mark.remove();
    const text = (copy.textContent ?? "").toLowerCase();
    said.set(row, text);
    return text;
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

function applyRowVisibility(rows: readonly BoundRow[], filters: ActiveFilters): HiddenMatches {
  let elsewhere = 0;
  let unseen = 0;
  for (const { element, info } of rows) {
    const outcome = classifyRow(info, filters);
    element.hidden = outcome !== "shown";
    if (outcome === "unseen") unseen++;
    else if (outcome === "elsewhere") elsewhere++;
    narrowOptionRows(element, filters.term);
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
  const [first] = groups;
  if (first && !groups.some((group) => group.open)) first.open = true;
}

function updatePersonButtons(
  buttons: readonly HTMLElement[],
  rows: readonly PageRow[],
  hiddenRepos: ReadonlySet<string>,
): void {
  for (const button of buttons) {
    const who = button.dataset.whoButton ?? "all";
    const person = who === "all" ? null : who;
    const count = button.querySelector("[data-who-count]");
    if (count === null) throw new Error(`person filter count missing: ${who}`);
    count.textContent = String(countOpenForPerson(rows, person, hiddenRepos));
  }
}

function updateKindButtons(
  kinds: readonly HTMLElement[],
  openMineRows: readonly PageRow[],
  activeKind: string,
): void {
  for (const button of kinds) {
    const kindKey = button.dataset.kindButton ?? "all";
    const count = countOpenOfKind(openMineRows, kindKey);
    button.setAttribute("aria-pressed", String(kindKey === activeKind));
    const countLabel = button.querySelector("[data-kind-count]");
    if (countLabel === null) throw new Error(`kind filter count missing: ${kindKey}`);
    countLabel.textContent = String(count);
    button.hidden = !count && kindKey !== "all" && kindKey !== activeKind;
  }
}

function updateAssumedCount(doc: Document, count: number): void {
  const veto = doc.querySelector<HTMLElement>("[data-assumed]");
  if (!veto) return;
  veto.hidden = !count;
  const countLabel = veto.querySelector("[data-assumed-count]");
  if (countLabel === null) throw new Error("assumed count missing: data-assumed-count");
  countLabel.textContent = assumptionsText(count);
}

function readChangedRows(doc: Document, target: HTMLElement | null): ChangedRowInfo[] {
  return [...doc.querySelectorAll("[data-updated]:not([hidden])")].map((el) => {
    const row = el.closest<HTMLElement>("[data-k]");
    if (row === null) throw new Error("updated row missing: data-updated outside data-k");
    return {
      key: row.dataset.k ?? "",
      repo: row.dataset.repo ?? "",
      isReport: row.hasAttribute("data-report"),
      isTarget: row === target,
    };
  });
}

function renderChangedSince(doc: Document, text: string): void {
  const since = doc.getElementById("admin-since");
  if (!since) return;
  since.hidden = !text;
  since.textContent = text;
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

  #readRows(term: string): BoundRow[] {
    return [...this.#doc.querySelectorAll<HTMLElement>("[data-row]")].map((element) => ({
      element,
      info: {
        who: element.dataset.who ?? "",
        kind: element.dataset.kind ?? "",
        repo: element.dataset.repo ?? "",
        status: element.dataset.status ?? "",
        isItem: element.matches("details.item"),
        isTarget: element === this.#target,
        text: term ? this.#textOf(element) : "",
      },
    }));
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
    const bound = this.#readRows(filters.term);
    const rows = bound.map((entry) => entry.info);
    const misses = applyRowVisibility(bound, filters);
    updateGroups(this.#doc, filters);
    updateSections(this.#doc, this.#buttons[0] ?? null);
    if ((picked || !this.#arrived) && this.#scope) openDefaultFold(this.#scope);
    this.#arrived = true;
    for (const button of this.#buttons)
      button.setAttribute("aria-pressed", String(button.dataset.whoButton === this.#who));
    updatePersonButtons(this.#buttons, rows, filters.hiddenRepos);
    const openMine = rows.filter(
      (row) =>
        row.isItem &&
        row.status === "open" &&
        matchesPerson(row, filters.person, filters.hiddenRepos),
    );
    updateKindButtons(this.#kinds, openMine, filters.kind);
    updateAssumedCount(this.#doc, countAssumedRows(rows, filters));
    const marked = countChangedItems(readChangedRows(this.#doc, this.#target), filters.hiddenRepos);
    renderChangedSince(this.#doc, changedSinceText(marked, this.#updatedSince));
    const empty =
      Boolean(filters.term) &&
      !bound.some((entry) => !entry.element.hidden && isElementShown(entry.element));
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
