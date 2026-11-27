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

export interface KeyedRowVersion extends RowVersion {
  readonly key: string;
}

export interface RowChangeResult {
  readonly changed: boolean;
  readonly text: string | null;
}

export interface PageInventory {
  readonly live: ReadonlySet<string>;
  readonly liveRepos: ReadonlySet<string>;
  readonly reportVersions: ReadonlyMap<string, string>;
  readonly reportRepo?: string;
}

export interface VisitPageSnapshot {
  readonly live: ReadonlySet<string>;
  readonly liveRepos: ReadonlySet<string>;
  readonly rows: readonly KeyedRowVersion[];
}

export interface VisitOutcome {
  readonly updatedSince: number;
  readonly changes: RowChangeResult[];
}

function repoFromVisitKey(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

export function isGoneItem(
  id: string,
  live: ReadonlySet<string>,
  liveRepos: ReadonlySet<string>,
): boolean {
  return !id.includes("#") && liveRepos.has(repoFromVisitKey(id)) && !live.has(id);
}

export function isStaleComment(
  answer: StoredAnswer | null,
  reportVersions: ReadonlyMap<string, string>,
): boolean {
  if (!answer?.report) return false;
  return reportVersions.has(answer.report) && reportVersions.get(answer.report) !== answer.version;
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
    const gone = !key.startsWith("#") && liveRepos.has(repoFromVisitKey(key)) && !live.has(key);
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

export function pruneStoredAnswers(store: AdminStore, inventory: PageInventory): void {
  const { live, liveRepos, reportVersions, reportRepo } = inventory;
  const copied = store.copiedAt();
  for (const id of store.answerIds()) {
    const answer = store.readJson(id) as StoredAnswer | null;
    const heading = id.indexOf("#");
    const goneReport =
      heading >= 0 &&
      reportRepo === repoFromVisitKey(id) &&
      !reportVersions.has(`#${id.slice(0, heading)}`);
    const gone = isGoneItem(id, live, liveRepos);
    const edited = isStaleComment(answer, reportVersions);
    if ((gone || goneReport || edited) && wasCopied(answer, copied)) store.remove(id);
  }
}

function startVisit(
  store: AdminStore,
  before: Record<string, unknown>,
  { seen, now }: { seen: number; now: number },
): boolean {
  return (
    store.setText("visit", String(seen)) &&
    store.writeJson("before", before) &&
    store.remove("who") &&
    rolloverDeferredAnswers(store, now)
  );
}

// If visit history is unreadable or the visit cannot advance, skip change markers to avoid
// comparing against a stale snapshot.
export function recordVisit(
  store: AdminStore,
  page: VisitPageSnapshot,
  now = Date.now(),
): VisitOutcome {
  const empty: VisitOutcome = { updatedSince: 0, changes: [] };
  const versions = store.readRecord("versions");
  if (!versions) return empty;
  const seen = Number(store.getText("seen")) || 0;
  const rollover = now - seen > VISIT_GAP_MS;
  const before = rollover ? { ...versions } : store.readRecord("before");
  if (!before) return empty;
  if (rollover && !startVisit(store, before, { seen, now })) return empty;
  if (!store.setText("seen", String(now))) return empty;
  const since = Number(store.getText("visit")) || 0;
  let updatedSince = 0;
  const changes = page.rows.map((row) => {
    const raw = before[row.key];
    const previous = typeof raw === "string" ? raw : "";
    const result = rowChangeNotice(row, previous, since);
    if (result.changed) updatedSince = since;
    versions[row.key] = `${row.version} ${row.asked}`;
    return result;
  });
  store.writeJson("versions", pruneVersions(versions, page.live, page.liveRepos));
  return { updatedSince, changes };
}

function liveInventory(doc: Document): PageInventory {
  const live = new Set(doc.body.dataset.answers?.split(" ").filter(Boolean));
  const liveRepos = new Set([...live].map(repoFromVisitKey));
  const reportVersions = new Map(
    [...doc.querySelectorAll<HTMLElement>("[data-report][data-version]")].map((el) => [
      el.dataset.k ?? "",
      el.dataset.version ?? "",
    ]),
  );
  const reportRepo = doc.querySelector<HTMLElement>("[data-report-repo]")?.dataset.reportRepo;
  return { live, liveRepos, reportVersions, reportRepo };
}

export function pruneAnswers(store: AdminStore, doc: Document): void {
  pruneStoredAnswers(store, liveInventory(doc));
}

function rowVersionOf(el: HTMLElement, report: HTMLElement | null): KeyedRowVersion {
  const kind: RowVersion["kind"] = !el.hasAttribute("data-report")
    ? "item"
    : el === report
      ? "article-report"
      : "listed-report";
  return {
    key: el.dataset.k ?? "",
    version: el.dataset.version ?? "",
    asked: el.dataset.asked ?? "",
    changed: Number(el.dataset.changed),
    kind,
  };
}

function applyRowChange(el: HTMLElement, result: RowChangeResult): void {
  if (!result.changed) return;
  const markEl = el.querySelector<HTMLElement>("[data-updated]");
  if (markEl) {
    markEl.hidden = false;
    if (result.text !== null) markEl.textContent = result.text;
  }
}

export function trackVisit(store: AdminStore, doc: Document, now = Date.now()): number {
  const { live, liveRepos } = liveInventory(doc);
  const report = doc.querySelector<HTMLElement>("article [data-report]");
  const elements = [...doc.querySelectorAll<HTMLElement>("[data-k][data-version]")];
  const rows = elements.map((el) => rowVersionOf(el, report));
  const outcome = recordVisit(store, { live, liveRepos, rows }, now);
  outcome.changes.forEach((result, index) => {
    const element = elements[index];
    if (element === undefined) throw new Error(`visit row missing: index ${index}`);
    applyRowChange(element, result);
  });
  return outcome.updatedSince;
}
