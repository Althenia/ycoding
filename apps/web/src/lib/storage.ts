export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Returns browser storage when the page may use it. Reading the `localStorage`
 * property itself throws in some privacy modes, so the access is guarded.
 */
export function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

/** Reads and decodes one key. Absent storage, blocked reads, and decode failures all yield `undefined`. */
export function readStored<T>(
  storage: StorageLike | null | undefined,
  key: string,
  decode: (raw: string) => T | undefined,
): T | undefined {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(key)
    return raw === null ? undefined : decode(raw)
  } catch {
    return undefined
  }
}

/** Writes one value and reports whether it was persisted. */
export function writeStored(storage: StorageLike | null | undefined, key: string, value: string): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
