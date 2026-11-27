import { describe, expect, test } from "vitest";
import {
  assumptionsText,
  changedSinceText,
  classifyRow,
  countAssumedRows,
  countChangedItems,
  countOpenForPerson,
  countOpenOfKind,
  decodeHash,
  describeHiddenRepos,
  goneItemNotice,
  hiddenRepoMatchesClause,
  isRowAway,
  loadHiddenRepos,
  matchesKind,
  matchesPerson,
  matchesSearch,
  noMatchSentence,
  otherPeopleMatchesClause,
  pluralCount,
  type ActiveFilters,
  type ChangedRowInfo,
  type PageRow,
  type RowFilterInfo,
} from "../site/src/filter-rules.ts";

describe("pluralCount and repository summaries", () => {
  test.each([
    { n: 0, one: "item", many: undefined, expected: "0 items" },
    { n: 1, one: "item", many: undefined, expected: "1 item" },
    { n: 2, one: "repository", many: "repositories", expected: "2 repositories" },
    { n: 1, one: "repository", many: "repositories", expected: "1 repository" },
  ])("pluralCount($n, $one)", ({ n, one, many, expected }) => {
    expect(pluralCount(n, one, many)).toBe(expected);
  });

  test.each([
    { label: "known array entries", stored: ["alpha", "unknown", 5], expected: ["alpha"] },
    { label: "single string entry", stored: "beta", expected: ["beta"] },
    { label: "null value", stored: null, expected: [] },
  ])("loadHiddenRepos filters $label", ({ stored, expected }) => {
    expect([...loadHiddenRepos(stored, ["alpha", "beta"])]).toEqual(expected);
  });

  test.each([
    {
      label: "none hidden",
      names: [],
      total: 3,
      expected: { summary: "", hideShowAll: true, hideHideAll: false, countText: "3" },
    },
    {
      label: "one hidden",
      names: ["Alpha"],
      total: 3,
      expected: {
        summary: "1 repository hidden: Alpha.",
        hideShowAll: false,
        hideHideAll: false,
        countText: "2 of 3",
      },
    },
    {
      label: "all hidden",
      names: ["Alpha", "Beta"],
      total: 2,
      expected: {
        summary: "2 repositories hidden: Alpha, Beta.",
        hideShowAll: false,
        hideHideAll: true,
        countText: "0 of 2",
      },
    },
  ])("describeHiddenRepos handles $label", ({ names, total, expected }) => {
    expect(describeHiddenRepos(names, total)).toEqual(expected);
  });
});

describe("row visibility classification", () => {
  const hiddenRepos = new Set(["alpha"]);

  test.each([
    {
      label: "row in hidden repo",
      row: { repo: "alpha", isTarget: false },
      expected: true,
    },
    {
      label: "target row in hidden repo stays visible",
      row: { repo: "alpha", isTarget: true },
      expected: false,
    },
    {
      label: "row in visible repo",
      row: { repo: "beta", isTarget: false },
      expected: false,
    },
  ])("isRowAway returns $expected for $label", ({ row, expected }) => {
    expect(isRowAway(row, hiddenRepos)).toBe(expected);
  });

  test.each([
    {
      label: "matching person in visible repo",
      row: { who: "Kim", repo: "beta", isTarget: false },
      person: "Kim",
      expected: true,
    },
    {
      label: "unowned row matches any person",
      row: { who: "", repo: "beta", isTarget: false },
      person: "Kim",
      expected: true,
    },
    {
      label: "other person does not match",
      row: { who: "Sam", repo: "beta", isTarget: false },
      person: "Kim",
      expected: false,
    },
    {
      label: "null person filter accepts any visible repo row",
      row: { who: "Sam", repo: "beta", isTarget: false },
      person: null,
      expected: true,
    },
    {
      label: "hidden repo row rejected even with null person filter",
      row: { who: "Kim", repo: "alpha", isTarget: false },
      person: null,
      expected: false,
    },
  ])("matchesPerson returns $expected for $label", ({ row, person, expected }) => {
    expect(matchesPerson(row, person, hiddenRepos)).toBe(expected);
  });

  test.each([
    { label: "empty term matches any text", text: "pick a variant", term: "", expected: true },
    { label: "matching substring", text: "pick a variant", term: "variant", expected: true },
    { label: "missing substring", text: "pick a variant", term: "logo", expected: false },
  ])("matchesSearch returns $expected for $label", ({ text, term, expected }) => {
    expect(matchesSearch({ text }, term)).toBe(expected);
  });

  test.each([
    { label: "all accepts any kind", rowKind: "work", filterKind: "all", expected: true },
    {
      label: "kindless row matches specific filter",
      rowKind: "",
      filterKind: "work",
      expected: true,
    },
    { label: "matching kind", rowKind: "decision", filterKind: "decision", expected: true },
    { label: "different kind", rowKind: "work", filterKind: "decision", expected: false },
  ])("matchesKind returns $expected for $label", ({ rowKind, filterKind, expected }) => {
    expect(matchesKind({ kind: rowKind }, filterKind)).toBe(expected);
  });

  const baseRow: RowFilterInfo = {
    who: "Sam",
    kind: "decision",
    repo: "beta",
    isTarget: false,
    text: "pick a variant",
  };
  const baseFilters: ActiveFilters = {
    person: "Kim",
    kind: "all",
    term: "variant",
    hiddenRepos,
  };

  test.each([
    {
      label: "matches active filters",
      row: { ...baseRow, who: "Kim" },
      filters: baseFilters,
      expected: "shown",
    },
    {
      label: "other person hit counted as elsewhere",
      row: baseRow,
      filters: baseFilters,
      expected: "elsewhere",
    },
    {
      label: "hidden repo hit counted as unseen",
      row: { ...baseRow, who: "Kim", repo: "alpha" },
      filters: baseFilters,
      expected: "unseen",
    },
    {
      label: "wrong kind is hidden even with matching term",
      row: { ...baseRow, kind: "work" },
      filters: { ...baseFilters, kind: "decision" },
      expected: "hidden",
    },
    {
      label: "other person without search term is simply hidden",
      row: baseRow,
      filters: { ...baseFilters, term: "" },
      expected: "hidden",
    },
  ])("classifyRow: $label", ({ row, filters, expected }) => {
    expect(classifyRow(row, filters)).toBe(expected);
  });

  const pageRows: PageRow[] = [
    {
      who: "Kim",
      kind: "decision",
      repo: "beta",
      status: "open",
      isItem: true,
      isTarget: false,
      text: "",
    },
    {
      who: "Kim",
      kind: "work",
      repo: "beta",
      status: "open",
      isItem: true,
      isTarget: false,
      text: "",
    },
    {
      who: "Sam",
      kind: "decision",
      repo: "beta",
      status: "open",
      isItem: true,
      isTarget: false,
      text: "",
    },
    {
      who: "Kim",
      kind: "decision",
      repo: "alpha",
      status: "open",
      isItem: true,
      isTarget: false,
      text: "",
    },
    {
      who: "Kim",
      kind: "decision",
      repo: "beta",
      status: "open",
      isItem: false,
      isTarget: false,
      text: "",
    },
    {
      who: "Kim",
      kind: "decision",
      repo: "beta",
      status: "assumed",
      isItem: true,
      isTarget: false,
      text: "",
    },
    {
      who: "Sam",
      kind: "decision",
      repo: "beta",
      status: "assumed",
      isItem: true,
      isTarget: false,
      text: "",
    },
  ];

  test.each([
    { label: "counts Kim open items in visible repos", person: "Kim", expected: 2 },
    { label: "counts all open items in visible repos", person: null, expected: 3 },
  ])("countOpenForPerson: $label", ({ person, expected }) => {
    expect(countOpenForPerson(pageRows, person, hiddenRepos)).toBe(expected);
  });

  const openKimRows = pageRows.slice(0, 2);

  test.each([
    { kind: "all", expected: 2 },
    { kind: "decision", expected: 1 },
    { kind: "review", expected: 0 },
  ])("countOpenOfKind($kind)", ({ kind, expected }) => {
    expect(countOpenOfKind(openKimRows, kind)).toBe(expected);
  });

  test.each([
    { label: "filtered to Kim", person: "Kim", expected: 1 },
    { label: "unfiltered all", person: null, expected: 2 },
  ])("countAssumedRows: $label", ({ person, expected }) => {
    expect(countAssumedRows(pageRows, { ...baseFilters, person })).toBe(expected);
  });

  test.each([
    {
      label: "counts visible non-report items",
      rows: [
        { key: "beta:one", repo: "beta", isReport: false, isTarget: false },
        { key: "beta:two", repo: "beta", isReport: false, isTarget: false },
      ] as ChangedRowInfo[],
      expected: 2,
    },
    {
      label: "excludes changed report rows",
      rows: [
        { key: "beta:one", repo: "beta", isReport: false, isTarget: false },
        { key: "#beta:report", repo: "beta", isReport: true, isTarget: false },
      ] as ChangedRowInfo[],
      expected: 1,
    },
    {
      label: "excludes a row in a hidden repository",
      rows: [
        { key: "alpha:hidden", repo: "alpha", isReport: false, isTarget: false },
      ] as ChangedRowInfo[],
      expected: 0,
    },
    {
      label: "counts the row the link names in a hidden repository",
      rows: [
        { key: "alpha:target", repo: "alpha", isReport: false, isTarget: true },
      ] as ChangedRowInfo[],
      expected: 1,
    },
    {
      label: "counts duplicate changed marks on the same item key once",
      rows: [
        { key: "beta:one", repo: "beta", isReport: false, isTarget: false },
        { key: "beta:one", repo: "beta", isReport: false, isTarget: false },
      ] as ChangedRowInfo[],
      expected: 1,
    },
  ])("countChangedItems: $label", ({ rows, expected }) => {
    expect(countChangedItems(rows, hiddenRepos)).toBe(expected);
  });
});

describe("filter sentences and fragment navigation", () => {
  test.each([
    { count: 1, expected: "1 assumption agents made" },
    { count: 3, expected: "3 assumptions agents made" },
  ])("assumptionsText($count)", ({ count, expected }) => {
    expect(assumptionsText(count)).toBe(expected);
  });

  const morning = new Date(2026, 0, 5, 9, 15).getTime();

  test.each([
    { count: 0, expected: "" },
    {
      count: 1,
      expected: "1 item on this page changed since your last visit, 5 Jan at 09:15.",
    },
    {
      count: 2,
      expected: "2 items on this page changed since your last visit, 5 Jan at 09:15.",
    },
  ])("changedSinceText($count)", ({ count, expected }) => {
    expect(changedSinceText(count, morning)).toBe(expected);
  });

  test.each([
    { count: 0, expected: "" },
    { count: 1, expected: "; 1 row of other people does: choose All to see it" },
    { count: 2, expected: "; 2 rows of other people do: choose All to see them" },
  ])("otherPeopleMatchesClause($count)", ({ count, expected }) => {
    expect(otherPeopleMatchesClause(count)).toBe(expected);
  });

  test.each([
    { count: 0, expected: "" },
    { count: 1, expected: "; 1 row in hidden repositories does" },
    { count: 3, expected: "; 3 rows in hidden repositories do" },
  ])("hiddenRepoMatchesClause($count)", ({ count, expected }) => {
    expect(hiddenRepoMatchesClause(count)).toBe(expected);
  });

  test.each([
    {
      label: "unfiltered query",
      term: "logo",
      person: null,
      hidden: { elsewhere: 0, unseen: 0 },
      expected: "No row on this page matches “logo”.",
    },
    {
      label: "person filter with singular elsewhere",
      term: "logo",
      person: "Kim",
      hidden: { elsewhere: 1, unseen: 0 },
      expected:
        "No row for Kim on this page matches “logo”; 1 row of other people does: choose All to see it.",
    },
    {
      label: "plural elsewhere and plural unseen",
      term: "logo",
      person: "Kim",
      hidden: { elsewhere: 2, unseen: 3 },
      expected:
        "No row for Kim on this page matches “logo”; 2 rows of other people do: choose All to see them; 3 rows in hidden repositories do.",
    },
    {
      label: "singular unseen only",
      term: "logo",
      person: null,
      hidden: { elsewhere: 0, unseen: 1 },
      expected: "No row on this page matches “logo”; 1 row in hidden repositories does.",
    },
  ])("noMatchSentence formats $label", ({ term, person, hidden, expected }) => {
    expect(noMatchSentence(term, person, hidden)).toBe(expected);
  });

  test.each([
    { hash: "#alpha:pick-one", expected: "alpha:pick-one" },
    { hash: "#alpha:item%20one", expected: "alpha:item one" },
    { hash: "#%E0%A4%A", expected: "" },
  ])("decodeHash($hash)", ({ hash, expected }) => {
    expect(decodeHash(hash)).toBe(expected);
  });

  test.each([
    { fragment: "alpha:gone", found: true, expected: "" },
    { fragment: "heading-only", found: false, expected: "" },
    {
      fragment: "alpha:gone",
      found: false,
      expected:
        "alpha:gone is no longer open: it was settled or finished, and its file is gone. Its history: git log --all -- docs/agent-work/items/gone.md in alpha.",
    },
    { fragment: "alpha:docs/gone", found: false, expected: "" },
    { fragment: "../alpha:gone", found: false, expected: "" },
    { fragment: "alpha:gone:extra", found: false, expected: "" },
  ])("goneItemNotice($fragment, $found)", ({ fragment, found, expected }) => {
    expect(goneItemNotice(fragment, found)).toBe(expected);
  });
});
