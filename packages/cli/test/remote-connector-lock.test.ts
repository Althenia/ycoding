import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { acquireRemoteLock, inspectRemoteLock, remoteLockPath } from "../src/commands/handlers/remote/lock"

describe("remote connector lock", () => {
  test("inspection distinguishes a live holder from an idle machine", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-lock-"))
    try {
      expect(await inspectRemoteLock(directory)).toBeUndefined()
      const lock = await acquireRemoteLock(directory)
      expect(lock.owned).toBe(true)
      expect(await inspectRemoteLock(directory)).toBe(process.pid)
      if (lock.owned) await lock.release()
      expect(await inspectRemoteLock(directory)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("acquires, reports another live process, and releases on stop", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-lock-"))
    try {
      const first = await acquireRemoteLock(directory, { pid: 111, alive: (pid) => pid === 111 })
      expect(first).toMatchObject({ owned: true })
      expect(await readFile(remoteLockPath(directory), "utf8")).toContain('"pid":111')
      const second = await acquireRemoteLock(directory, { pid: 222, alive: (pid) => pid === 111 })
      expect(second).toMatchObject({ owned: false, pid: 111 })
      if (!first.owned) throw new Error("first lock not acquired")
      await first.release()
      const third = await acquireRemoteLock(directory, { pid: 222, alive: (pid) => pid === 222 })
      expect(third).toMatchObject({ owned: true })
      if (third.owned) await third.release()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("replaces a lock whose recorded PID is dead", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-lock-"))
    try {
      await writeFile(remoteLockPath(directory), JSON.stringify({ pid: 999_999_999, token: "dead" }), { mode: 0o600 })
      expect(await inspectRemoteLock(directory)).toBeUndefined()
      const lock = await acquireRemoteLock(directory, { pid: 333, alive: () => false })
      expect(lock).toMatchObject({ owned: true })
      if (lock.owned) await lock.release()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("two processes reclaiming the same dead PID cannot both own the lock", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-lock-"))
    try {
      await writeFile(remoteLockPath(directory), JSON.stringify({ pid: 123456, token: "dead" }), { mode: 0o600 })
      const alive = (pid: number) => pid === 111 || pid === 222
      const locks = await Promise.all([
        acquireRemoteLock(directory, { pid: 111, alive }),
        acquireRemoteLock(directory, { pid: 222, alive }),
      ])
      expect(locks.filter((lock) => lock.owned)).toHaveLength(1)
      expect(locks.filter((lock) => !lock.owned)).toHaveLength(1)
      await Promise.all(locks.filter((lock) => lock.owned).map((lock) => lock.release()))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
