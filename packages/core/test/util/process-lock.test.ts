import { expect, spyOn } from "bun:test"
import { ProcessLock } from "@ycoding-ai/core/util/process-lock"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import filesystem from "node:fs"
import os from "node:os"
import path from "node:path"
import { it } from "../lib/effect"

const worker = path.join(import.meta.dir, "../fixture/process-lock-worker.ts")
const posixIt = process.platform === "win32" ? it.live.skip : it.live

it.live(
  "releases ownership when the scope closes",
  Effect.gen(function* () {
    const root = yield* temp("ycoding-process-lock-")
    const file = path.join(root, "service.lock")
    yield* Effect.scoped(ProcessLock.acquire(file))
    yield* Effect.scoped(ProcessLock.acquire(file))
  }),
)

it.live(
  "releases ownership when the process dies",
  Effect.gen(function* () {
    const root = yield* temp("ycoding-process-lock-death-")
    const file = path.join(root, "service.lock")
    const ready = path.join(root, "ready")
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([process.execPath, worker, JSON.stringify({ file, ready })], {
          stdout: "ignore",
          stderr: "pipe",
        }),
      ),
      (child) =>
        Effect.promise(async () => {
          kill(child)
          await child.exited
        }),
    )
    yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20)
    })
    expect(yield* Effect.promise(() => Bun.file(ready).exists())).toBe(true)

    const error = yield* Effect.scoped(ProcessLock.acquire(file)).pipe(Effect.flip)
    expect(error._tag).toBe("ProcessLockHeldError")

    if (process.platform !== "win32") {
      process.kill(child.pid, "SIGSTOP")
      const paused = yield* Effect.scoped(ProcessLock.acquire(file)).pipe(Effect.flip)
      expect(paused._tag).toBe("ProcessLockHeldError")
      process.kill(child.pid, "SIGCONT")
    }

    kill(child)
    yield* Effect.promise(() => child.exited)
    yield* Effect.scoped(ProcessLock.acquire(file))
  }),
)

it.live(
  "claims a slot exclusively across processes and adopts the file a dead holder left",
  Effect.gen(function* () {
    const root = yield* temp("ycoding-process-claim-")
    const file = path.join(root, "slots", "run-0")
    const ready = path.join(root, "ready")
    const child = Bun.spawn([process.execPath, worker, JSON.stringify({ file, ready, claim: true })], {
      stdout: "ignore",
      stderr: "pipe",
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => kill(child)))
    yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(20)
    })
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
    expect((yield* Effect.scoped(ProcessLock.claim(file)).pipe(Effect.flip))._tag).toBe("ProcessLockHeldError")

    kill(child)
    yield* Effect.promise(() => child.exited)
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ProcessLock.claim(file)
        expect((yield* Effect.scoped(ProcessLock.claim(file)).pipe(Effect.flip))._tag).toBe("ProcessLockHeldError")
      }),
    )
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }),
)

posixIt(
  "removes a released slot file only while the path still names the claimed file",
  Effect.gen(function* () {
    const root = yield* temp("ycoding-process-claim-replaced-")
    const file = path.join(root, "slot")
    const first = yield* Scope.make()
    yield* ProcessLock.claim(file).pipe(Scope.provide(first))
    yield* Effect.promise(() => fs.rm(file))
    const second = yield* Scope.make()
    yield* ProcessLock.claim(file).pipe(Scope.provide(second))
    yield* Scope.close(first, Exit.void)
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
    expect((yield* Effect.scoped(ProcessLock.claim(file)).pipe(Effect.flip))._tag).toBe("ProcessLockHeldError")
    yield* Scope.close(second, Exit.void)
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }),
)

for (const replacement of [false, true]) {
  posixIt(
    `loses a claim when its opened file is ${replacement ? "replaced" : "removed"} before path validation`,
    Effect.gen(function* () {
      const root = yield* temp("ycoding-process-claim-race-")
      const file = path.join(root, "slot")
      const original = filesystem.openSync
      const probe = spyOn(filesystem, "openSync").mockImplementationOnce((target, flags, mode) => {
        const fd = original(target, flags, mode)
        filesystem.unlinkSync(file)
        if (replacement) filesystem.writeFileSync(file, "replacement")
        return fd
      })
      const error = yield* Effect.scoped(ProcessLock.claim(file)).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => probe.mockRestore())),
      )
      expect(error._tag).toBe("ProcessLockHeldError")
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(replacement)
      if (replacement) expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("replacement")
      yield* Effect.scoped(ProcessLock.claim(file))
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
    }),
  )
}

posixIt(
  "removes the slot path while its inode is still locked, before closing the descriptor",
  Effect.gen(function* () {
    const root = yield* temp("ycoding-process-claim-release-")
    const file = path.join(root, "slot")
    const alias = path.join(root, "alias")
    const scope = yield* Scope.make()
    yield* ProcessLock.claim(file).pipe(Scope.provide(scope))
    yield* Effect.promise(() => fs.link(file, alias))
    const original = filesystem.closeSync
    const observed: { missing?: boolean; held?: boolean } = {}
    const probe = spyOn(filesystem, "closeSync").mockImplementationOnce((fd) => {
      probe.mockRestore()
      observed.missing = !filesystem.existsSync(file)
      observed.held =
        Effect.runSync(Effect.scoped(ProcessLock.acquire(alias)).pipe(Effect.flip))._tag === "ProcessLockHeldError"
      original(fd)
    })
    yield* Scope.close(scope, Exit.void).pipe(Effect.ensuring(Effect.sync(() => probe.mockRestore())))
    expect(observed).toEqual({ missing: true, held: true })
    yield* Effect.scoped(ProcessLock.acquire(alias))
  }),
)

function temp(prefix: string) {
  return Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), prefix))),
    (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  )
}

function kill(child: Bun.Subprocess) {
  if (process.platform === "win32") return child.kill()
  return child.kill("SIGKILL")
}
