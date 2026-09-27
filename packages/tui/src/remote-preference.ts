import { readJson, writeJsonAtomic } from "./util/persistence"

export function createRemotePreferenceRepository(file: string) {
  let pending = Promise.resolve()
  return {
    load: () => pending.then(async () => {
      try {
        const value: unknown = await readJson(file)
        if (typeof value !== "object" || value === null || Reflect.get(value, "enabled") !== true) return false
        return true
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
        throw error
      }
    }),
    save(enabled: boolean) {
      const written = pending.then(() => writeJsonAtomic(file, { enabled }))
      pending = written.catch(() => undefined)
      return written
    },
  }
}
