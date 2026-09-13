// localStorage helpers for the CoTeach session store.
// Falls back to an in-memory map when localStorage is unavailable (SSR / private mode).

const memory = new Map<string, string>();

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = hasLocalStorage()
      ? window.localStorage.getItem(key)
      : memory.get(key) ?? null;
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  if (hasLocalStorage()) {
    try {
      window.localStorage.setItem(key, raw);
    } catch {
      memory.set(key, raw);
    }
  } else {
    memory.set(key, raw);
  }
}

export function clearJSON(key: string): void {
  if (hasLocalStorage()) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  memory.delete(key);
}

export const STORAGE_KEY = "openpbl.session.v1";
