import { Window } from "happy-dom";
import { expect, test, vi } from "vitest";
import { setupAnswers } from "../site/src/answers.ts";
import { createStore, MemoryStorage } from "../site/src/storage.ts";

test("loads 500 unanswered rows without querying question snapshots", () => {
  const window = new Window();
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = Array.from(
    { length: 500 },
    (_, index) => `<details class="item" data-k="demo:row-${index}" data-asked="v1"></details>`,
  ).join("");
  const query = vi.spyOn(doc, "querySelector");
  const store = createStore(new MemoryStorage(), "admin-answers:");
  const snapshots = () =>
    query.mock.calls.filter(([selector]) => selector.includes("[data-asked]"));
  vi.stubGlobal("CSS", window.CSS);
  try {
    const answers = setupAnswers(store, doc);
    expect(snapshots()).toHaveLength(0);

    store.writeJson("demo:row-0", { asked: "v1", note: "Review this" });
    answers.onStorage("admin-answers:demo:row-0");
    expect(snapshots()).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
