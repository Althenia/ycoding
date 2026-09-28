import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export function createRemotePreferenceRepository(file: string) {
  let pending = Promise.resolve()
  return {
    load: () => pending.then(async () => {
      try {
        const value: unknown = JSON.parse(await readFile(file, "utf8"))
        return typeof value === "object" && value !== null && Reflect.get(value, "enabled") === true
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
        throw error
      }
    }),
    save(enabled: boolean) {
      const written = pending.then(async () => {
        await mkdir(path.dirname(file), { recursive: true })
        const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify({ enabled }), { mode: 0o600 }).catch(async (error) => {
          await rm(temporary, { force: true }).catch(() => undefined)
          throw error
        })
        await rename(temporary, file).catch(async (error) => {
          await rm(temporary, { force: true }).catch(() => undefined)
          throw error
        })
      })
      pending = written.catch(() => undefined)
      return written
    },
  }
}
