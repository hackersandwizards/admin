import { describe, expect, test } from "vitest";
import {
  answerCountText,
  answerLabels,
  answerSummary,
  buildAnswer,
  describeCopyButton,
  describeRowMark,
  formatAnswerChoice,
  formatCopyBlock,
  formatCopyLine,
  isStaleAnswer,
  optionSummary,
  pendingStatusText,
  pickedKeys,
  rowMarkMode,
  selectAnswersToCopy,
  staleAnswerDetail,
  staleCopyNote,
  type StoredAnswer,
} from "../site/src/answer-rules.ts";

const atMorning = new Date(2026, 0, 5, 9, 15).toISOString();
const atNoon = new Date(2026, 0, 5, 12, 30).toISOString();

describe("answer helpers", () => {
  test.each([
    { label: "null answer", answer: null, expected: [] },
    { label: "empty option", answer: { option: "", at: atMorning }, expected: [] },
    { label: "single option", answer: { option: "a", at: atMorning }, expected: ["a"] },
    { label: "multiple options", answer: { option: "a,b", at: atMorning }, expected: ["a", "b"] },
  ])("pickedKeys handles $label", ({ answer, expected }) => {
    expect(pickedKeys(answer)).toEqual(expected);
  });

  test.each([
    { label: "missing label", answer: { at: atMorning }, expected: [] },
    { label: "null label", answer: { label: null, at: atMorning }, expected: [] },
    {
      label: "legacy string label",
      answer: { label: "Option A", at: atMorning },
      expected: ["Option A"],
    },
    {
      label: "array of labels",
      answer: { label: ["Option A", "Option B"], at: atMorning },
      expected: ["Option A", "Option B"],
    },
    {
      label: "array containing null from JSON-serialized undefined",
      answer: { label: ["Option A", null], at: atMorning },
      expected: ["Option A", null],
    },
  ])("answerLabels handles $label", ({ answer, expected }) => {
    expect(answerLabels(answer)).toEqual(expected);
  });

  test.each([
    {
      label: "null answer",
      answer: null,
      question: { asked: "q1", hasRow: true },
      expected: false,
    },
    {
      label: "question not on page",
      answer: { asked: "q1", at: atMorning },
      question: null,
      expected: false,
    },
    {
      label: "matching asked hash",
      answer: { asked: "q1", at: atMorning },
      question: { asked: "q1", hasRow: true },
      expected: false,
    },
    {
      label: "changed asked hash",
      answer: { asked: "q1", at: atMorning },
      question: { asked: "q2", hasRow: true },
      expected: true,
    },
    {
      label: "legacy single pick with matching label",
      answer: { option: "a", label: "First", at: atMorning },
      question: { asked: "q1", hasRow: true, currentOptionLabel: "First" },
      expected: false,
    },
    {
      label: "legacy single pick with changed label",
      answer: { option: "a", label: "Old", at: atMorning },
      question: { asked: "q1", hasRow: true, currentOptionLabel: "New" },
      expected: true,
    },
    {
      label: "legacy pick when row is absent",
      answer: { option: "a", label: "Old", at: atMorning },
      question: { asked: "q1", hasRow: false },
      expected: false,
    },
  ])("isStaleAnswer returns $expected for $label", ({ answer, question, expected }) => {
    expect(isStaleAnswer(answer, question)).toBe(expected);
  });
});

describe("row mark wording", () => {
  test.each([
    {
      label: "no option picked",
      answer: { at: atMorning },
      optionLabel: undefined,
      expected: "",
    },
    {
      label: "single option with label",
      answer: { option: "a", at: atMorning },
      optionLabel: "Option A",
      expected: "Option A",
    },
    {
      label: "single option falling back to key",
      answer: { option: "a", at: atMorning },
      optionLabel: undefined,
      expected: "a",
    },
    {
      label: "multiple options",
      answer: { option: "a,b", at: atMorning },
      optionLabel: "Option A",
      expected: "2 picked",
    },
  ])("optionSummary formats $label", ({ answer, optionLabel, expected }) => {
    expect(optionSummary(answer, optionLabel)).toBe(expected);
  });

  test.each([
    {
      label: "deferred beats stale",
      answer: { later: true, at: atMorning },
      stale: true,
      expected: "later",
    },
    {
      label: "stale when not deferred",
      answer: { option: "a", at: atMorning },
      stale: true,
      expected: "stale",
    },
    {
      label: "current answer",
      answer: { option: "a", at: atMorning },
      stale: false,
      expected: "current",
    },
  ])("rowMarkMode returns $expected for $label", ({ answer, stale, expected }) => {
    expect(rowMarkMode(answer, stale)).toBe(expected);
  });

  test.each([
    {
      label: "single option resolved from label",
      answer: { option: "a", at: atMorning },
      optionLabel: "Option A",
      expected: "Option A",
    },
    {
      label: "single option falling back to key",
      answer: { option: "a", at: atMorning },
      optionLabel: undefined,
      expected: "a",
    },
    {
      label: "multiple options",
      answer: { option: "a,b,c", at: atMorning },
      optionLabel: undefined,
      expected: "3 picked",
    },
    {
      label: "stance with done",
      answer: { stance: "agree", done: true, at: atMorning },
      optionLabel: undefined,
      expected: "agree, done",
    },
    {
      label: "report comment",
      answer: { report: "#alpha:r", note: "check", at: atMorning },
      optionLabel: undefined,
      expected: "comment",
    },
    {
      label: "note only",
      answer: { note: "some text", at: atMorning },
      optionLabel: undefined,
      expected: "note",
    },
  ])("answerSummary formats $label", ({ answer, optionLabel, expected }) => {
    expect(answerSummary(answer, optionLabel)).toBe(expected);
  });

  test.each([
    {
      label: "picked options with labels",
      answer: { option: "a,b", label: ["First", "Second"], at: atMorning },
      expected: "You picked “First”, “Second”",
    },
    {
      label: "picked option with null label",
      answer: { option: "a", label: null, at: atMorning },
      expected: "You picked a",
    },
    {
      label: "picked option with array of null",
      answer: { option: "a", label: [null], at: atMorning },
      expected: "You picked a",
    },
    {
      label: "picked option without labels",
      answer: { option: "a", at: atMorning },
      expected: "You picked a",
    },
    {
      label: "stance",
      answer: { stance: "veto", at: atMorning },
      expected: "You chose “veto”",
    },
    {
      label: "done",
      answer: { done: true, at: atMorning },
      expected: "You marked this done",
    },
    {
      label: "note only",
      answer: { note: "later", at: atMorning },
      expected: "You wrote your note",
    },
  ])("staleAnswerDetail formats $label", ({ answer, expected }) => {
    expect(staleAnswerDetail(answer)).toBe(expected);
  });

  test.each([
    {
      label: "no answer",
      answer: null,
      ctx: { stale: false, copiedAt: "" },
      expected: {
        markText: "",
        isError: false,
        showReset: false,
        savedText: "",
        showStaleNotice: false,
        staleText: "",
      },
    },
    {
      label: "deferred answer",
      answer: { later: true, at: atMorning },
      ctx: { stale: false, copiedAt: atNoon },
      expected: {
        markText: "later",
        isError: false,
        showReset: true,
        savedText: "saved 09:15",
        showStaleNotice: false,
        staleText: "",
      },
    },
    {
      label: "copied current answer",
      answer: { option: "a", at: atMorning },
      ctx: { stale: false, copiedAt: atNoon, currentOptionLabel: "Option A" },
      expected: {
        markText: "✓ Option A · copied",
        isError: false,
        showReset: true,
        savedText: "saved 09:15, copied 12:30",
        showStaleNotice: false,
        staleText: "",
      },
    },
    {
      label: "stale answer",
      answer: { option: "a", label: ["Old"], at: atMorning },
      ctx: { stale: true, copiedAt: atNoon },
      expected: {
        markText: "! answered before the question changed",
        isError: true,
        showReset: true,
        savedText: "saved 09:15",
        showStaleNotice: true,
        staleText:
          "You picked “Old” on 5 Jan at 09:15. The question or its options changed since: read them again and answer again.",
      },
    },
  ])("describeRowMark returns exact view for $label", ({ answer, ctx, expected }) => {
    expect(describeRowMark(answer, ctx)).toEqual(expected);
  });
});

describe("buildAnswer", () => {
  test("returns null for an empty or whitespace-only draft", () => {
    expect(
      buildAnswer({ options: [], done: false, later: false, stance: "", note: "   " }, atMorning),
    ).toBeNull();
  });

  test("builds a complete answer including report metadata for comments", () => {
    const built = buildAnswer(
      {
        options: [{ key: "a", label: "First" }],
        done: false,
        later: false,
        stance: "",
        note: "  keep  ",
        asked: "q1",
        commentReport: { key: "#alpha:r", version: "v1" },
      },
      atMorning,
    );
    expect(built).toEqual({
      later: false,
      stance: "",
      option: "a",
      label: ["First"],
      asked: "q1",
      done: false,
      note: "keep",
      at: atMorning,
      report: "#alpha:r",
      version: "v1",
    });
  });
});

describe("copy selection and wording", () => {
  test.each([
    { count: 0, expected: "0 answers" },
    { count: 1, expected: "1 answer" },
    { count: 2, expected: "2 answers" },
  ])("answerCountText($count)", ({ count, expected }) => {
    expect(answerCountText(count)).toBe(expected);
  });

  test.each([
    {
      label: "fresh and stale selected ahead of already copied",
      entries: [
        { key: "alpha:copied", at: atMorning, stale: false },
        { key: "alpha:stale", at: atMorning, stale: true },
        { key: "alpha:fresh", at: atNoon, stale: false },
      ],
      copiedAt: atMorning,
      expected: {
        total: 3,
        sendKeys: ["alpha:stale", "alpha:fresh"],
        freshCount: 1,
        staleCount: 1,
      },
    },
    {
      label: "all copied selects every key again",
      entries: [
        { key: "alpha:one", at: atMorning, stale: false },
        { key: "alpha:two", at: atMorning, stale: false },
      ],
      copiedAt: atNoon,
      expected: {
        total: 2,
        sendKeys: ["alpha:one", "alpha:two"],
        freshCount: 0,
        staleCount: 0,
      },
    },
  ])("selectAnswersToCopy: $label", ({ entries, copiedAt, expected }) => {
    expect(selectAnswersToCopy(entries, copiedAt)).toEqual(expected);
  });

  test.each([
    { fresh: 2, stale: 0, expected: "2 not copied yet." },
    { fresh: 0, stale: 1, expected: "1 given before its question changed." },
    { fresh: 0, stale: 2, expected: "2 given before their questions changed." },
    { fresh: 1, stale: 2, expected: "1 not copied yet, 2 given before their questions changed." },
  ])("pendingStatusText($fresh, $stale)", ({ fresh, stale, expected }) => {
    expect(pendingStatusText(fresh, stale)).toBe(expected);
  });

  test.each([
    {
      label: "empty",
      selection: { total: 0, sendKeys: [], freshCount: 0, staleCount: 0 },
      expected: { disabled: true, label: "Copy answers", secondary: false, statusText: "Idle." },
    },
    {
      label: "one pending",
      selection: { total: 2, sendKeys: ["a"], freshCount: 1, staleCount: 0 },
      expected: {
        disabled: false,
        label: "Copy 1 answer",
        secondary: false,
        statusText: "1 not copied yet.",
      },
    },
    {
      label: "all copied",
      selection: { total: 2, sendKeys: ["a", "b"], freshCount: 0, staleCount: 0 },
      expected: {
        disabled: false,
        label: "Copy 2 answers again",
        secondary: true,
        statusText: "All 2 copied at 12:30.",
      },
    },
  ])("describeCopyButton handles $label", ({ selection, expected }) => {
    expect(describeCopyButton(selection, atNoon, "Idle.")).toEqual(expected);
  });

  test.each([
    {
      label: "stored labels with fallback to lookup and raw key",
      answer: { option: "a,b,c", label: ["Stored A"], at: atMorning } as StoredAnswer,
      expected: "a (Stored A), b (Live B), c",
    },
    {
      label: "null label falls back to live lookup and raw key",
      answer: { option: "b,c", label: null, at: atMorning } as StoredAnswer,
      expected: "b (Live B), c",
    },
    {
      label: "array holding null falls back to live lookup per slot",
      answer: { option: "a,b,c", label: ["Stored A", null, null], at: atMorning } as StoredAnswer,
      expected: "a (Stored A), b (Live B), c",
    },
  ])("formatAnswerChoice handles $label", ({ answer, expected }) => {
    const labels: Record<string, string> = { b: "Live B" };
    expect(formatAnswerChoice(answer, (key) => labels[key])).toBe(expected);
  });

  test.each([
    {
      label: "choice and collapsed whitespace note",
      answer: { stance: "agree", note: "line one\n  line two", at: atMorning },
      choice: "a (First)",
      expected: "alpha:item: agree, a (First), line one line two",
    },
    {
      label: "done fallback without choice",
      answer: { done: true, at: atMorning },
      choice: "",
      expected: "alpha:item: done",
    },
    {
      label: "non-string note is treated as empty",
      answer: { done: true, note: 42, at: atMorning },
      choice: "",
      expected: "alpha:item: done",
    },
  ])("formatCopyLine formats $label", ({ answer, choice, expected }) => {
    expect(formatCopyLine("alpha:item", answer, choice)).toBe(expected);
  });

  test("staleCopyNote formats the answer timestamp suffix", () => {
    expect(staleCopyNote({ done: true, at: atMorning })).toBe(
      "; answered 5 Jan at 09:15, before the question or its options changed",
    );
  });

  test.each([
    { label: "empty list", lines: [], expected: "" },
    {
      label: "populated list",
      lines: ["alpha:one: done", "alpha:two: ok"],
      expected: "Answers from the admin pages:\nalpha:one: done\nalpha:two: ok",
    },
  ])("formatCopyBlock handles $label", ({ lines, expected }) => {
    expect(formatCopyBlock(lines)).toBe(expected);
  });
});
