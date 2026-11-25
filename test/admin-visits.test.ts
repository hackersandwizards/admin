import { describe, expect, test } from "vitest";
import { MemoryStorage, createStore, type StorageLike } from "../site/src/storage.ts";
import {
  isGoneItem,
  isStaleComment,
  pruneVersions,
  rolloverDeferredAnswers,
  rowChangeNotice,
  wasCopied,
  type RowVersion,
} from "../site/src/visits.ts";

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

  test("stops and returns false when a write hits QuotaExceededError", () => {
    const mem = new MemoryStorage();
    mem.setItem(
      "admin-answers:alpha:noted",
      JSON.stringify({ later: true, note: "check", at: "2026-01-01T08:00:00.000Z" }),
    );
    mem.setItem(
      "admin-answers:alpha:bare",
      JSON.stringify({ later: true, note: "", at: "2026-01-01T08:00:00.000Z" }),
    );
    const full: StorageLike = {
      get length() {
        return mem.length;
      },
      getItem: (k) => mem.getItem(k),
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: (k) => mem.removeItem(k),
      key: (i) => mem.key(i),
    };
    const store = createStore(full, "admin-answers:");
    expect(rolloverDeferredAnswers(store, Date.UTC(2026, 0, 2, 10, 0))).toBe(false);
    expect(mem.getItem("admin-answers:alpha:bare")).not.toBeNull();
  });
});
