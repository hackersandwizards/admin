import { decodePercentEncoding } from "../../src/parse-text.ts";
import { shortDateTime } from "./time.ts";

export interface HiddenReposView {
  readonly summary: string;
  readonly hideShowAll: boolean;
  readonly hideHideAll: boolean;
  readonly countText: string;
}

export interface RowFilterInfo {
  readonly who: string;
  readonly kind: string;
  readonly repo: string;
  readonly isTarget: boolean;
  readonly text: string;
}

export interface PageRow extends RowFilterInfo {
  readonly status: string;
  readonly isItem: boolean;
}

export interface ChangedRowInfo {
  readonly key: string;
  readonly repo: string;
  readonly isReport: boolean;
  readonly isTarget: boolean;
}

export interface ActiveFilters {
  readonly person: string | null;
  readonly kind: string;
  readonly term: string;
  readonly hiddenRepos: ReadonlySet<string>;
}

export interface HiddenMatches {
  readonly elsewhere: number;
  readonly unseen: number;
}

export type RowMatchOutcome = "shown" | "unseen" | "elsewhere" | "hidden";

export function pluralCount(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function loadHiddenRepos(storedValue: unknown, knownRepos: readonly string[]): Set<string> {
  const raw = Array.isArray(storedValue) ? storedValue : storedValue ? [storedValue] : [];
  const off = new Set<string>();
  for (const key of raw) if (typeof key === "string" && knownRepos.includes(key)) off.add(key);
  return off;
}

export function describeHiddenRepos(
  hiddenNames: readonly string[],
  totalRepos: number,
): HiddenReposView {
  const hiddenCount = hiddenNames.length;
  return {
    summary: hiddenCount
      ? `${pluralCount(hiddenCount, "repository", "repositories")} hidden: ${hiddenNames.join(", ")}.`
      : "",
    hideShowAll: hiddenCount === 0,
    hideHideAll: hiddenCount === totalRepos,
    countText: hiddenCount ? `${totalRepos - hiddenCount} of ${totalRepos}` : String(totalRepos),
  };
}

// A row the address names shows whatever repository it is in.
export function isRowAway(
  row: Pick<RowFilterInfo, "repo" | "isTarget">,
  hiddenRepos: ReadonlySet<string>,
): boolean {
  return hiddenRepos.has(row.repo) && !row.isTarget;
}

export function matchesPerson(
  row: Pick<RowFilterInfo, "who" | "repo" | "isTarget">,
  person: string | null,
  hiddenRepos: ReadonlySet<string>,
): boolean {
  return !isRowAway(row, hiddenRepos) && (person === null || !row.who || row.who === person);
}

export function matchesSearch(row: Pick<RowFilterInfo, "text">, term: string): boolean {
  return !term || row.text.includes(term);
}

export function matchesKind(row: Pick<RowFilterInfo, "kind">, kind: string): boolean {
  return kind === "all" || !row.kind || row.kind === kind;
}

export function classifyRow(row: RowFilterInfo, filters: ActiveFilters): RowMatchOutcome {
  if (!matchesSearch(row, filters.term) || !matchesKind(row, filters.kind)) return "hidden";
  if (matchesPerson(row, filters.person, filters.hiddenRepos)) return "shown";
  if (!filters.term) return "hidden";
  return isRowAway(row, filters.hiddenRepos) ? "unseen" : "elsewhere";
}

export function countOpenForPerson(
  rows: readonly PageRow[],
  person: string | null,
  hiddenRepos: ReadonlySet<string>,
): number {
  return rows.filter(
    (row) => row.isItem && row.status === "open" && matchesPerson(row, person, hiddenRepos),
  ).length;
}

export function countOpenOfKind(openMineRows: readonly PageRow[], kind: string): number {
  return openMineRows.filter((row) => kind === "all" || row.kind === kind).length;
}

export function countAssumedRows(rows: readonly PageRow[], filters: ActiveFilters): number {
  return rows.filter(
    (row) => row.status === "assumed" && matchesPerson(row, filters.person, filters.hiddenRepos),
  ).length;
}

// The page's changed items, but those a hidden repository holds.
export function countChangedItems(
  rows: readonly ChangedRowInfo[],
  hiddenRepos: ReadonlySet<string>,
): number {
  return new Set(
    rows.filter((row) => !row.isReport && !isRowAway(row, hiddenRepos)).map((row) => row.key),
  ).size;
}

export function assumptionsText(count: number): string {
  return `${pluralCount(count, "assumption")} agents made`;
}

export function changedSinceText(count: number, updatedSince: number): string {
  if (!count) return "";
  return `${pluralCount(count, "item")} on this page changed since your last visit, ${shortDateTime(updatedSince)}.`;
}

export function otherPeopleMatchesClause(count: number): string {
  if (!count) return "";
  const verb = count === 1 ? "does" : "do";
  const pronoun = count === 1 ? "it" : "them";
  return `; ${pluralCount(count, "row")} of other people ${verb}: choose All to see ${pronoun}`;
}

export function hiddenRepoMatchesClause(count: number): string {
  if (!count) return "";
  const verb = count === 1 ? "does" : "do";
  return `; ${pluralCount(count, "row")} in hidden repositories ${verb}`;
}

export function noMatchSentence(
  term: string,
  person: string | null,
  hidden: HiddenMatches,
): string {
  const whoPart = person ? `for ${person} ` : "";
  return `No row ${whoPart}on this page matches “${term}”${otherPeopleMatchesClause(hidden.elsewhere)}${hiddenRepoMatchesClause(hidden.unseen)}.`;
}

export function decodeHash(hash: string): string {
  return decodePercentEncoding(hash.slice(1)) ?? ""; // a malformed hash names no item
}

export function goneItemNotice(fragment: string, found: boolean): string {
  if (found) return "";
  const [repo, id] = fragment.split(":");
  if (!id) return "";
  return `${repo}:${id} is no longer open: it was settled or finished, and its file is gone. Its history: git log --all -- docs/agent-work/items/${id}.md in ${repo}.`;
}
