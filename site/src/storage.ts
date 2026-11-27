// A browser that blocks site data throws on localStorage itself: the page then keeps its state
// for this visit only, and every control still works.
// Only QuotaExceededError and SecurityError fall back; any other error propagates.

import { parseJsonText } from "../../src/parse-text.ts";

export interface StorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

export class MemoryStorage implements StorageLike {
  #entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  get length(): number {
    return this.#entries.size;
  }
}

const DENIED = new Set(["QuotaExceededError", "SecurityError"]);

export function isStorageError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    DENIED.has(error.name)
  );
}

export function storageKeys(storage: StorageLike): string[] {
  return storage instanceof MemoryStorage ? storage.keys() : Object.keys(storage);
}

export function browserStorage(host: { readonly localStorage: StorageLike } = window): StorageLike {
  try {
    return host.localStorage;
  } catch (error) {
    if (isStorageError(error)) return new MemoryStorage();
    throw error;
  }
}

export function readRaw(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch (error) {
    if (isStorageError(error)) return null;
    throw error;
  }
}

export function writeRaw(storage: StorageLike, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch (error) {
    if (isStorageError(error)) return false;
    throw error;
  }
}

export function removeRaw(storage: StorageLike, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch (error) {
    if (isStorageError(error)) return false;
    throw error;
  }
}

export function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  return parseJsonText(raw) || null;
}

// Absent or empty storage holds an empty map; invalid or non-object JSON returns null so callers
// can stop without overwriting corrupt history. Valid objects keep all of their entries as stored.
export function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return {};
  const parsed = parseJsonText(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const OWN_KEYS = ["copied", "who", "seen", "visit", "versions", "before", "repos"];

export interface AdminStore {
  readonly prefix: string;
  isAnswerKey(fullKey: string | null): boolean;
  answerIds(): string[];
  getRaw(key: string): string | null;
  setRaw(key: string, value: string): boolean;
  getText(key: string): string | null;
  setText(key: string, value: string): boolean;
  remove(key: string): boolean;
  readJson(key: string): unknown;
  readRecord(key: string): Record<string, unknown> | null;
  writeJson(key: string, value: unknown): boolean;
  copiedAt(): string;
}

export function createStore(storage: StorageLike, prefix: string): AdminStore {
  const own = new Set(OWN_KEYS.map((key) => prefix + key));
  const isAnswerKey = (fullKey: string | null): boolean =>
    !!fullKey && fullKey.startsWith(prefix) && !own.has(fullKey);

  const answerIds = (): string[] =>
    storageKeys(storage)
      .filter(isAnswerKey)
      .map((fullKey) => fullKey.slice(prefix.length));

  return {
    prefix,
    isAnswerKey,
    answerIds,
    getRaw: (key) => readRaw(storage, key),
    setRaw: (key, value) => writeRaw(storage, key, value),
    getText: (key) => readRaw(storage, prefix + key),
    setText: (key, value) => writeRaw(storage, prefix + key, value),
    remove: (key) => removeRaw(storage, prefix + key),
    readJson: (key) => parseJson(readRaw(storage, prefix + key)),
    readRecord: (key) => parseRecord(readRaw(storage, prefix + key)),
    writeJson: (key, value) =>
      value
        ? writeRaw(storage, prefix + key, JSON.stringify(value))
        : removeRaw(storage, prefix + key),
    copiedAt: () => readRaw(storage, prefix + "copied") || "",
  };
}
