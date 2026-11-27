import { describe, expect, test } from "vitest";
import { defined } from "@hackersandwizards/scaffolding/defined";
import { Window } from "happy-dom";
import { MemoryStorage, createStore } from "../site/src/storage.ts";
import {
  isGoneItem,
  isStaleComment,
  pruneAnswers,
  pruneStoredAnswers,
  pruneVersions,
  recordVisit,
  rolloverDeferredAnswers,
  rowChangeNotice,
  wasCopied,
  type KeyedRowVersion,
  type RowVersion,
} from "../site/src/visits.ts";

class FailingWriteStorage extends MemoryStorage {
  readonly attempted: string[] = [];
  readonly #onWrite: Record<string, () => void>;

  constructor(initial: Record<string, string>, onWrite: Record<string, () => void>) {
    super();
    for (const [key, value] of Object.entries(initial)) super.setItem(key, value);
    this.#onWrite = onWrite;
  }

  override setItem(key: string): void {
    this.attempted.push(key);
    defined(this.#onWrite[key], `storage write handler for ${key}`)();
  }
}

describe("answer pruning predicates", () => {
  const live = new Set(["alpha:item-1"]);
  const liveRepos = new Set(["alpha"]);

  test.each([
    { label: "item missing from a live repo", id: "alpha:item-2", expected: true },
    { label: "item still live", id: "alpha:item-1", expected: false },
    { label: "heading comment in live repo", id: "alpha:report#sec", expected: false },
    { label: "item from another repo", id: "beta:item-2", expected: false },
  ])("isGoneItem returns $expected for $label", ({ id, expected }) => {
    expect(isGoneItem(id, live, liveRepos)).toBe(expected);
  });

  const reports = new Map([["#alpha:report", "v2"]]);

  test.each([
    {
      label: "comment with older report version",
      answer: { report: "#alpha:report", version: "v1", at: "2026-01-01T10:00:00.000Z" },
      expected: true,
    },
    {
      label: "comment matching current report version",
      answer: { report: "#alpha:report", version: "v2", at: "2026-01-01T10:00:00.000Z" },
      expected: false,
    },
    {
      label: "comment whose report is not on this page",
      answer: { report: "#beta:report", version: "v1", at: "2026-01-01T10:00:00.000Z" },
      expected: false,
    },
    {
      label: "regular item answer",
      answer: { done: true, at: "2026-01-01T10:00:00.000Z" },
      expected: false,
    },
    { label: "null answer", answer: null, expected: false },
  ])("isStaleComment returns $expected for $label", ({ answer, expected }) => {
    expect(isStaleComment(answer, reports)).toBe(expected);
  });

  test.each([
    { label: "null answer", answer: null, expected: true },
    { label: "answer without timestamp", answer: { at: "" }, expected: true },
    {
      label: "answer saved at copy time",
      answer: { at: "2026-01-01T12:00:00.000Z" },
      expected: true,
    },
    {
      label: "answer saved after copy time",
      answer: { at: "2026-01-01T13:00:00.000Z" },
      expected: false,
    },
  ])("wasCopied returns $expected for $label", ({ answer, expected }) => {
    expect(wasCopied(answer, "2026-01-01T12:00:00.000Z")).toBe(expected);
  });

  test("pruneVersions drops gone items in live repos while keeping reports, other repos, and non-string values", () => {
    const kept = pruneVersions(
      {
        "alpha:item-1": "v1 a1",
        "alpha:gone": "v1 a1",
        "#alpha:report": "r1 ",
        "beta:gone": 42,
      },
      live,
      liveRepos,
    );
    expect(kept).toEqual({
      "alpha:item-1": "v1 a1",
      "#alpha:report": "r1 ",
      "beta:gone": 42,
    });
  });

  test("pruneStoredAnswers removes copied gone items and copied stale comments while keeping uncopied or live ones", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    store.setText("copied", "2026-01-01T12:00:00.000Z");
    store.writeJson("alpha:gone-copied", { done: true, at: "2026-01-01T10:00:00.000Z" });
    store.writeJson("alpha:gone-fresh", { done: true, at: "2026-01-01T13:00:00.000Z" });
    store.writeJson("alpha:item-1", { done: true, at: "2026-01-01T10:00:00.000Z" });
    store.writeJson("alpha:r#old", {
      report: "#alpha:report",
      version: "v1",
      at: "2026-01-01T10:00:00.000Z",
    });
    store.writeJson("alpha:r#fresh", {
      report: "#alpha:report",
      version: "v1",
      at: "2026-01-01T13:00:00.000Z",
    });

    pruneStoredAnswers(store, { live, liveRepos, reportVersions: reports });

    expect(store.answerIds().sort()).toEqual(["alpha:gone-fresh", "alpha:item-1", "alpha:r#fresh"]);
  });

  test("pruneAnswers removes copied comments on deleted reports only from a full report list", async () => {
    const window = new Window();
    const document = window.document as unknown as Document;
    try {
      const store = createStore(new MemoryStorage(), "admin-answers:");
      const copied = "2026-01-01T12:00:00.000Z";
      store.setText("copied", copied);
      store.writeJson("alpha:gone#old", { note: "Old note", at: copied });
      store.writeJson("alpha:gone#fresh", { note: "New note", at: "2026-01-01T13:00:00.000Z" });
      store.writeJson("beta:gone#old", { note: "Other note", at: copied });
      store.writeJson("alpha:live#old", { note: "Live note", at: copied });
      document.body.innerHTML =
        '<table><tbody><tr data-report data-k="#alpha:live" data-version="v1"></tr></tbody></table>';

      pruneAnswers(store, document);
      expect(store.answerIds().sort()).toEqual([
        "alpha:gone#fresh",
        "alpha:gone#old",
        "alpha:live#old",
        "beta:gone#old",
      ]);

      const table = defined(document.querySelector("table"), "report table");
      table.setAttribute("data-report-repo", "alpha");
      pruneAnswers(store, document);
      expect(store.answerIds().sort()).toEqual([
        "alpha:gone#fresh",
        "alpha:live#old",
        "beta:gone#old",
      ]);

      table.replaceChildren();
      pruneAnswers(store, document);
      expect(store.answerIds().sort()).toEqual(["alpha:gone#fresh", "beta:gone#old"]);
    } finally {
      await window.happyDOM.close();
    }
  });
});

describe("rowChangeNotice", () => {
  const itemRow: RowVersion = { version: "v2", asked: "q2", changed: 200, kind: "item" };
  const articleReport: RowVersion = {
    version: "v2",
    asked: "",
    changed: 200,
    kind: "article-report",
  };
  const listedReport: RowVersion = {
    version: "v2",
    asked: "",
    changed: 200,
    kind: "listed-report",
  };

  test.each([
    {
      label: "first visit with since=0",
      row: itemRow,
      previous: "v1 q1",
      since: 0,
      expected: { changed: false, text: null },
    },
    {
      label: "unchanged file hash",
      row: itemRow,
      previous: "v2 q1",
      since: 100_000,
      expected: { changed: false, text: null },
    },
    {
      label: "item changed in question or options",
      row: itemRow,
      previous: "v1 q1",
      since: 100_000,
      expected: { changed: true, text: "question or options changed ·" },
    },
    {
      label: "item edited without question change",
      row: itemRow,
      previous: "v1 q2",
      since: 100_000,
      expected: { changed: true, text: "edited ·" },
    },
    {
      label: "item with legacy hash-only entry",
      row: itemRow,
      previous: "v1",
      since: 100_000,
      expected: { changed: true, text: "edited ·" },
    },
    {
      label: "unseen item newer than last visit keeps server mark text",
      row: itemRow,
      previous: "",
      since: 100_000,
      expected: { changed: true, text: null },
    },
    {
      label: "unseen item older than last visit stays unmarked",
      row: itemRow,
      previous: "",
      since: 300_000,
      expected: { changed: false, text: null },
    },
    {
      label: "article report changed",
      row: articleReport,
      previous: "v1 ",
      since: 100_000,
      expected: { changed: true, text: "Changed since your last visit ·" },
    },
    {
      label: "listed report changed",
      row: listedReport,
      previous: "v1 ",
      since: 100_000,
      expected: { changed: true, text: "Changed since your last visit" },
    },
  ])("$label", ({ row, previous, since, expected }) => {
    expect(rowChangeNotice(row, previous, since)).toEqual(expected);
  });
});

describe("rolloverDeferredAnswers", () => {
  test("drops bare later answers, converts noted later answers to active notes, and keeps others", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    const now = Date.UTC(2026, 0, 2, 10, 0);
    store.writeJson("alpha:bare", { later: true, note: "", at: "2026-01-01T08:00:00.000Z" });
    store.writeJson("alpha:noted", {
      later: true,
      note: "check vendor",
      at: "2026-01-01T08:00:00.000Z",
    });
    store.writeJson("alpha:answered", { done: true, at: "2026-01-01T08:00:00.000Z" });

    expect(rolloverDeferredAnswers(store, now)).toBe(true);
    expect(store.readJson("alpha:bare")).toBeNull();
    expect(store.readJson("alpha:noted")).toEqual({
      later: false,
      note: "check vendor",
      at: new Date(now).toISOString(),
    });
    expect(store.readJson("alpha:answered")).toEqual({
      done: true,
      at: "2026-01-01T08:00:00.000Z",
    });
  });

  test("stops and returns false when writing the deferred note hits QuotaExceededError", () => {
    const full = new FailingWriteStorage(
      {
        "admin-answers:alpha:noted": JSON.stringify({
          later: true,
          note: "check",
          at: "2026-01-01T08:00:00.000Z",
        }),
        "admin-answers:alpha:bare": JSON.stringify({
          later: true,
          note: "",
          at: "2026-01-01T08:00:00.000Z",
        }),
      },
      {
        "admin-answers:alpha:noted": () => {
          throw new DOMException("full", "QuotaExceededError");
        },
      },
    );
    const store = createStore(full, "admin-answers:");
    expect(rolloverDeferredAnswers(store, Date.UTC(2026, 0, 2, 10, 0))).toBe(false);
    expect(full.attempted).toEqual(["admin-answers:alpha:noted"]);
    expect(full.getItem("admin-answers:alpha:bare")).not.toBeNull();
  });
});

describe("recordVisit", () => {
  const live = new Set(["alpha:item-1"]);
  const liveRepos = new Set(["alpha"]);
  const sampleRow: KeyedRowVersion = {
    key: "alpha:item-1",
    version: "v2",
    asked: "q2",
    changed: 200,
    kind: "item",
  };

  test("first visit records seen and versions without marking rows", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    const now = Date.UTC(2026, 0, 2, 10, 0);

    const outcome = recordVisit(store, { live, liveRepos, rows: [sampleRow] }, now);

    expect(outcome).toEqual({ updatedSince: 0, changes: [{ changed: false, text: null }] });
    expect(store.getText("seen")).toBe(String(now));
    expect(store.readRecord("versions")).toEqual({ "alpha:item-1": "v2 q2" });
  });

  test("new visit rolls over history, prunes gone versions, and returns row change marks", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    const prev = Date.UTC(2026, 0, 2, 8, 0);
    const now = Date.UTC(2026, 0, 2, 10, 0);
    store.setText("seen", String(prev));
    store.setText("who", "Kim");
    store.writeJson("versions", { "alpha:item-1": "v1 q1", "alpha:gone": "v0 q0" });

    const outcome = recordVisit(store, { live, liveRepos, rows: [sampleRow] }, now);

    expect(outcome).toEqual({
      updatedSince: prev,
      changes: [{ changed: true, text: "question or options changed ·" }],
    });
    expect(store.getText("who")).toBeNull();
    expect(store.readRecord("versions")).toEqual({ "alpha:item-1": "v2 q2" });
  });

  test("stops before modifying before, who, or seen when saving visit hits QuotaExceededError", () => {
    const prev = Date.UTC(2026, 0, 2, 8, 0);
    const full = new FailingWriteStorage(
      {
        "admin-answers:seen": String(prev),
        "admin-answers:who": "Kim",
        "admin-answers:versions": JSON.stringify({ "alpha:item-1": "v1 q1" }),
      },
      {
        "admin-answers:visit": () => {
          throw new DOMException("full", "QuotaExceededError");
        },
      },
    );
    const store = createStore(full, "admin-answers:");

    const outcome = recordVisit(
      store,
      { live, liveRepos, rows: [sampleRow] },
      Date.UTC(2026, 0, 2, 10, 0),
    );

    expect(outcome).toEqual({ updatedSince: 0, changes: [] });
    expect(full.attempted).toEqual(["admin-answers:visit"]);
    expect(full.getItem("admin-answers:who")).toBe("Kim");
    expect(full.getItem("admin-answers:seen")).toBe(String(prev));
  });

  test("stops before marking rows when saving seen hits QuotaExceededError during same visit", () => {
    const prev = Date.UTC(2026, 0, 2, 9, 30);
    const full = new FailingWriteStorage(
      {
        "admin-answers:seen": String(prev),
        "admin-answers:visit": String(Date.UTC(2026, 0, 2, 7, 0)),
        "admin-answers:before": JSON.stringify({ "alpha:item-1": "v1 q1" }),
        "admin-answers:versions": JSON.stringify({ "alpha:item-1": "v1 q1" }),
      },
      {
        "admin-answers:seen": () => {
          throw new DOMException("full", "QuotaExceededError");
        },
      },
    );
    const store = createStore(full, "admin-answers:");

    const outcome = recordVisit(
      store,
      { live, liveRepos, rows: [sampleRow] },
      Date.UTC(2026, 0, 2, 10, 0),
    );

    expect(outcome).toEqual({ updatedSince: 0, changes: [] });
    expect(full.attempted).toEqual(["admin-answers:seen"]);
    expect(full.getItem("admin-answers:versions")).toBe(
      JSON.stringify({ "alpha:item-1": "v1 q1" }),
    );
  });

  test("keeps corrupt history untouched during a visit and repairs it after the gap", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    const prev = Date.UTC(2026, 0, 2, 9, 30);
    store.setText("seen", String(prev));
    store.setText("visit", String(Date.UTC(2026, 0, 2, 7, 0)));
    store.setText("before", "{broken");
    store.writeJson("versions", { "alpha:item-1": "v1 q1" });

    const outcome = recordVisit(
      store,
      { live, liveRepos, rows: [sampleRow] },
      Date.UTC(2026, 0, 2, 10, 0),
    );

    expect(outcome).toEqual({ updatedSince: 0, changes: [] });
    expect({
      versions: store.readRecord("versions"),
      before: store.getText("before"),
      seen: store.getText("seen"),
      visit: store.getText("visit"),
    }).toEqual({
      versions: { "alpha:item-1": "v1 q1" },
      before: "{broken",
      seen: String(prev),
      visit: String(Date.UTC(2026, 0, 2, 7, 0)),
    });

    const next = Date.UTC(2026, 0, 2, 10, 45);
    expect(recordVisit(store, { live, liveRepos, rows: [sampleRow] }, next)).toEqual({
      updatedSince: prev,
      changes: [{ changed: true, text: "question or options changed ·" }],
    });
    expect(store.readRecord("before")).toEqual({ "alpha:item-1": "v1 q1" });
    expect(store.getText("seen")).toBe(String(next));
  });
});
