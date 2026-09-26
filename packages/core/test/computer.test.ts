import { describe, expect, test } from "bun:test"
import { Computer } from "@ycoding-ai/core/computer"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import { ElectronComputer } from "@ycoding-ai/core/computer/electron"
import { Node } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { AppProcess } from "@ycoding-ai/core/process"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { Cause, Context, DateTime, Effect, Exit, Fiber, Layer, PubSub, Schema, Scope, Stream } from "effect"
import path from "node:path"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { statSync } from "node:fs"

const owner = SessionV2.ID.make("ses_computer_owner")
const other = SessionV2.ID.make("ses_computer_other")
const target = {
  platform: "macos" as const,
  application: "iterm" as const,
  windowID: 41,
  tabIndex: 2,
  sessionID: "iterm-session-guid",
}
const desktop = {
  platform: "macos" as const,
  application: "desktop" as const,
  bundleID: "com.example.fixture",
  pid: 451,
  windowID: 73,
}
const browserWindow = {
  platform: "macos" as const,
  application: "webbrowser" as const,
  bundleID: "com.apple.Safari" as const,
  windowID: "17",
  tabIndex: 1,
}

describe("scoped desktop control", () => {
  test("surfaces a graceful-quit refusal instead of relaunching a running Electron app", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const locations = yield* makeLocationComputers(
        (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "" }),
        Stream.never, undefined,
        (action) => action === "desktop.launch"
          ? { status: "error" as const, code: "quit_pending" as const, message: "Save prompt is pending", outcome: "not_started" as const }
          : false,
      )
      const result = yield* locations.first.launch({ sessionID: owner, callID: "relaunch-pending", bundleID: desktop.bundleID,
        remoteDebugging: true }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "quit_pending", outcome: "not_started" })
      yield* locations.close
    })))
  })
  test("routes only off-Space Electron capture and pixels through the bridge, preserving native revisions", async () => {
    const routed: string[] = []
    const bridge = ElectronComputer.make({ appPath: async () => undefined, fuseBytes: async () => Buffer.alloc(0),
      ownedPorts: async () => [], signal: async () => {}, sleep: async () => {} })
    const injected = { ...bridge, isElectron: async () => true, perform: async (_target: typeof desktop, _window: { on_screen: boolean }, operation: ElectronComputer.Operation) => {
      routed.push(operation.type)
      return operation.type === "capture" ? { type: "capture" as const, image: "base64", width: 800, height: 500, scale: 1 }
        : { type: "action" as const, effect: "changed" as const }
    } }
    const processLayer = Layer.mock(AppProcess.Service, { run: (command) => Effect.promise(async () => {
      if (command._tag !== "StandardCommand") throw new Error("Expected native app launch")
      const requestFile = command.args.at(-2)
      const responseFile = command.args.at(-1)
      if (!requestFile || !responseFile) throw new Error("Missing native handoff")
      const request = Schema.decodeUnknownSync(Schema.Struct({ action: Schema.String }))(JSON.parse(await readFile(requestFile, "utf8")))
      const response = request.action === "desktop.list"
        ? { status: "ok", action: request.action, revision: "", apps: [{ bundle_id: desktop.bundleID, pid: desktop.pid,
          name: "Fixture", is_active: false, is_hidden: false, windows: [{ window_id: desktop.windowID, title: "Fixture",
            bounds: { x: 0, y: 0, width: 800, height: 500 }, on_screen: false }] }] }
        : { status: "ok", action: request.action, revision: "native-revision" }
      await writeFile(responseFile, JSON.stringify(response))
      return { command: "fixture", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false }
    }) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const context = yield* Layer.build(processLayer)
      const processes = Context.get(context, AppProcess.Service)
      const invoke = MacOSComputer.invokeWithBridge(processes, "darwin", MacOSComputer.applicationPath(), injected)
      const captured = yield* invoke({ action: "desktop.capture", owner: { sessionID: "s", callID: "c" }, target: desktop }, new AbortController().signal)
      expect(captured).toMatchObject({ revision: "native-revision", width: 800, image: "base64" })
      const clicked = yield* invoke({ action: "desktop.click", owner: { sessionID: "s", callID: "a" }, target: desktop,
        expectedRevision: "native-revision", x: 20, y: 30 }, new AbortController().signal)
      expect(clicked).toMatchObject({ revision: "native-revision", effect: "changed" })
      expect(routed).toEqual(["capture", "action"])
    })))
  })
  test("graceful quit invalidates all window claims for its pid even if exit is pending", async () => {
    const computer = Computer.make((request) => Effect.succeed({ status: "ok" as const,
      action: request.action, revision: "rev-before-quit", ...(request.action === "desktop.quit" ? { exited: false } : {}) }), "darwin")
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "before-quit", target: desktop }))
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "other-window", target: { ...desktop, windowID: 74 } }))
    expect(await Effect.runPromise(computer.quit({ sessionID: owner, callID: "quit", bundleID: desktop.bundleID, pid: desktop.pid }))).toMatchObject({ action: "desktop.quit", exited: false })
    const stale = await Effect.runPromiseExit(computer.act({ sessionID: owner, callID: "after-quit", target: { ...desktop, windowID: 74 },
      expectedRevision: "rev-before-quit", action: { type: "desktop.click", element: [0] } }))
    expect(Exit.isFailure(stale)).toBe(true)
    if (Exit.isFailure(stale)) expect(stale.cause.toString()).toContain("must be inspected")
  })
  test("remote-debugging relaunch releases prior app window claims", async () => {
    const computer = Computer.make((request) => Effect.succeed({ status: "ok" as const, action: request.action,
      revision: "rev-old", ...(request.action === "desktop.launch" ? { pid: desktop.pid, windows: [] } : {}) }), "darwin")
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "before-relaunch", target: desktop }))
    await Effect.runPromise(computer.launch({ sessionID: owner, callID: "remote-relaunch", bundleID: desktop.bundleID, remoteDebugging: true }))
    const stale = await Effect.runPromiseExit(computer.act({ sessionID: owner, callID: "after-relaunch", target: desktop,
      expectedRevision: "rev-old", action: { type: "desktop.click", x: 20, y: 30 } }))
    expect(Exit.isFailure(stale)).toBe(true)
    if (Exit.isFailure(stale)) expect(stale.cause.toString()).toContain("must be inspected")
  })
  test("decodes native app/window and capture metadata and treats invalid launch response as uncertain", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const windows = [{ window_id: 73, title: "Fixture", bounds: { x: 10, y: 20, width: 300, height: 200 }, on_screen: false }]
      const locations = yield* makeLocationComputers((request) => Effect.succeed({ status: "ok" as const,
        action: request.action, revision: "rev-native",
        ...(request.action === "desktop.list" ? { apps: [{ bundle_id: "com.example.fixture", pid: 451, name: "Fixture", is_active: false, is_hidden: false, windows }] } : {}),
        ...(request.action === "desktop.capture" ? { image: "jpeg", width: 300, height: 200, scale: 1 } : {}),
      }), Stream.never, undefined, (action) => action === "desktop.launch")
      const list = yield* locations.first.list({ sessionID: owner, callID: "list-response" })
      expect(list.apps?.[0]?.windows[0]).toEqual(windows[0])
      const capture = yield* locations.first.capture({ sessionID: owner, callID: "capture-response", target: desktop })
      expect(capture).toMatchObject({ width: 300, height: 200, scale: 1 })
      const launched = yield* locations.first.launch({ sessionID: owner, callID: "launch-response", bundleID: "com.example.fixture" }).pipe(Effect.exit)
      expect(Exit.isFailure(launched)).toBe(true)
      if (Exit.isFailure(launched)) expect(Cause.squash(launched.cause)).toMatchObject({ code: "unknown_outcome", outcome: "unknown" })
      yield* locations.close
    })))
  })
  test("decodes an AX-inaccessible Core Graphics window snapshot and keeps its revision claim", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const locations = yield* makeLocationComputers((request) => Effect.succeed({
        status: "ok" as const, action: request.action, revision: "cg-window-revision",
        ...(request.action === "desktop.inspect" ? { accessible: false, elements: [] } : {}),
      }))
      const inspected = yield* locations.first.inspect({ sessionID: owner, callID: "cg-only", target: desktop })
      expect(inspected).toMatchObject({ action: "desktop.inspect", accessible: false, elements: [], revision: "cg-window-revision" })
      const clicked = yield* locations.first.act({ sessionID: owner, callID: "cg-click", target: desktop,
        expectedRevision: inspected.revision, action: { type: "desktop.click", x: 20, y: 30 } })
      expect(clicked.revision).toBe("cg-window-revision")
      yield* locations.close
    })))
  })
  test("treats a failed focus restoration as an unknown mutation and requires reinspection", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const locations = yield* makeLocationComputers(
        (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-focus" }),
        Stream.never, undefined,
        (action) => action === "desktop.click"
          ? { status: "error" as const, code: "focus_restore_failed" as const, message: "Original foreground focus was not restored", outcome: "unknown" as const }
          : false,
      )
      yield* locations.first.inspect({ sessionID: owner, callID: "before-focus", target: desktop })
      const result = yield* locations.first.act({ sessionID: owner, callID: "focus-error", target: desktop,
        expectedRevision: "rev-focus", action: { type: "desktop.click", x: 20, y: 30 } }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "focus_restore_failed", outcome: "unknown" })
      const replay = yield* locations.first.act({ sessionID: owner, callID: "focus-replay", target: desktop,
        expectedRevision: "rev-focus", action: { type: "desktop.click", x: 20, y: 30 } }).pipe(Effect.exit)
      expect(Exit.isFailure(replay)).toBe(true)
      if (Exit.isFailure(replay)) expect(replay.cause.toString()).toContain("must be inspected")
      yield* locations.close
    })))
  })
  test.each(["changed", "unchanged", "unverified"] as const)("decodes the native pointer effect %s", async (effect) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const locations = yield* makeLocationComputers((request) => Effect.succeed({
        status: "ok" as const, action: request.action, revision: "rev-effect",
        ...(request.action === "desktop.click" ? { effect } : {}),
      }))
      yield* locations.first.inspect({ sessionID: owner, callID: `effect-inspect-${effect}`, target: desktop })
      const clicked = yield* locations.first.act({ sessionID: owner, callID: `effect-click-${effect}`, target: desktop,
        expectedRevision: "rev-effect", action: { type: "desktop.click", x: 20, y: 30 } })
      expect(clicked.effect).toBe(effect)
      yield* locations.close
    })))
  })
  test("desktop discovery does not claim a window; launch settlement ambiguity is unknown", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "desktop.launch")
        return Effect.fail(new Computer.NativeError({ code: "unknown_outcome", message: "uncertain", outcome: "unknown" }))
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev", apps: [] })
    }, "darwin")
    expect(await Effect.runPromise(computer.list({ sessionID: owner, callID: "list" }))).toMatchObject({ action: "desktop.list", apps: [] })
    const launch = await Effect.runPromiseExit(computer.launch({ sessionID: owner, callID: "launch", bundleID: "com.example.fixture" }))
    expect(Exit.isFailure(launch)).toBe(true)
    if (Exit.isFailure(launch)) expect(Cause.squash(launch.cause)).toMatchObject({ code: "unknown_outcome", outcome: "unknown" })
    expect(requests.map((request) => request.action)).toEqual(["desktop.list", "desktop.launch"])
    expect(await Effect.runPromise(computer.inspect({ sessionID: other, callID: "inspect-after-list", target: desktop }))).toMatchObject({ revision: "rev" })
  })

  test("serializes desktop mutations across different windows so focus scopes never overlap", async () => {
    const second = { ...desktop, pid: 452, windowID: 74 }
    const events: string[] = []
    const computer = Computer.make((request) =>
      request.action === "desktop.inspect"
        ? Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev" })
        : Effect.gen(function* () {
            events.push(`start:${request.action}`)
            yield* Effect.sleep("20 millis")
            events.push("end")
            return { status: "ok" as const, action: request.action, revision: "rev" }
          }),
      "darwin",
    )
    await Effect.runPromise(Effect.gen(function* () {
      yield* computer.inspect({ sessionID: owner, callID: "inspect-first", target: desktop })
      yield* computer.inspect({ sessionID: owner, callID: "inspect-second", target: second })
      yield* Effect.all([
        computer.act({ sessionID: owner, callID: "click-first", target: desktop, expectedRevision: "rev",
          action: { type: "desktop.click", x: 1, y: 1 } }),
        computer.act({ sessionID: owner, callID: "type-second", target: second, expectedRevision: "rev",
          action: { type: "desktop.type", text: "a" } }),
      ], { concurrency: "unbounded" })
    }))
    expect(events.filter((event) => event !== "end").length).toBe(2)
    expect(events.every((event, index) => (index % 2 === 0) === event.startsWith("start:"))).toBe(true)
  })

  test("maps pointer and key requests and retains native inspection geometry", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: `rev-${requests.length}`,
        elements: request.action === "desktop.inspect" ? [{ path: [], role: "AXWindow", label: "Fixture", frame: [0, 0, 300, 200], actions: ["press"], enabled: true, focused: false, value: "hello" }] : undefined,
      width: request.action === "desktop.capture" ? 300 : undefined,
      height: request.action === "desktop.capture" ? 200 : undefined,
      scale: request.action === "desktop.capture" ? 1 : undefined,
    })
    }, "darwin")
    const inspection = await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "inspect", target: desktop }))
    expect(inspection.elements?.[0]).toMatchObject({ frame: [0, 0, 300, 200], actions: ["press"], value: "hello" })
    const capture = await Effect.runPromise(computer.capture({ sessionID: owner, callID: "capture", target: desktop }))
    expect(capture).toMatchObject({ width: 300, height: 200, scale: 1 })
    const response = await Effect.runPromise(computer.act({ sessionID: owner, callID: "drag", target: desktop,
      expectedRevision: capture.revision, action: { type: "desktop.drag", fromX: 1, fromY: 2, toX: 30, toY: 40 } }))
    expect(response.revision).toBe("rev-3")
    expect(requests.at(-1)).toMatchObject({ action: "desktop.drag", fromX: 1, fromY: 2, toX: 30, toY: 40, expectedRevision: "rev-2" })
  })
  test("waits for the app response after LaunchServices returns", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers(
            (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-delayed" }),
            Stream.never,
            undefined,
            undefined,
            true,
          )
          expect(
            yield* locations.first.inspect({ sessionID: owner, callID: "delayed-app", target: desktop }),
          ).toMatchObject({ revision: "rev-delayed" })
          yield* locations.close
        }),
      ),
    )
  })
  test("uses a private LaunchServices handoff and removes it on settlement", async () => {
    const launched: string[] = []
    const modes: number[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers(
            (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-desktop" }),
            Stream.never,
            (args, signal) => {
              expect(signal).toBeUndefined()
              launched.push(...args)
              modes.push(statSync(path.dirname(args[5])).mode & 0o777, statSync(args[5]).mode & 0o777)
            },
          )
          expect(
            yield* locations.first.inspect({ sessionID: owner, callID: "desktop-app", target: desktop }),
          ).toMatchObject({ action: "desktop.inspect", revision: "rev-desktop" })
          expect(launched.slice(0, 5)).toEqual([
            "-n",
            "-g",
            "-a",
            path.resolve(import.meta.dir, "../.cache/computer-use/YCoding Computer Use.app"),
            "--args",
          ])
          expect(launched[5]).toEndWith("/request.json")
          expect(launched[6]).toEndWith("/response.json")
          expect(modes).toEqual([0o700, 0o600])
          yield* locations.close
        }),
      ),
    )
    expect(await stat(path.dirname(launched[5])).catch(() => undefined)).toBeUndefined()
  })
  test("launches iTerm and Finder requests through the YCoding Computer Use app", async () => {
    const launched: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers(
            (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-app" }),
            Stream.never,
            (args) => launched.push(args[3]),
          )
          yield* locations.first.inspect({ sessionID: owner, callID: "iterm-app", target })
          yield* locations.first.inspect({
            sessionID: owner,
            callID: "finder-app",
            target: { platform: "macos", application: "finder", path: "/workspace/fixture/file.txt" },
          })
          yield* locations.close
        }),
      ),
    )
    const application = path.resolve(import.meta.dir, "../.cache/computer-use/YCoding Computer Use.app")
    expect(launched).toEqual([application, application])
  })
  test("requires an exact inspected app/window revision and invalidates uncertain mutation", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "desktop.click")
        return Effect.fail(
          new Computer.NativeError({ code: "unknown_outcome", message: "uncertain", outcome: "unknown" }),
        )
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-desktop" })
    }, "darwin")
    expect(
      await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "observe", target: desktop })),
    ).toMatchObject({ action: "desktop.inspect" })
    const otherWindow = { ...desktop, windowID: 74 }
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          computer.act({
            sessionID: owner,
            callID: "wrong-window",
            target: otherWindow,
            expectedRevision: "rev-desktop",
            action: { type: "desktop.click", element: [0] },
          }),
        ),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          computer.act({
            sessionID: other,
            callID: "wrong-owner",
            target: desktop,
            expectedRevision: "rev-desktop",
            action: { type: "desktop.click", element: [0] },
          }),
        ),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          computer.act({
            sessionID: owner,
            callID: "click",
            target: desktop,
            expectedRevision: "rev-desktop",
            action: { type: "desktop.click", element: [0] },
          }),
        ),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          computer.act({
            sessionID: owner,
            callID: "retry",
            target: desktop,
            expectedRevision: "rev-desktop",
            action: { type: "desktop.click", element: [0] },
          }),
        ),
      ),
    ).toBe(true)
    expect(requests.map((request) => request.action)).toEqual(["desktop.inspect", "desktop.click"])
  })
  test("does not replay a desktop mutation when the launched app produces an invalid response", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers(
            (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-desktop" }),
            Stream.never,
            undefined,
            (action) => action === "desktop.click",
          )
          yield* locations.first.inspect({ sessionID: owner, callID: "desktop-observe", target: desktop })
          const first = yield* locations.first
            .act({
              sessionID: owner,
              callID: "desktop-act",
              target: desktop,
              expectedRevision: "rev-desktop",
              action: { type: "desktop.click", element: [0] },
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(first)).toBe(true)
          if (Exit.isFailure(first))
            expect(Cause.squash(first.cause)).toMatchObject({ code: "unknown_outcome", outcome: "unknown" })
          const replay = yield* locations.first
            .act({
              sessionID: owner,
              callID: "desktop-replay",
              target: desktop,
              expectedRevision: "rev-desktop",
              action: { type: "desktop.click", element: [0] },
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(replay)).toBe(true)
          if (Exit.isFailure(replay)) expect(replay.cause.toString()).toContain("must be inspected")
          yield* locations.close
        }),
      ),
    )
  })
})

describe("native computer helper resolution", () => {
  test("uses the explicit source-development build instead of writing beside Bun", () => {
    expect(MacOSComputer.applicationPath("/opt/homebrew/bin/bun")).toBe(
      path.resolve(import.meta.dir, "../.cache/computer-use/YCoding Computer Use.app"),
    )
    expect(MacOSComputer.applicationPath("/opt/homebrew/bin/bun.exe")).toBe(
      path.resolve(import.meta.dir, "../.cache/computer-use/YCoding Computer Use.app"),
    )
    expect(MacOSComputer.applicationPath("/opt/ycoding/bin/ycoding")).toBe("/opt/ycoding/bin/YCoding Computer Use.app")
  })
})

describe("native computer target ownership", () => {
  test("holds one private display owner for multiple staged windows and stops it after the last unstage", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "display.hold")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "", display: { id: 91, x: -1280, y: 0, width: 1280, height: 800 } })
      if (request.action === "desktop.inspect")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: `rev-${request.target.windowID}`, elements: [] })
      if (request.action === "desktop.stage")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: `staged-${request.target.windowID}`, originalFrame: { x: 20, y: 30, width: 600, height: 400 } })
      if (request.action === "desktop.unstage") return Effect.succeed({ status: "ok" as const, action: request.action, revision: `unstaged-${request.target.windowID}` })
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "" })
    }, "darwin")
    const secondWindow = { ...desktop, windowID: 74 }
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "inspect-73", target: desktop }))
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "inspect-74", target: secondWindow }))
    await Effect.runPromise(computer.stage({ sessionID: owner, callID: "stage-73", target: desktop, expectedRevision: "rev-73" }))
    await Effect.runPromise(computer.stage({ sessionID: owner, callID: "stage-74", target: secondWindow, expectedRevision: "rev-74" }))
    expect(requests.filter((request) => request.action === "display.hold")).toHaveLength(1)
    expect(requests.filter((request) => request.action === "desktop.stage").map((request) => request.action === "desktop.stage" ? request.display : undefined)).toEqual([
      { x: -1280, y: 0, width: 1280, height: 800 },
      { x: -1280, y: 0, width: 1280, height: 800 },
    ])
    expect(await Effect.runPromise(computer.unstage({ sessionID: owner, callID: "unstage-73", target: desktop }))).toMatchObject({ revision: "unstaged-73" })
    const controlDirectory = requests.find((request) => request.action === "display.hold")?.controlDirectory
    expect(controlDirectory).toBeString()
    if (!controlDirectory) throw new Error("Display owner request omitted its control directory")
    expect(await stat(path.join(controlDirectory, "stop")).then(() => true, () => false)).toBe(false)
    await Effect.runPromise(computer.unstage({ sessionID: owner, callID: "unstage-74", target: secondWindow }))
    expect(requests.filter((request) => request.action === "desktop.unstage").map((request) => request.action === "desktop.unstage" ? request.originalFrame : undefined)).toEqual([
      { x: 20, y: 30, width: 600, height: 400 },
      { x: 20, y: 30, width: 600, height: 400 },
    ])
    expect(await stat(path.join(controlDirectory, "stop")).then(() => true, () => false)).toBe(true)
    await rm(controlDirectory, { recursive: true, force: true })
  })

  test("releaseSession restores only its staged windows", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "display.hold")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "", display: { id: 92, x: -1280, y: 0, width: 1280, height: 800 } })
      if (request.action === "desktop.inspect")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: `rev-${request.target.windowID}`, elements: [] })
      if (request.action === "desktop.stage")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: `staged-${request.target.windowID}`, originalFrame: { x: 0, y: 0, width: 500, height: 300 } })
      if (request.action === "desktop.unstage") return Effect.succeed({ status: "ok" as const, action: request.action, revision: `unstaged-${request.target.windowID}` })
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "" })
    }, "darwin")
    const otherWindow = { ...desktop, windowID: 74 }
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "inspect-owner", target: desktop }))
    await Effect.runPromise(computer.inspect({ sessionID: other, callID: "inspect-other", target: otherWindow }))
    await Effect.runPromise(computer.stage({ sessionID: owner, callID: "stage-owner", target: desktop, expectedRevision: "rev-73" }))
    await Effect.runPromise(computer.stage({ sessionID: other, callID: "stage-other", target: otherWindow, expectedRevision: "rev-74" }))
    await Effect.runPromise(computer.releaseSession(owner))
    expect(requests.filter((request) => request.action === "desktop.unstage").map((request) => request.action === "desktop.unstage" ? request.target.windowID : undefined)).toEqual([73])
    await Effect.runPromise(computer.unstage({ sessionID: other, callID: "unstage-other", target: otherWindow }))
    const controlDirectory = requests.find((request) => request.action === "display.hold")?.controlDirectory
    if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true })
  })

  test("drops a stale staged-window record when native restoration reports a missing target", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "display.hold")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "", display: { id: 95, x: -1280, y: 0, width: 1280, height: 800 } })
      if (request.action === "desktop.inspect") return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-73", elements: [] })
      if (request.action === "desktop.stage")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "staged-73", originalFrame: { x: 0, y: 0, width: 500, height: 300 } })
      if (request.action === "desktop.unstage")
        return Effect.fail(new Computer.NativeError({ code: "target_not_found", message: "window disappeared", outcome: "not_started" }))
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "" })
    }, "darwin")
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "inspect-73", target: desktop }))
    await Effect.runPromise(computer.stage({ sessionID: owner, callID: "stage-73", target: desktop, expectedRevision: "rev-73" }))
    const result = await Effect.runPromiseExit(computer.unstage({ sessionID: owner, callID: "unstage-73", target: desktop }))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "target_not_found", outcome: "not_started" })
    await Effect.runPromise(computer.releaseSession(owner))
    expect(requests.filter((request) => request.action === "desktop.unstage")).toHaveLength(1)
    const controlDirectory = requests.find((request) => request.action === "display.hold")?.controlDirectory
    if (!controlDirectory) throw new Error("Display owner request omitted its control directory")
    expect(await stat(path.join(controlDirectory, "stop")).then(() => true, () => false)).toBe(true)
    await rm(controlDirectory, { recursive: true, force: true })
  })

  test("location scope finalization restores every staged window and stops its display owner", async () => {
    const requests: Array<typeof fixtureRequest.Type> = []
    let controlDirectory: string | undefined
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const locations = yield* makeLocationComputers((request) => {
        requests.push(request)
        if (request.action === "display.hold") {
          controlDirectory = request.controlDirectory
          return Effect.succeed({ status: "ok" as const, action: request.action, revision: "", display: { id: 94, x: -1280, y: 0, width: 1280, height: 800 } })
        }
        if (request.action === "desktop.inspect") return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-73", elements: [] })
        if (request.action === "desktop.stage") return Effect.succeed({ status: "ok" as const, action: request.action, revision: "staged-73", originalFrame: { x: 10, y: 20, width: 500, height: 300 } })
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "unstaged-73" })
      })
      yield* locations.first.inspect({ sessionID: owner, callID: "scope-inspect", target: desktop })
      yield* locations.first.stage({ sessionID: owner, callID: "scope-stage", target: desktop, expectedRevision: "rev-73" })
      yield* locations.close
      expect(requests.filter((request) => request.action === "desktop.unstage")).toHaveLength(1)
      const directory = controlDirectory
      expect(directory).toBeString()
      if (!directory) throw new Error("Display owner request omitted its control directory")
      expect(yield* Effect.promise(() => stat(path.join(directory, "stop")).then(() => true, () => false))).toBe(true)
    })))
    if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true })
  })

  test("rejects a stale stage revision before display startup or native movement", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-current", elements: [] })
    }, "darwin")
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "stage-current", target: desktop }))
    const stale = await Effect.runPromiseExit(computer.stage({ sessionID: owner, callID: "stage-stale", target: desktop, expectedRevision: "rev-stale" }))
    expect(Exit.isFailure(stale)).toBe(true)
    expect(requests.map((request) => request.action)).toEqual(["desktop.inspect"])
  })

  test("fails stage with not_started when the display owner does not return its bounds", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "display.hold")
        return Effect.fail(new Computer.NativeError({ code: "background_unavailable", message: "display unavailable", outcome: "not_started" }))
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1", elements: [] })
    }, "darwin")
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "owner-inspect", target: desktop }))
    const result = await Effect.runPromiseExit(computer.stage({ sessionID: owner, callID: "owner-stage", target: desktop, expectedRevision: "rev-1" }))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "background_unavailable", outcome: "not_started" })
    expect(requests.map((request) => request.action)).toEqual(["desktop.inspect", "display.hold"])
  })

  test("invalidates a stage claim after an unknown native outcome", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "display.hold")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "", display: { id: 93, x: -1280, y: 0, width: 1280, height: 800 } })
      if (request.action === "desktop.inspect")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1", elements: [] })
      return Effect.fail(new Computer.NativeError({ code: "unknown_outcome", message: "uncertain stage", outcome: "unknown" }))
    }, "darwin")
    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "unknown-inspect", target: desktop }))
    const unknown = await Effect.runPromiseExit(computer.stage({ sessionID: owner, callID: "unknown-stage", target: desktop, expectedRevision: "rev-1" }))
    expect(Exit.isFailure(unknown)).toBe(true)
    const replay = await Effect.runPromiseExit(computer.stage({ sessionID: owner, callID: "stage-replay", target: desktop, expectedRevision: "rev-1" }))
    expect(Exit.isFailure(replay)).toBe(true)
    expect(requests.map((request) => request.action)).toEqual(["desktop.inspect", "display.hold", "desktop.stage"])
    const controlDirectory = requests.find((request) => request.action === "display.hold")?.controlDirectory
    if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true })
  })

  test("encodes browser JavaScript as a typed request value", () => {
    const script = "document.title = 'typed value'"
    const request = MacOSComputer.browserActionRequest({ sessionID: owner, callID: "eval" }, browserWindow, "rev-1", { type: "webbrowser.eval", script })
    expect(JSON.parse(JSON.stringify(request))).toEqual({
      action: "webbrowser.eval",
      owner: { sessionID: owner, callID: "eval" },
      target: browserWindow,
      expectedRevision: "rev-1",
      script,
    })
  })

  test("writes browser URL and JavaScript as separate typed helper request fields", async () => {
    const requests: Array<typeof fixtureRequest.Type> = []
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const locations = yield* makeLocationComputers((request) => {
        requests.push(request)
        return Effect.succeed({
          status: "ok" as const,
          action: request.action,
          revision: "rev-2",
          ...(request.action === "webbrowser.tabs" ? { browserWindows: [{ window_id: "17", index: 1, revision: "rev-1", tabs: [{ index: 1, title: "Fixture", url: "https://example.com", active: true }] }] } : {}),
        })
      })
      yield* locations.first.browserTabs({ sessionID: owner, callID: "browser-list", bundleID: "com.apple.Safari" })
      yield* locations.first.browserAct({ sessionID: owner, callID: "browser-eval", target: browserWindow, expectedRevision: "rev-1", action: { type: "webbrowser.eval", script: "document.title = 'safe'" } })
      expect(requests[0]).toMatchObject({ action: "webbrowser.tabs", bundleID: "com.apple.Safari" })
      expect(requests[1]).toMatchObject({ action: "webbrowser.eval", target: browserWindow, expectedRevision: "rev-1", script: "document.title = 'safe'" })
      yield* locations.close
    })))
  })

  test("claims browser windows per Session, chains settled revisions, and invalidates uncertain mutations", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      if (request.action === "webbrowser.tabs")
        return Effect.succeed({ status: "ok" as const, action: request.action, revision: "", browserWindows: [{ window_id: "17", index: 1, revision: "rev-1", tabs: [{ index: 1, title: "A", url: "https://example.com", active: true }] }] })
      if (request.action === "webbrowser.navigate" && request.url === "unknown")
        return Effect.fail(new Computer.NativeError({ code: "unknown_outcome", message: "uncertain", outcome: "unknown" }))
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-2" })
    }, "darwin")
    expect(await Effect.runPromise(computer.browserTabs({ sessionID: owner, callID: "browser-tabs", bundleID: "com.apple.Safari" }))).toMatchObject({ browserWindows: [{ window_id: "17", revision: "rev-1" }] })
    expect(Exit.isFailure(await Effect.runPromiseExit(computer.browserAct({ sessionID: other, callID: "other-owner", target: browserWindow, expectedRevision: "rev-1", action: { type: "webbrowser.back" } })))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(computer.browserAct({ sessionID: owner, callID: "stale", target: browserWindow, expectedRevision: "stale", action: { type: "webbrowser.back" } })))).toBe(true)
    expect(await Effect.runPromise(computer.browserAct({ sessionID: owner, callID: "navigate", target: browserWindow, expectedRevision: "rev-1", action: { type: "webbrowser.navigate", url: "https://example.com" } }))).toMatchObject({ revision: "rev-2" })
    const uncertain = await Effect.runPromiseExit(computer.browserAct({ sessionID: owner, callID: "unknown", target: browserWindow, expectedRevision: "rev-2", action: { type: "webbrowser.navigate", url: "unknown" } }))
    expect(Exit.isFailure(uncertain)).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(computer.browserAct({ sessionID: owner, callID: "no-replay", target: browserWindow, expectedRevision: "rev-2", action: { type: "webbrowser.back" } })))).toBe(true)
    expect(requests.map((request) => request.action)).toEqual(["webbrowser.tabs", "webbrowser.navigate", "webbrowser.navigate"])
    expect(requests[1]).toMatchObject({ target: browserWindow, expectedRevision: "rev-1", url: "https://example.com" })
  })

  test("fences one host target across distinct Location service instances", async () => {
    const started = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<Computer.NativeSuccess>()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers((request) => {
            if (request.owner.callID !== "call-active")
              return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-other" })
            return Effect.promise(() => {
              started.resolve()
              return settled.promise
            })
          })
          const active = Effect.runPromiseExit(
            locations.first.inspect({ sessionID: owner, callID: "call-active", target }),
          )
          yield* Effect.promise(() => started.promise)

          const concurrent = yield* locations.second
            .inspect({ sessionID: other, callID: "call-concurrent", target })
            .pipe(Effect.exit)
          expect(Exit.isFailure(concurrent)).toBe(true)

          settled.resolve({ status: "ok", action: "iterm.inspect", revision: "rev-owner" })
          expect(Exit.isSuccess(yield* Effect.promise(() => active))).toBe(true)
          yield* locations.close
        }),
      ),
    )
  })

  test("releases only the disposed Location and releases moved Sessions", async () => {
    const lifecycleEvents = yieldPubSub()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers(
            (request) =>
              Effect.succeed({ status: "ok" as const, action: request.action, revision: request.owner.callID }),
            Stream.fromPubSub(lifecycleEvents),
          )
          yield* locations.first.inspect({ sessionID: owner, callID: "first-claim", target })
          yield* Scope.close(locations.firstScope, Exit.void)
          yield* locations.second.inspect({ sessionID: other, callID: "second-claim", target })

          const third = yield* locations.acquire()
          yield* Scope.close(third.scope, Exit.void)
          const stillOwned = yield* locations
            .acquire()
            .pipe(
              Effect.flatMap((service) =>
                service.computer
                  .inspect({ sessionID: owner, callID: "after-unrelated-dispose", target })
                  .pipe(Effect.ensuring(Scope.close(service.scope, Exit.void)), Effect.exit),
              ),
            )
          expect(Exit.isFailure(stillOwned)).toBe(true)

          yield* PubSub.publish(lifecycleEvents, {
            id: EventV2.ID.create(),
            type: SessionEvent.Moved.type,
            created: DateTime.makeUnsafe(0),
            durable: {
              aggregateID: other,
              seq: EventV2.Seq.make(0),
              version: EventV2.Version.make(SessionEvent.Moved.durable.version),
            },
            data: { sessionID: other, location: { directory: AbsolutePath.make("/tmp/computer-moved") } },
          } satisfies EventV2.Payload<typeof SessionEvent.Moved>)
          yield* Effect.yieldNow
          const afterMove = yield* locations
            .acquire()
            .pipe(
              Effect.flatMap((service) =>
                service.computer
                  .inspect({ sessionID: owner, callID: "after-move", target })
                  .pipe(Effect.ensuring(Scope.close(service.scope, Exit.void))),
              ),
            )
          expect(afterMove.revision).toBe("after-move")
          yield* locations.close
        }),
      ),
    )
  })

  test.each(["cancel", "release"] as const)(
    "keeps a native target fenced after %s until settlement and discards late success",
    async (operation) => {
      const started = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<Computer.NativeSuccess>()
      const computer = Computer.make((request) => {
        if (request.owner.callID !== "call-active")
          return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" })
        return Effect.promise(() => {
          started.resolve()
          return settled.promise
        })
      }, "darwin")
      const active = Effect.runPromiseExit(computer.inspect({ sessionID: owner, callID: "call-active", target }))
      await started.promise
      await Effect.runPromise(
        operation === "cancel"
          ? computer.cancel({ sessionID: owner, callID: "call-active" }).pipe(Effect.asVoid)
          : computer.releaseSession(owner),
      )
      const concurrent = await Effect.runPromiseExit(
        computer.inspect({ sessionID: other, callID: "call-concurrent", target }),
      )
      settled.resolve({ status: "ok", action: "iterm.inspect", revision: "late-revision" })
      const cancelled = await active
      expect(Exit.isFailure(concurrent)).toBe(true)
      expect(Exit.isFailure(cancelled)).toBe(true)
      const stale = await Effect.runPromiseExit(
        computer.act({
          sessionID: owner,
          callID: "call-stale",
          target,
          expectedRevision: "late-revision",
          action: { type: "iterm.send_text", text: "safe", newline: false },
        }),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      expect(
        await Effect.runPromise(computer.inspect({ sessionID: other, callID: "call-next", target })),
      ).toMatchObject({ revision: "rev-1" })
    },
  )

  test("requires the observing Session to own a target and match its revision", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      return Effect.succeed({
        status: "ok" as const,
        action: request.action,
        revision: request.action === "iterm.send_text" ? "rev-2" : "rev-1",
      })
    })

    expect(
      await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "call-inspect", target })),
    ).toMatchObject({ revision: "rev-1" })

    const crossSession = await Effect.runPromiseExit(
      computer.inspect({ sessionID: other, callID: "call-other", target }),
    )
    expect(Exit.isFailure(crossSession)).toBe(true)
    if (Exit.isFailure(crossSession))
      expect(crossSession.cause.toString()).toContain("Target is owned by another Session")

    const stale = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-stale",
        target,
        expectedRevision: "stale",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(stale)).toBe(true)
    expect(requests).toHaveLength(1)

    expect(
      await Effect.runPromise(
        computer.act({
          sessionID: owner,
          callID: "call-send",
          target,
          expectedRevision: "rev-1",
          action: { type: "iterm.send_text", text: "printf safe", newline: true },
        }),
      ),
    ).toMatchObject({ revision: "rev-2" })
    expect(requests.at(-1)).toMatchObject({
      action: "iterm.send_text",
      owner: { sessionID: owner, callID: "call-send" },
      expectedRevision: "rev-1",
    })
  })

  test("invalidates a claim after an uncertain native result", async () => {
    const computer = Computer.make((request) =>
      request.action === "iterm.inspect"
        ? Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" })
        : Effect.fail(
            new Computer.NativeError({
              code: "unknown_outcome",
              message: "The native command may have been accepted",
              outcome: "unknown",
            }),
          ),
    )

    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "call-inspect", target }))
    const uncertain = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-send",
        target,
        expectedRevision: "rev-1",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(uncertain)).toBe(true)
    if (Exit.isFailure(uncertain)) expect(uncertain.cause.toString()).toContain("may have been accepted")

    const replay = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-replay",
        target,
        expectedRevision: "rev-1",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(replay)).toBe(true)
    if (Exit.isFailure(replay)) expect(replay.cause.toString()).toContain("must be inspected")
  })

  test("filters capabilities and fails safely before native invocation on unsupported platforms", async () => {
    let invoked = false
    const computer = Computer.make((request) => {
      invoked = true
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" })
    }, "linux")

    expect(await Effect.runPromise(computer.status)).toEqual({
      platform: "linux",
      state: "unsupported",
      capabilities: [],
    })
    const unsupported = await Effect.runPromiseExit(
      computer.inspect({ sessionID: owner, callID: "call-unsupported", target }),
    )
    expect(Exit.isFailure(unsupported)).toBe(true)
    if (Exit.isFailure(unsupported))
      expect(Cause.squash(unsupported.cause)).toMatchObject({ code: "unsupported_platform" })
    expect(invoked).toBe(false)

    const supported = Computer.make(
      (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" }),
      "darwin",
    )
    const supportedStatus = await Effect.runPromise(supported.status)
    expect(supportedStatus.platform).toBe("macos")
    expect(supportedStatus.capabilities).toEqual([
      {
        platform: "macos",
        application: "iterm",
        identity: { kind: "macos.bundle_id", value: "com.googlecode.iterm2" },
        operations: ["inspect", "send_text"],
      },
      {
        platform: "macos",
        application: "finder",
        identity: { kind: "macos.bundle_id", value: "com.apple.finder" },
        operations: ["inspect", "move"],
      },
      {
        platform: "macos",
        application: "desktop",
        identity: { kind: "macos.bundle_id", value: "explicit-running-app" },
        operations: ["list", "launch", "inspect", "capture", "click", "drag", "type", "scroll", "key", "stage", "unstage"],
      },
      {
        platform: "macos",
        application: "webbrowser",
        identity: { kind: "macos.bundle_id", value: "com.apple.Safari,com.google.Chrome" },
        operations: ["tabs", "navigate", "back", "forward", "reload", "new_tab", "close_tab", "eval"],
      },
    ])
  })

  test("revokes stale ownership and aborts an active call", async () => {
    let signal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const computer = Computer.make((request, inputSignal) =>
      request.action === "iterm.inspect" && request.owner.callID === "call-active"
        ? Effect.tryPromise({
            try: () =>
              new Promise<Computer.NativeSuccess>((_resolve, reject) => {
                signal = inputSignal
                started.resolve()
                inputSignal.addEventListener("abort", () => reject(inputSignal.reason), { once: true })
              }),
            catch: () =>
              new Computer.NativeError({
                code: "helper_unavailable",
                message: "cancelled",
                outcome: "not_started",
              }),
          })
        : Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" }),
    )

    const fiber = Effect.runFork(computer.inspect({ sessionID: owner, callID: "call-active", target }))
    await started.promise
    expect(await Effect.runPromise(computer.cancel({ sessionID: owner, callID: "call-active" }))).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)

    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "call-inspect", target }))
    await Effect.runPromise(computer.releaseSession(owner))
    const revoked = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-revoked",
        target,
        expectedRevision: "rev-1",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(revoked)).toBe(true)
    if (Exit.isFailure(revoked)) expect(revoked.cause.toString()).toContain("must be inspected")
  })
})

function yieldPubSub() {
  return Effect.runSync(PubSub.unbounded<EventV2.Payload>())
}

const fixtureRequest = Schema.Struct({
  action: Schema.Literals([
    "iterm.inspect",
    "iterm.send_text",
    "finder.inspect",
    "finder.move",
    "desktop.inspect",
    "desktop.list",
    "desktop.launch",
    "desktop.quit",
    "desktop.capture",
    "desktop.click",
    "desktop.drag",
    "desktop.type",
    "desktop.scroll",
    "desktop.key",
    "webbrowser.tabs",
    "webbrowser.navigate",
    "webbrowser.back",
    "webbrowser.forward",
    "webbrowser.reload",
    "webbrowser.new_tab",
    "webbrowser.close_tab",
    "webbrowser.eval",
    "display.hold",
    "desktop.stage",
    "desktop.unstage",
  ]),
  owner: Schema.Struct({ callID: Schema.String }),
  target: Schema.Unknown.pipe(Schema.optional),
  bundleID: Schema.String.pipe(Schema.optional),
  expectedRevision: Schema.String.pipe(Schema.optional),
  url: Schema.String.pipe(Schema.optional),
  script: Schema.String.pipe(Schema.optional),
  controlDirectory: Schema.String.pipe(Schema.optional),
  ownerPID: Schema.Int.pipe(Schema.optional),
  display: Schema.Unknown.pipe(Schema.optional),
  originalFrame: Schema.Unknown.pipe(Schema.optional),
})
const decodeFixtureRequest = Schema.decodeUnknownSync(Schema.fromJsonString(fixtureRequest))

function makeLocationComputers(
  invoke: (
    request: typeof fixtureRequest.Type,
    signal: AbortSignal,
  ) => Effect.Effect<Computer.NativeSuccess, Computer.NativeError>,
  events: Stream.Stream<EventV2.Payload> = Stream.never,
  onLaunch?: (args: ReadonlyArray<string>, signal?: AbortSignal) => void,
  invalidResponse?: (action: typeof fixtureRequest.Type.action) => boolean | {
    readonly status: "error"
    readonly code: "focus_restore_failed" | "quit_pending" | "background_unavailable" | "stale_revision" | "unknown_outcome" | "target_not_found"
    readonly message: string
    readonly outcome: "unknown" | "not_started"
  },
  respondAfterOpen = false,
) {
  const processLayer = Layer.mock(AppProcess.Service, {
    run: (command, options) =>
      Effect.suspend(() => {
        if (command._tag === "StandardCommand" && command.command === "/usr/bin/open") {
          onLaunch?.(command.args, options?.signal)
          const requestFile = command.args.at(-2)
          const responseFile = command.args.at(-1)
          if (!requestFile || !responseFile) return Effect.die(new Error("Missing desktop handoff paths"))
          return Effect.promise(() => readFile(requestFile, "utf8")).pipe(
            Effect.map(decodeFixtureRequest),
            Effect.flatMap((request) => invoke(request, new AbortController().signal)),
            Effect.flatMap((response) => {
              const override = invalidResponse?.(response.action)
              return override
                ? Effect.promise(() => writeFile(responseFile, JSON.stringify(override === true ? {} : override)))
                : respondAfterOpen
                  ? Effect.sync(() => {
                      setTimeout(() => {
                        void writeFile(responseFile, JSON.stringify(response))
                      }, 10)
                    })
                  : Effect.promise(() => writeFile(responseFile, JSON.stringify(response)))
            }),
            Effect.map(() => ({
              command: "computer-fixture",
              exitCode: 0,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
            Effect.mapError((error) => new AppProcess.AppProcessError({ command: "computer-fixture", cause: error })),
          )
        }
        return Effect.die(new Error("Computer fixture accepts only the LaunchServices app handoff"))
      }),
  })
  const split = LayerNode.hoist(Computer.node, Node.tags.values.global, [
    [AppProcess.node, processLayer],
    [EventV2.node, Layer.mock(EventV2.Service, { subscribe: () => events })],
  ])

  return Effect.gen(function* () {
    const globals = yield* Layer.build(LayerNode.compile(split.hoisted))
    const location = LayerNode.compile(split.node).pipe(Layer.provide(Layer.succeedContext(globals)), Layer.fresh)
    const acquire = Effect.fnUntraced(function* () {
      const scope = yield* Scope.make()
      const computer = Context.get(yield* Layer.buildWithScope(location, scope), Computer.Service)
      return { computer, scope }
    })
    const first = yield* acquire()
    const second = yield* acquire()
    return {
      first: first.computer,
      firstScope: first.scope,
      second: second.computer,
      acquire,
      close: Scope.close(first.scope, Exit.void).pipe(Effect.andThen(Scope.close(second.scope, Exit.void))),
    }
  })
}
