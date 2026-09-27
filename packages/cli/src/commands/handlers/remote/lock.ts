import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { readFileSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ProcessLock } from "@ycoding-ai/core/util/process-lock"

export function remoteLockPath(directory: string) {
  return path.join(directory, "remote-connector.lock")
}

export async function inspectRemoteLock(directory: string) {
  const pid = await readOwner(remoteLockPath(directory)).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  })
  return pid !== undefined && processAlive(pid) ? pid : undefined
}

export async function acquireRemoteLock(
  directory: string,
  input: { pid?: number; alive?: (pid: number) => boolean } = {},
): Promise<{ owned: true; release: () => Promise<void> } | { owned: false; pid: number }> {
  const pid = input.pid ?? process.pid
  const alive = input.alive ?? processAlive
  const target = remoteLockPath(directory)
  await mkdir(directory, { recursive: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = crypto.randomUUID()
    const content = JSON.stringify({ pid, token })
    const temporary = path.join(directory, `.remote-connector-${token}.tmp`)
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    try {
      await link(temporary, target)
      const onExit = () => {
        try {
          if (readFileSync(target, "utf8") === content) unlinkSync(target)
        } catch {}
      }
      if (pid === process.pid) process.once("exit", onExit)
      return {
        owned: true,
        release: async () => {
          process.off("exit", onExit)
          if (await readFile(target, "utf8").catch(() => undefined) === content)
            await unlink(target).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error
            })
        },
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    } finally {
      await unlink(temporary)
    }

    const ownerPID = await readOwner(target).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    })
    if (ownerPID === undefined) continue
    if (alive(ownerPID)) return { owned: false, pid: ownerPID }
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        yield* ProcessLock.acquire(`${target}.recovery`)
        const currentPID = yield* Effect.promise(() => readOwner(target))
        if (alive(currentPID)) return
        yield* Effect.promise(() => unlink(target))
      })))
    } catch (error) {
      if (error instanceof ProcessLock.HeldError) continue
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
  throw new Error("Remote connector lock changed repeatedly")
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== "ESRCH"
  }
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

async function readOwner(target: string) {
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid remote connector lock")
  const owner: unknown = JSON.parse(await readFile(target, "utf8"))
  const pid = typeof owner === "object" && owner !== null ? Reflect.get(owner, "pid") : undefined
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid remote connector lock")
  return pid
}
