import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { UserActivity } from "../src/util/user-activity"

test("activity opens lazily, renews the returned ID, and releases only the latest owned assertion", () => {
  const declarations: number[] = []
  const releases: number[] = []
  let opened = 0
  let closed = 0
  const activity = UserActivity.make("darwin", () => {
    opened++
    return {
      declare: (id) => { declarations.push(id); return { code: 0, id: declarations.length < 3 ? 41 : 72 } },
      release: (id) => { releases.push(id); return 0 },
      close: () => { closed++ },
    }
  })
  expect(opened).toBe(0)
  expect(activity.set(false)).toBe("off")
  expect(opened).toBe(0)
  expect(activity.set(true)).toBe("on")
  expect(activity.set(true)).toBe("on")
  expect(activity.set(true)).toBe("on")
  expect(declarations).toEqual([0, 41, 41])
  expect(activity.set(false)).toBe("off")
  expect(activity.set(false)).toBe("off")
  expect(releases).toEqual([72])
  expect(closed).toBe(1)
  expect(activity.set(true)).toBe("on")
  expect(opened).toBe(2)
  expect(declarations.at(-1)).toBe(0)
  expect(activity.set(false)).toBe("off")
})

test("activity preserves the owned ID through renewal and release failures for cleanup", () => {
  const ids: number[] = []
  const releases: number[] = []
  let fail = false
  let closed = false
  const activity = UserActivity.make("darwin", () => ({
    declare: (id) => { ids.push(id); return { code: fail ? 1 : 0, id: fail ? 999 : 42 } },
    release: (id) => { releases.push(id); return fail ? 1 : 0 },
    close: () => { closed = true },
  }))
  expect(activity.set(true)).toBe("on")
  fail = true
  expect(activity.set(true)).toBe("error")
  expect(activity.set(false)).toBe("error")
  expect(closed).toBe(false)
  fail = false
  expect(activity.set(false)).toBe("off")
  expect(ids).toEqual([0, 42])
  expect(releases).toEqual([42, 42])
  expect(closed).toBe(true)
})

test("activity reports unsupported platforms and missing native support without declaring activity", () => {
  const linux = UserActivity.make("linux", () => { throw new Error("Must not open") })
  expect(linux.set(true)).toBe("unsupported")
  expect(linux.set(false)).toBe("unsupported")
  expect(UserActivity.make("darwin", () => undefined).set(true)).toBe("unsupported")
  expect(UserActivity.make("darwin", () => { throw new Error("Native load failed") }).set(true)).toBe("error")
})

test("an initial declaration failure closes native resources when disabled", () => {
  let closed = false
  const activity = UserActivity.make("darwin", () => ({
    declare: () => ({ code: 1, id: 999 }),
    release: () => { throw new Error("No assertion was acquired") },
    close: () => { closed = true },
  }))
  expect(activity.set(true)).toBe("error")
  expect(activity.set(false)).toBe("off")
  expect(closed).toBe(true)
})

test("the Node activity bundle selects its bridge lazily and reports unavailable FFI", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-activity-node-"))
  try {
    const outfile = path.join(directory, "activity.mjs")
    const built = Bun.spawnSync([process.execPath, "build", new URL("../src/util/user-activity.ts", import.meta.url).pathname, "--target=node", "--format=esm", "--packages=bundle", `--outfile=${outfile}`])
    expect(built.exitCode).toBe(0)
    const result = Bun.spawnSync(["node", "--input-type=module", "-e", `
    import Module from "node:module";
    const load = Module._load;
    let loads = 0;
    Module._load = function(id, ...args) {
      if (id === "node:ffi") { loads++; throw new Error("Unavailable FFI"); }
      return load.call(this, id, ...args);
    };
    const bridge = await import(${JSON.stringify(`file://${outfile}`)});
    if (loads !== 0) throw new Error("FFI loaded during import");
    if (bridge.make("linux").set(true) !== "unsupported" || loads !== 0) throw new Error("Unsupported platform loaded FFI");
    const activity = bridge.make("darwin");
    if (activity.set(false) !== "off" || loads !== 0) throw new Error("Disabled activity loaded FFI");
    if (activity.set(true) !== "unsupported" || loads !== 1) throw new Error("Unavailable FFI was not reported");
  `])
    expect(result.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
