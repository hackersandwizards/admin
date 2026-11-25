import {
  buildAnswer,
  describeCopyButton,
  formatAnswerChoice,
  formatCopyBlock,
  formatCopyLine,
  isAnswerCopied,
  isControlChecked,
  isStaleAnswer,
  rowMarkText,
  savedLineText,
  selectAnswersToCopy,
  staleCopyNote,
  staleNoticeText,
  type AnswerControl,
  type AnswerControlKind,
  type AnswerDraft,
  type QuestionSnapshot,
  type StoredAnswer,
} from "./answer-rules.ts";
import type { AdminStore } from "./storage.ts";

// The inputs an answer sets, beside read-only boxes an item's own text may hold. The done and later
// boxes go by attribute, since an option's value is its key, which may be either word.
const ANSWER_INPUTS = "input[data-option], input[data-stance], input[data-done], input[data-later]";

function optionLabelOf(row: HTMLElement | undefined, key: string): string | undefined {
  return row?.querySelector<HTMLInputElement>(`input[data-option][value="${CSS.escape(key)}"]`)
    ?.dataset.label;
}

function controlOf(input: HTMLInputElement): AnswerControl {
  const kind: AnswerControlKind =
    "option" in input.dataset
      ? "option"
      : "stance" in input.dataset
        ? "stance"
        : "done" in input.dataset
          ? "done"
          : "later";
  return { kind, value: input.value };
}

function readRowDraft(row: HTMLElement, report: HTMLElement | null): AnswerDraft {
  const options = [...row.querySelectorAll<HTMLInputElement>("input[data-option]:checked")].map(
    (input) => ({ key: input.value, label: optionLabelOf(row, input.value) }),
  );
  const done = Boolean(row.querySelector("input[data-done]:checked"));
  const later = Boolean(row.querySelector("input[data-later]:checked"));
  const stance = row.querySelector<HTMLInputElement>("input[data-stance]:checked")?.value ?? "";
  const note = row.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
  const commentReport =
    row.hasAttribute("data-comment") && report
      ? { key: report.dataset.k ?? "", version: report.dataset.version ?? "" }
      : undefined;
  return { options, done, later, stance, note, asked: row.dataset.asked, commentReport };
}

function uncheckLaterBox(row: HTMLElement): void {
  const laterBox = row.querySelector<HTMLInputElement>("input[data-later]");
  if (laterBox) laterBox.checked = false;
}

function clearConflictingChecks(row: HTMLElement, changed: HTMLInputElement): void {
  if (!changed.checked) return;
  const isLater = "later" in changed.dataset;
  for (const input of row.querySelectorAll<HTMLInputElement>(ANSWER_INPUTS))
    if (isLater !== "later" in input.dataset) input.checked = false;
}

export class AnswersController {
  readonly #store: AdminStore;
  readonly #doc: Document;
  readonly #items: HTMLElement[];
  readonly #answerRows: HTMLElement[];
  readonly #report: HTMLElement | null;
  readonly #copy: HTMLButtonElement | null;
  readonly #status: HTMLElement | null;
  readonly #idle: string;
  #pending = 0;
  #pressedAt = "";

  constructor(store: AdminStore, doc: Document) {
    this.#store = store;
    this.#doc = doc;
    this.#items = [...doc.querySelectorAll<HTMLElement>("details.item[data-k]")];
    const comments = [...doc.querySelectorAll<HTMLElement>("details[data-comment][data-k]")];
    this.#answerRows = [...this.#items, ...comments];
    this.#report = doc.querySelector<HTMLElement>("article [data-report]");
    this.#copy = doc.getElementById("copy") as HTMLButtonElement | null;
    this.#status = doc.getElementById("state");
    this.#idle = this.#status?.textContent?.trim() ?? "";
    for (const row of this.#answerRows) this.#bindRow(row);
    this.#bindCopy();
  }

  #readAnswer(key: string): StoredAnswer | null {
    return this.#store.readJson(key) as StoredAnswer | null;
  }

  #rowOf(key: string): HTMLElement | undefined {
    return this.#items.find((item) => item.dataset.k === key);
  }

  #snapshotOf(key: string, answer: StoredAnswer | null): QuestionSnapshot | null {
    const shown = this.#doc.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"][data-asked]`);
    if (!shown) return null;
    const row = this.#rowOf(key);
    const currentOptionLabel = answer?.option ? optionLabelOf(row, answer.option) : undefined;
    return { asked: shown.dataset.asked ?? "", hasRow: Boolean(row), currentOptionLabel };
  }

  #staleFor(key: string, answer: StoredAnswer | null): boolean {
    return isStaleAnswer(answer, this.#snapshotOf(key, answer));
  }

  #markRow(row: HTMLElement, answer: StoredAnswer | null): void {
    const stale = this.#staleFor(row.dataset.k ?? "", answer);
    const copiedAt = this.#store.copiedAt();
    const sent = isAnswerCopied(answer, stale, copiedAt);
    const currentLabel = answer?.option ? optionLabelOf(row, answer.option) : undefined;
    const markEl = row.querySelector<HTMLElement>(".mark");
    if (markEl) {
      markEl.textContent = rowMarkText(answer, stale, currentLabel) + (sent ? " · copied" : "");
      markEl.classList.toggle("text-error", stale);
    }
    const reset = row.querySelector<HTMLElement>(".clear");
    if (reset) reset.hidden = !answer;
    const saved = row.querySelector<HTMLElement>(".saved");
    if (saved) saved.textContent = savedLineText(answer, copiedAt, sent);
    const notice = row.querySelector<HTMLElement>("[data-stale]");
    if (notice) {
      notice.hidden = !stale;
      notice.textContent = staleNoticeText(answer, stale);
    }
  }

  #loadRow(row: HTMLElement): void {
    const answer = this.#readAnswer(row.dataset.k ?? "");
    const stale = this.#staleFor(row.dataset.k ?? "", answer);
    for (const input of row.querySelectorAll<HTMLInputElement>(ANSWER_INPUTS))
      input.checked = isControlChecked(controlOf(input), answer, stale);
    const textarea = row.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea) textarea.value = String(answer?.note || "");
    this.#markRow(row, answer);
  }

  #saveRow(row: HTMLElement): void {
    const answer = buildAnswer(readRowDraft(row, this.#report), new Date().toISOString());
    if (this.#store.writeJson(row.dataset.k ?? "", answer)) this.#markRow(row, answer);
    this.syncCopyState();
  }

  #answeredKeys(): string[] {
    const order = [
      ...new Set(
        [...this.#doc.querySelectorAll<HTMLElement>("[data-k]")].map((el) => el.dataset.k ?? ""),
      ),
    ];
    const indexOf = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
    return this.#store
      .answerIds()
      .filter((key) => {
        const answer = this.#readAnswer(key);
        return Boolean(answer) && !answer!.later;
      })
      .sort((a, b) => indexOf(a) - indexOf(b));
  }

  #copyLineFor(key: string): string {
    const answer = this.#readAnswer(key)!;
    const choice = formatAnswerChoice(answer, (optKey) => optionLabelOf(this.#rowOf(key), optKey));
    const line = formatCopyLine(key, answer, choice);
    return this.#staleFor(key, answer) ? line + staleCopyNote(answer) : line;
  }

  #bindRow(row: HTMLElement): void {
    this.#loadRow(row);
    // A question put off holds no answer, and an answer takes it up again.
    row.addEventListener("change", (event) => {
      clearConflictingChecks(row, event.target as HTMLInputElement);
      this.#saveRow(row);
    });
    row.querySelector("textarea")?.addEventListener("input", () => {
      uncheckLaterBox(row);
      this.#saveRow(row);
    });
    const pick = row.querySelector<HTMLElement>(".pick");
    pick?.addEventListener("click", () => {
      uncheckLaterBox(row);
      for (const value of (pick.dataset.v ?? "").split(" ")) {
        const box = row.querySelector<HTMLInputElement>(
          `input[data-option][value="${CSS.escape(value)}"]`,
        );
        if (box) box.checked = true;
      }
      this.#saveRow(row);
    });
    row.querySelector(".clear")?.addEventListener("click", () => {
      this.#store.writeJson(row.dataset.k ?? "", null);
      this.#loadRow(row);
      this.syncCopyState();
      // Reset hides itself: focus goes to the row's first answer shown rather than the page's top.
      [...row.querySelectorAll<HTMLElement>(`${ANSWER_INPUTS}, textarea`)]
        .find((el) => !el.closest("[hidden]"))
        ?.focus();
    });
  }

  #bindCopy(): void {
    // brand's button reads its text on the press and reports each press as hw-copy, detail { ok }, once
    // the write ends. The copy time is the first press since none was pending, which no copied text is
    // older than, so an answer saved during a write or a failed press stays not copied.
    this.#copy?.addEventListener("click", () => {
      if (!this.#pending++) this.#pressedAt = new Date().toISOString();
    });
    this.#copy?.addEventListener("hw-copy", (event) => {
      this.#pending = Math.max(0, this.#pending - 1);
      const detail = (event as CustomEvent<{ ok?: boolean }>).detail;
      if (!detail?.ok) return;
      // storage blocked: the copy still happened
      if (this.#pressedAt > this.#store.copiedAt()) this.#store.setText("copied", this.#pressedAt);
      for (const row of this.#answerRows) this.#markRow(row, this.#readAnswer(row.dataset.k ?? ""));
      this.syncCopyState(false);
    });
  }

  // brand's copy button (enhance(), data-hw-copy) copies the block and says on itself how it went:
  // a copy passes relabel false, so that label stays.
  syncCopyState(relabel = true): void {
    if (!this.#copy) return;
    const keys = this.#answeredKeys();
    const since = this.#store.copiedAt();
    const entries = keys.map((key) => {
      const answer = this.#readAnswer(key)!;
      return { key, at: answer.at, stale: this.#staleFor(key, answer) };
    });
    const selection = selectAnswersToCopy(entries, since);
    const view = describeCopyButton(selection, since, this.#idle);
    this.#copy.dataset.hwCopy = formatCopyBlock(
      selection.sendKeys.map((k) => this.#copyLineFor(k)),
    );
    this.#copy.disabled = view.disabled;
    if (relabel) this.#copy.textContent = view.label;
    // Once all is copied the button steps back, so it no longer reads as work left.
    if (view.secondary) this.#copy.dataset.variant = "secondary";
    else delete this.#copy.dataset.variant;
    if (this.#status) this.#status.textContent = view.statusText;
  }

  // Another tab's write reloads only what it changed, so a note being typed here keeps its text;
  // a copy there marks the rows copied. A null key is storage cleared.
  onStorage(key: string | null): void {
    for (const row of this.#answerRows)
      if (key === null || key === this.#store.prefix + (row.dataset.k ?? "")) this.#loadRow(row);
      else if (key === this.#store.prefix + "copied")
        this.#markRow(row, this.#readAnswer(row.dataset.k ?? ""));
    this.syncCopyState();
  }
}

export function setupAnswers(store: AdminStore, doc: Document): AnswersController {
  return new AnswersController(store, doc);
}
