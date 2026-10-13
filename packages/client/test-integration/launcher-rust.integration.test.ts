import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { Service } from "../src/promise/service"
import { discover, ensure, stop } from "../src/effect/service"
import { fixture } from "../../../rust/crates/runtime/tests/support/launcher-client"

test("Promise and Effect TS clients discover, ensure, contend, replace and stop the real Rust runtime", async () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built launcher")
  for (const kind of ["promise", "effect"] as const) {
    const runtime = await fixture(binary)
    const lookup = (version: string) =>
      kind === "promise"
        ? Service.discover({ file: runtime.file, version })
        : Effect.runPromise(discover({ file: runtime.file, version }).pipe(Effect.provide(NodeFileSystem.layer)))
    const start = (version: string, onStart?: (reason: string) => void) => {
      const options = {
        file: runtime.file,
        version,
        command: runtime.command(version),
        onStart,
        startupErrorFile: runtime.startupErrorFile,
      }
      return kind === "promise"
        ? Service.ensure(options)
        : Effect.runPromise(ensure(options).pipe(Effect.provide(NodeFileSystem.layer)))
    }
    try {
      expect(await lookup("client-v1")).toBeUndefined()
      const contenders = await Promise.all([start("client-v1"), start("client-v1"), start("client-v1")])
      expect(contenders[1]).toEqual(contenders[0])
      expect(contenders[2]).toEqual(contenders[0])
      const first = await runtime.registration()
      expect(await lookup("client-v1")).toEqual(contenders[0])
      expect(await lookup("client-v2")).toBeUndefined()
      const starts: string[] = []
      expect(await start("client-v1", (reason) => starts.push(reason))).toEqual(contenders[0])
      expect(starts).toEqual([])
      const target = await fetch(new URL("/api/service/stop", first.url), {
        method: "POST",
        headers: { authorization: "Basic " + btoa("ycoding:" + first.password), "content-type": "application/json" },
        body: JSON.stringify({ instanceID: "stale" }),
      })
      expect(await target.json()).toEqual({ accepted: false })
      const replaced = await start("client-v2", (reason) => starts.push(reason))
      expect(starts).toEqual(["version-mismatch"])
      const second = await runtime.registration()
      expect(second.pid).not.toBe(first.pid)
      expect(second.id).not.toBe(first.id)
      expect(second.password).toBe(first.password)
      expect(second.version).toBe("client-v2")
      expect(await lookup("client-v2")).toEqual(replaced)
      if (kind === "promise") await Service.stop({ file: runtime.file })
      else await Effect.runPromise(stop({ file: runtime.file }).pipe(Effect.provide(NodeFileSystem.layer)))
      expect(await lookup("client-v2")).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }
}, 120_000)
