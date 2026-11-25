import { Window } from "happy-dom";
import { describe, expect, test, vi } from "vitest";
import {
  MemoryStorage,
  browserStorage,
  createStore,
  isStorageError,
  parseJson,
  parseRecord,
  readRaw,
  removeRaw,
  storageKeys,
  writeRaw,
  type StorageLike,
} from "../site/src/storage.ts";

function throwingStorage(error: unknown): StorageLike {
  return {
    get length() {
      return 0;
    },
    getItem() {
      throw error;
    },
    setItem() {
      throw error;
    },
    removeItem() {
      throw error;
    },
    key() {
      return null;
    },
  };
}

describe("MemoryStorage", () => {
  test("stores, retrieves, and enumerates string entries", () => {
    const mem = new MemoryStorage();
    mem.setItem("a", "1");
    mem.setItem("b", "2");
    expect(mem.length).toBe(2);
    expect(mem.getItem("a")).toBe("1");
    expect(mem.key(1)).toBe("b");
    expect(mem.key(5)).toBeNull();
    expect(mem.keys()).toEqual(["a", "b"]);
  });

  test("removes stored entries and shifts remaining keys", () => {
    const mem = new MemoryStorage();
    mem.setItem("a", "1");
    mem.setItem("b", "2");
    mem.removeItem("a");
    expect(mem.length).toBe(1);
    expect(mem.getItem("a")).toBeNull();
    expect(mem.key(0)).toBe("b");
  });
});

describe("isStorageError and storageKeys", () => {
  test.each([
    {
      label: "QuotaExceededError",
      error: new DOMException("full", "QuotaExceededError"),
      expected: true,
    },
    { label: "SecurityError", error: new DOMException("blocked", "SecurityError"), expected: true },
    { label: "TypeError", error: new TypeError("bad"), expected: false },
    { label: "plain Error", error: new Error("SecurityError"), expected: false },
    { label: "null", error: null, expected: false },
    { label: "string", error: "SecurityError", expected: false },
  ])("isStorageError returns $expected for $label", ({ error, expected }) => {
    expect(isStorageError(error)).toBe(expected);
  });

  test("storageKeys lists MemoryStorage keys in one pass without calling key(i)", () => {
    const mem = new MemoryStorage();
    mem.setItem("a", "1");
    mem.setItem("b", "2");
    const keySpy = vi.spyOn(mem, "key");
    expect(storageKeys(mem)).toEqual(["a", "b"]);
    expect(keySpy).not.toHaveBeenCalled();
  });

  test("storageKeys lists browser Storage keys via Object.keys without calling key(i)", () => {
    const win = new Window({ url: "http://admin.localhost/" });
    try {
      win.localStorage.setItem("x", "1");
      win.localStorage.setItem("y", "2");
      const keySpy = vi.spyOn(win.localStorage, "key");
      expect(storageKeys(win.localStorage)).toEqual(["x", "y"]);
      expect(keySpy).not.toHaveBeenCalled();
    } finally {
      win.close();
    }
  });
});

describe("browserStorage", () => {
  test("returns the host storage when accessible", () => {
    const mem = new MemoryStorage();
    expect(browserStorage({ localStorage: mem })).toBe(mem);
  });

  test("falls back to MemoryStorage on SecurityError", () => {
    const host = {
      get localStorage(): StorageLike {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    expect(browserStorage(host)).toBeInstanceOf(MemoryStorage);
  });

  test("propagates unexpected errors from the localStorage getter", () => {
    const host = {
      get localStorage(): StorageLike {
        throw new TypeError("unexpected getter failure");
      },
    };
    expect(() => browserStorage(host)).toThrow("unexpected getter failure");
  });
});

describe("raw storage operations", () => {
  test.each([
    { name: "QuotaExceededError", error: new DOMException("full", "QuotaExceededError") },
    { name: "SecurityError", error: new DOMException("blocked", "SecurityError") },
  ])("readRaw, writeRaw, and removeRaw absorb $name", ({ error }) => {
    const storage = throwingStorage(error);
    expect(readRaw(storage, "k")).toBeNull();
    expect(writeRaw(storage, "k", "v")).toBe(false);
    expect(removeRaw(storage, "k")).toBe(false);
  });

  test("readRaw, writeRaw, and removeRaw propagate unexpected errors", () => {
    const storage = throwingStorage(new TypeError("broken storage"));
    expect(() => readRaw(storage, "k")).toThrow("broken storage");
    expect(() => writeRaw(storage, "k", "v")).toThrow("broken storage");
    expect(() => removeRaw(storage, "k")).toThrow("broken storage");
  });
});

describe("JSON parsing helpers", () => {
  test.each([
    { label: "valid object", raw: '{"done":true}', expected: { done: true } },
    { label: "null input", raw: null, expected: null },
    { label: "empty string", raw: "", expected: null },
    { label: "invalid JSON", raw: "unreadable", expected: null },
    { label: "JSON false", raw: "false", expected: null },
  ])("parseJson handles $label", ({ raw, expected }) => {
    expect(parseJson(raw)).toEqual(expected);
  });

  test.each([
    { label: "string map", raw: '{"a":"1","b":"2"}', expected: { a: "1", b: "2" } },
    { label: "preserves non-string entries", raw: '{"a":"1","n":2}', expected: { a: "1", n: 2 } },
    { label: "invalid JSON returns null", raw: "{broken", expected: null },
    { label: "JSON array returns null", raw: '["a"]', expected: null },
    { label: "JSON null returns null", raw: "null", expected: null },
    { label: "absent value returns empty object", raw: null, expected: {} },
    { label: "empty string returns empty object", raw: "", expected: {} },
  ])("parseRecord handles $label", ({ raw, expected }) => {
    expect(parseRecord(raw)).toEqual(expected);
  });
});

describe("createStore", () => {
  test("distinguishes answer keys from own metadata and foreign prefixes", () => {
    const mem = new MemoryStorage();
    mem.setItem("admin-answers:spoke:item-1", '{"done":true}');
    mem.setItem("admin-answers:seen", "123");
    mem.setItem("admin-answers:repos", '["spoke"]');
    mem.setItem("other-app:spoke:item-2", '{"done":true}');
    const store = createStore(mem, "admin-answers:");
    expect(store.answerIds()).toEqual(["spoke:item-1"]);
    expect(store.isAnswerKey("admin-answers:spoke:item-1")).toBe(true);
    expect(store.isAnswerKey("admin-answers:who")).toBe(false);
    expect(store.isAnswerKey(null)).toBe(false);
  });

  test("reads, writes, and removes raw and prefixed text entries", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    store.setRaw("theme", "dark");
    store.setText("who", "Kim");
    store.setText("copied", "2026-01-01T10:00:00.000Z");
    expect(store.getRaw("theme")).toBe("dark");
    expect(store.getText("who")).toBe("Kim");
    expect(store.copiedAt()).toBe("2026-01-01T10:00:00.000Z");
    store.remove("who");
    expect(store.getText("who")).toBeNull();
  });

  test("reads and writes JSON and record entries and deletes on null", () => {
    const mem = new MemoryStorage();
    const store = createStore(mem, "admin-answers:");
    store.writeJson("spoke:item-1", { note: "ok" });
    store.writeJson("versions", { "spoke:item-1": "v1 a1", count: 2 });
    expect(store.readJson("spoke:item-1")).toEqual({ note: "ok" });
    expect(store.readRecord("versions")).toEqual({ "spoke:item-1": "v1 a1", count: 2 });
    store.writeJson("spoke:item-1", null);
    expect(store.readJson("spoke:item-1")).toBeNull();
  });
});
