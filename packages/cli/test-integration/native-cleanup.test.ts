import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { NativeProcess } from "../src/native-process"
import { Standalone } from "../src/services/standalone"

test("private readiness consumes native Node pipes and releases only its child lease", async () => {
  let pid: number | undefined
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* Standalone.start({
          command: [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify({url:'http://127.0.0.1:42617'})+'\\n');process.stdin.resume()",
            "--",
          ],
        })
        pid = endpoint.pid
        expect(endpoint.url).toBe("http://127.0.0.1:42617")
        expect(Number.isSafeInteger(pid)).toBe(true)
      }),
    ),
  )
  expect(() => process.kill(pid!, 0)).toThrow()
}, 10_000)

test("native stdio cleanup joins an EOF-driven child without forced termination", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      NativeProcess.start({
        mode: "stdio",
        command: [process.execPath, "-e", "process.stdin.resume()", "--"],
      }),
    ),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
}, 10_000)

test("native stdio cleanup reports forced termination instead of successful release", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      NativeProcess.start({
        mode: "stdio",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)", "--"],
      }),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("forced termination")
}, 10_000)
