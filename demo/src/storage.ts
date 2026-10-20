const PREFIX = "tranfr-demo:";

// Storage can be unavailable (private windows, blocked site data); the demo must still work.
export function loadStored<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveStored(name: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + name);
    else localStorage.setItem(PREFIX + name, JSON.stringify(value));
  } catch {
    // Not persisted; state still lives in memory for this session.
  }
}
