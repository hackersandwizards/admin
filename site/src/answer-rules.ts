import { clockTime, shortDateTime } from "./time.ts";

export interface StoredAnswer {
  readonly later?: boolean;
  readonly stance?: string;
  readonly option?: string;
  readonly label?: string | null | readonly (string | null | undefined)[];
  readonly asked?: string;
  readonly done?: boolean;
  readonly note?: unknown;
  readonly at: string;
  readonly report?: string;
  readonly version?: string;
}

export interface QuestionSnapshot {
  readonly asked: string;
  readonly hasRow: boolean;
  readonly currentOptionLabel?: string;
}

export interface RowMarkContext {
  readonly stale: boolean;
  readonly copiedAt: string;
  readonly currentOptionLabel?: string;
}

export interface RowMarkView {
  readonly markText: string;
  readonly isError: boolean;
  readonly showReset: boolean;
  readonly savedText: string;
  readonly showStaleNotice: boolean;
  readonly staleText: string;
}

export interface AnswerDraft {
  readonly options: readonly { readonly key: string; readonly label?: string }[];
  readonly done: boolean;
  readonly later: boolean;
  readonly stance: string;
  readonly note: string;
  readonly asked?: string;
  readonly commentReport?: { readonly key: string; readonly version: string };
}

export interface AnsweredEntry {
  readonly key: string;
  readonly at: string;
  readonly stale: boolean;
}

export interface CopySelection {
  readonly total: number;
  readonly sendKeys: string[];
  readonly freshCount: number;
  readonly staleCount: number;
}

export interface CopyButtonView {
  readonly disabled: boolean;
  readonly label: string;
  readonly secondary: boolean;
  readonly statusText: string;
}

export function pickedKeys(answer: StoredAnswer | null): string[] {
  return answer?.option ? answer.option.split(",") : [];
}

// The labels as answered, one per pick: a single text in an answer stored before v1.24.0.
export function answerLabels(answer: StoredAnswer): (string | null | undefined)[] {
  if (answer.label == null) return [];
  return typeof answer.label === "string" ? [answer.label] : [...answer.label];
}

// An answer given before its item's question or options changed: by the question it stored, or,
// stored before answers carried one, by the label it copied.
export function isStaleAnswer(
  answer: StoredAnswer | null,
  question: QuestionSnapshot | null,
): boolean {
  if (!answer || !question) return false;
  if (answer.asked) return answer.asked !== question.asked;
  if (!question.hasRow) return false;
  return (
    pickedKeys(answer).length === 1 &&
    typeof answer.label === "string" &&
    question.currentOptionLabel !== answer.label
  );
}

export function optionSummary(answer: StoredAnswer, currentOptionLabel?: string): string {
  const count = pickedKeys(answer).length;
  if (count > 1) return `${count} picked`;
  if (!answer.option) return "";
  return currentOptionLabel || answer.option;
}

export function answerSummary(answer: StoredAnswer, currentOptionLabel?: string): string {
  const parts = [
    answer.stance,
    optionSummary(answer, currentOptionLabel),
    answer.done ? "done" : "",
    answer.report ? "comment" : "",
  ].filter(Boolean);
  return parts.join(", ") || "note";
}

export function staleAnswerDetail(answer: StoredAnswer): string {
  if (answer.option) {
    const quoted = answerLabels(answer)
      .filter((name): name is string => typeof name === "string" && Boolean(name))
      .map((name) => `“${name}”`)
      .join(", ");
    return `You picked ${quoted || answer.option}`;
  }
  if (answer.stance) return `You chose “${answer.stance}”`;
  if (answer.done) return "You marked this done";
  return "You wrote your note";
}

export function rowMarkMode(answer: StoredAnswer, stale: boolean): "later" | "stale" | "current" {
  if (answer.later) return "later";
  if (stale) return "stale";
  return "current";
}

export function describeRowMark(answer: StoredAnswer | null, ctx: RowMarkContext): RowMarkView {
  if (!answer)
    return {
      markText: "",
      isError: false,
      showReset: false,
      savedText: "",
      showStaleNotice: false,
      staleText: "",
    };
  const sent = !ctx.stale && !answer.later && answer.at <= ctx.copiedAt;
  const markByMode = {
    later: () => "later",
    stale: () => "! answered before the question changed",
    current: () => `✓ ${answerSummary(answer, ctx.currentOptionLabel)}`,
  };
  const markText = markByMode[rowMarkMode(answer, ctx.stale)]() + (sent ? " · copied" : "");
  const copiedPart = sent ? `, copied ${clockTime(ctx.copiedAt)}` : "";
  const staleText = ctx.stale
    ? `${staleAnswerDetail(answer)} on ${shortDateTime(answer.at)}. The question or its options changed since: read them again and answer again.`
    : "";
  return {
    markText,
    isError: ctx.stale,
    showReset: true,
    savedText: `saved ${clockTime(answer.at)}${copiedPart}`,
    showStaleNotice: ctx.stale,
    staleText,
  };
}

export function buildAnswer(draft: AnswerDraft, nowIso: string): StoredAnswer | null {
  const note = draft.note.trim();
  const hasContent =
    draft.options.length > 0 || draft.done || draft.later || Boolean(draft.stance) || Boolean(note);
  if (!hasContent) return null;
  // The labels and the question go with the answer, so a page without its row still copies it as
  // given, and a changed question shows.
  return {
    later: draft.later,
    stance: draft.stance,
    option: draft.options.map((o) => o.key).join(","),
    label: draft.options.map((o) => o.label),
    asked: draft.asked,
    done: draft.done,
    note,
    at: nowIso,
    ...(draft.commentReport
      ? { report: draft.commentReport.key, version: draft.commentReport.version }
      : {}),
  };
}

export function selectAnswersToCopy(
  entries: readonly AnsweredEntry[],
  copiedAt: string,
): CopySelection {
  const staleKeys = new Set(entries.filter((e) => e.stale).map((e) => e.key));
  const freshKeys = new Set(entries.filter((e) => !e.stale && e.at > copiedAt).map((e) => e.key));
  const hasPending = freshKeys.size > 0 || staleKeys.size > 0;
  const sendKeys = hasPending
    ? entries.filter((e) => freshKeys.has(e.key) || staleKeys.has(e.key)).map((e) => e.key)
    : entries.map((e) => e.key);
  return {
    total: entries.length,
    sendKeys,
    freshCount: freshKeys.size,
    staleCount: staleKeys.size,
  };
}

export function pendingStatusText(freshCount: number, staleCount: number): string {
  const parts: string[] = [];
  if (freshCount) parts.push(`${freshCount} not copied yet`);
  if (staleCount) {
    const noun = staleCount === 1 ? "its question" : "their questions";
    parts.push(`${staleCount} given before ${noun} changed`);
  }
  return `${parts.join(", ")}.`;
}

export function answerCountText(count: number): string {
  return `${count} answer${count === 1 ? "" : "s"}`;
}

export function describeCopyButton(
  selection: CopySelection,
  copiedAt: string,
  idleText: string,
): CopyButtonView {
  if (!selection.total)
    return { disabled: true, label: "Copy answers", secondary: false, statusText: idleText };
  const done = selection.freshCount === 0 && selection.staleCount === 0;
  if (done)
    return {
      disabled: false,
      label: `Copy ${answerCountText(selection.total)} again`,
      secondary: true,
      statusText: `All ${selection.total} copied at ${clockTime(copiedAt)}.`,
    };
  return {
    disabled: false,
    label: `Copy ${answerCountText(selection.sendKeys.length)}`,
    secondary: false,
    statusText: pendingStatusText(selection.freshCount, selection.staleCount),
  };
}

export function formatAnswerChoice(
  answer: StoredAnswer,
  lookupLabel: (key: string) => string | undefined,
): string {
  const names = answerLabels(answer);
  return pickedKeys(answer)
    .map((key, index) => {
      const name = names[index] ?? lookupLabel(key);
      return name ? `${key} (${name})` : key;
    })
    .join(", ");
}

export function formatCopyLine(key: string, answer: StoredAnswer, choice: string): string {
  const note = typeof answer.note === "string" ? answer.note.replace(/\s+/g, " ") : "";
  const said = [answer.stance, choice || (answer.done ? "done" : ""), note];
  return `${key}: ${said.filter(Boolean).join(", ")}`;
}

export function staleCopyNote(answer: StoredAnswer): string {
  return `; answered ${shortDateTime(answer.at)}, before the question or its options changed`;
}

export function formatCopyBlock(lines: readonly string[]): string {
  return lines.length ? `Answers from the admin pages:\n${lines.join("\n")}` : "";
}
