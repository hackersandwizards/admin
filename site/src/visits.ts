import type { StoredAnswer } from "./answer-rules.ts";
import type { AdminStore } from "./storage.ts";

// A visit is a run of page views under an hour apart: an item whose file changed since the one
// before says so on its row, and what changed: its question or options, or the rest of its file.
// A row this browser showed then compares the file's text, since a change fetched later carries
// its older commit time; any other row compares that time. A new visit starts the person filter
// on the hub's user again.
const VISIT_GAP_MS = 36e5;

const ITEM_CHANGE_MARKS = {
  asked: "question or options changed",
  edited: "edited",
} as const;

const REPORT_CHANGE_MARKS = {
  "article-report": "Changed since your last visit ·",
  "listed-report": "Changed since your last visit",
} as const;

export interface RowVersion {
  readonly version: string;
  readonly asked: string;
  readonly changed: number;
  readonly kind: "article-report" | "listed-report" | "item";
}

export interface RowChangeResult {
  readonly changed: boolean;
  readonly text: string | null;
}

export function isGoneItem(
  id: string,
  live: ReadonlySet<string>,
  liveRepos: ReadonlySet<string>,
): boolean {
  return !id.includes("#") && liveRepos.has(id.split(":")[0]!) && !live.has(id);
}

export function isStaleComment(
  answer: StoredAnswer | null,
  reportVersions: ReadonlyMap<string, string>,
): boolean {
  return (
    Boolean(answer?.report) &&
    reportVersions.has(answer!.report!) &&
    reportVersions.get(answer!.report!) !== answer!.version
  );
}

export function wasCopied(answer: StoredAnswer | null, copiedAt: string): boolean {
  return !answer || !answer.at || answer.at <= copiedAt;
}

export function pruneVersions(
  versions: Record<string, unknown>,
  live: ReadonlySet<string>,
  liveRepos: ReadonlySet<string>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(versions)) {
    const gone = !key.startsWith("#") && liveRepos.has(key.split(":")[0]!) && !live.has(key);
    if (!gone) kept[key] = value;
  }
  return kept;
}

export function rowChangeNotice(row: RowVersion, previous: string, since: number): RowChangeResult {
  if (!since) return { changed: false, text: null };
  // A version stored before v1.24.0 holds the file's hash alone.
  const [file = "", asked = ""] = previous.split(" ");
  const changed = file ? file !== row.version : row.changed * 1000 > since;
  if (!changed) return { changed: false, text: null };
  if (row.kind !== "item") return { changed: true, text: REPORT_CHANGE_MARKS[row.kind] };
  if (!file) return { changed: true, text: null };
  const reason = asked && asked !== row.asked ? "asked" : "edited";
  return { changed: true, text: `${ITEM_CHANGE_MARKS[reason]} ·` };
}

export function rolloverDeferredAnswers(store: AdminStore, now: number): boolean {
  // A question put off is asked again: its row keeps only a note written beside it.
  for (const id of store.answerIds()) {
    const answer = store.readJson(id) as StoredAnswer | null;
    if (!answer?.later) continue;
    const ok = answer.note
      ? store.writeJson(id, { ...answer, later: false, at: new Date(now).toISOString() })
      : store.remove(id);
    if (!ok) return false;
  }
  return true;
}

function liveInventory(doc: Document): {
  live: Set<string>;
  liveRepos: Set<string>;
  reportVersions: Map<string, string>;
} {
  // A page that names every item of its repositories knows which answers lost their item.
  const live = new Set(doc.body.dataset.answers?.split(" ").filter(Boolean));
  const liveRepos = new Set([...live].map((k) => k.split(":")[0]!));
  const reportVersions = new Map(
    [...doc.querySelectorAll<HTMLElement>("[data-report][data-version]")].map((el) => [
      el.dataset.k ?? "",
      el.dataset.version ?? "",
    ]),
  );
  return { live, liveRepos, reportVersions };
}

export function pruneAnswers(store: AdminStore, doc: Document): void {
  const { live, liveRepos, reportVersions } = liveInventory(doc);
  const copied = store.copiedAt();
  for (const id of store.answerIds()) {
    const answer = store.readJson(id) as StoredAnswer | null;
    const gone = isGoneItem(id, live, liveRepos);
    const edited = isStaleComment(answer, reportVersions);
    if ((gone || edited) && wasCopied(answer, copied)) store.remove(id);
  }
}

function rowVersionOf(el: HTMLElement, report: HTMLElement | null): RowVersion {
  const kind: RowVersion["kind"] = !el.hasAttribute("data-report")
    ? "item"
    : el === report
      ? "article-report"
      : "listed-report";
  return {
    version: el.dataset.version ?? "",
    asked: el.dataset.asked ?? "",
    changed: Number(el.dataset.changed),
    kind,
  };
}

function applyRowChange(el: HTMLElement, result: RowChangeResult): boolean {
  if (!result.changed) return false;
  const markEl = el.querySelector<HTMLElement>("[data-updated]");
  if (markEl) {
    markEl.hidden = false;
    if (result.text !== null) markEl.textContent = result.text;
  }
  return true;
}

function advanceVisit(
  store: AdminStore,
  versions: Record<string, unknown>,
  now: number,
): number | null {
  const seen = Number(store.getText("seen")) || 0;
  if (now - seen > VISIT_GAP_MS) {
    if (!store.setText("visit", String(seen))) return null;
    if (!store.writeJson("before", versions)) return null;
    if (!store.remove("who")) return null;
    if (!rolloverDeferredAnswers(store, now)) return null;
  }
  if (!store.setText("seen", String(now))) return null;
  return Number(store.getText("visit")) || 0;
}

// storage blocked: no row says what changed. Corrupt visit history or a failed storage write stops
// visit bookkeeping before overwriting stored history or marking rows against a stale snapshot.
export function trackVisit(store: AdminStore, doc: Document, now = Date.now()): number {
  const versions = store.readRecord("versions");
  if (!versions) return 0;
  const since = advanceVisit(store, versions, now);
  if (since === null) return 0;
  const before = store.readRecord("before");
  if (!before) return 0;
  const { live, liveRepos } = liveInventory(doc);
  const report = doc.querySelector<HTMLElement>("article [data-report]");
  let updatedSince = 0;
  for (const el of doc.querySelectorAll<HTMLElement>("[data-k][data-version]")) {
    const key = el.dataset.k ?? "";
    const row = rowVersionOf(el, report);
    const previous = typeof before[key] === "string" ? before[key] : "";
    if (applyRowChange(el, rowChangeNotice(row, previous, since))) updatedSince = since;
    versions[key] = `${row.version} ${row.asked}`;
  }
  store.writeJson("versions", pruneVersions(versions, live, liveRepos));
  return updatedSince;
}
