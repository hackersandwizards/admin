// Browser storage wrapper for admin pages. A browser that blocks site data throws SecurityError
// on localStorage itself: the page then keeps its state in MemoryStorage for this visit only, and
// every control still works. QuotaExceededError and SecurityError on reads/writes fall back; any
// other error propagates.

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

  get length(): number {
    return this.#entries.size;
  }
}

const DENIED = new Set(["QuotaExceededError", "SecurityError"]);

function isStorageError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    DENIED.has(error.name)
  );
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
  try {
    return (JSON.parse(raw) as unknown) || null;
  } catch {
    return null;
  }
}

export function parseRecord(raw: string | null): Record<string, string> {
  const parsed = parseJson(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed))
    if (typeof value === "string") out[key] = value;
  return out;
}

// Keys of this browser's own state beside the answers.
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
  readRecord(key: string): Record<string, string>;
  writeJson(key: string, value: unknown): boolean;
  copiedAt(): string;
}

export function createStore(storage: StorageLike, prefix: string): AdminStore {
  const own = new Set(OWN_KEYS.map((key) => prefix + key));
  const isAnswerKey = (fullKey: string | null): boolean =>
    Boolean(fullKey) && fullKey!.startsWith(prefix) && !own.has(fullKey!);

  const answerIds = (): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const fullKey = storage.key(i);
      if (isAnswerKey(fullKey)) ids.push(fullKey!.slice(prefix.length));
    }
    return ids;
  };

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
