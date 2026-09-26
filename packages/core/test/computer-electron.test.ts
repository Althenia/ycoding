import { describe, expect, test } from "bun:test"
import { ElectronComputer } from "@ycoding-ai/core/computer/electron"
import { PhotonImage } from "@silvia-odwyer/photon-node"
import { Schema } from "effect"

const target = { platform: "macos" as const, application: "desktop" as const, bundleID: "com.example.electron", pid: 4321, windowID: 73 }
const window = { window_id: 73, title: "Fixture", bounds: { x: 100, y: 200, width: 800, height: 500 }, on_screen: false }
const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX")
const fused = (flags: string) => Buffer.concat([Buffer.from("binary"), sentinel, Buffer.from([1, flags.length]), Buffer.from(flags)])
const parseCommand = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number, method: Schema.String.pipe(Schema.optional),
  params: Schema.Struct({ expression: Schema.String.pipe(Schema.optional), x: Schema.Number.pipe(Schema.optional),
    y: Schema.Number.pipe(Schema.optional) }).pipe(Schema.optional) }))

describe("Electron computer bridge", () => {
  test("reads the inspect fuse only from a bounded versioned fuse record", () => {
    expect(ElectronComputer.inspectFuse(fused("0001000"))).toBe("on")
    expect(ElectronComputer.inspectFuse(fused("0000000"))).toBe("off")
    expect(ElectronComputer.inspectFuse(fused("000r000"))).toBe("removed")
    expect(ElectronComputer.inspectFuse(Buffer.from("plain executable"))).toBe("absent")
    expect(ElectronComputer.inspectFuse(Buffer.concat([sentinel, Buffer.from([2, 7]), Buffer.from("0001000")]))).toBe("absent")
  })

  test("maps capture pixels to content DIPs without targeting window chrome", () => {
    expect(ElectronComputer.contentPoint(window.bounds, { x: 100, y: 222, width: 800, height: 478 }, 0.5, 20, 30)).toEqual({ x: 40, y: 38 })
    expect(() => ElectronComputer.contentPoint(window.bounds, { x: 100, y: 222, width: 800, height: 478 }, 0.5, 20, 5)).toThrow()
  })

  test("matches the exact CG window media-source identity", () => {
    expect(ElectronComputer.mediaSourceWindow("window:73:0", target.windowID)).toBe(true)
    expect(ElectronComputer.mediaSourceWindow("window:74:0", target.windowID)).toBe(false)
    expect(ElectronComputer.mediaSourceWindow("window:73:1", target.windowID)).toBe(false)
  })

  test.each([fused("0000000"), fused("000r000"), Buffer.from("no fuse")])("never signals a fuse-off/removed/absent app without owned renderer CDP", async (bytes) => {
    const signals: number[] = []
    const bridge = ElectronComputer.make({
      appPath: async () => "/Applications/Fixture.app", fuseBytes: async () => bytes,
      ownedPorts: async () => [], signal: async (pid) => { signals.push(pid) }, sleep: async () => {},
    })
    expect(await bridge.perform(target, window, { type: "capture" })).toBeUndefined()
    expect(signals).toEqual([])
  })

  test("per-call inspector closes on exact-match failure and reports a failed close", async () => {
    const signals: number[] = []
    let opened = false
    let closed = false
    let refuseClose = false
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/json/list")
          return Response.json([{ type: "node", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/ws` }])
        return server.upgrade(request) ? undefined : new Response("not found", { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const command = parseCommand(JSON.parse(String(message)))
          if (command.params?.expression?.includes("inspector').close()")) {
            if (!refuseClose) closed = true
            return
          }
          ws.send(JSON.stringify({ id: command.id, result: { result: { value: null } } }))
        },
      },
    })
    try {
      const bridge = ElectronComputer.make({
        appPath: async () => "/Applications/Fixture.app",
        fuseBytes: async () => fused("0001000"),
        ownedPorts: async () => opened && !closed ? [server.port ?? 0] : [],
        signal: async (pid) => { signals.push(pid); opened = true },
        sleep: async () => {},
      })
      expect(await bridge.perform(target, window, { type: "capture" }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: "target_not_found" })
      expect(closed).toBe(true)
      expect(signals).toEqual([target.pid])
      opened = false
      closed = false
      refuseClose = true
      expect(await bridge.perform(target, window, { type: "capture" }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: "inspector_close_failed", outcome: "unknown" })
    } finally {
      await server.stop(true)
    }
  })

  test("captures and acts on an exact main-process window with a content offset, then closes the inspector", async () => {
    let opened = false
    let closed = false
    let clicked = false
    const png = (color: number) => {
      const image = new PhotonImage(new Uint8Array(Array.from({ length: 4 * 4 }, () => [color, 0, 0, 255]).flat()), 4, 4)
      try { return `data:image/png;base64,${Buffer.from(image.get_bytes()).toString("base64")}` }
      finally { image.free() }
    }
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/json/list") return Response.json([{ type: "node", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/ws` }])
        return server.upgrade(request) ? undefined : new Response("missing", { status: 404 })
      },
      websocket: { message(ws, message) {
        const command = parseCommand(JSON.parse(String(message)))
        const expression = command.params?.expression ?? ""
        if (expression.includes("inspector').close()")) { closed = true; return }
        const value = expression.includes("getContentBounds")
          ? { bounds: window.bounds, content: { x: 100, y: 222, width: 800, height: 478 } }
          : expression.includes("capturePage") ? png(clicked ? 200 : 100)
            : expression.includes("sendInputEvent") ? (clicked = true) : null
        ws.send(JSON.stringify({ id: command.id, result: { result: { value } } }))
      } },
    })
    try {
      const bridge = ElectronComputer.make({ appPath: async () => "/Applications/Fixture.app",
        fuseBytes: async () => fused("0001000"), ownedPorts: async () => opened && !closed ? [server.port ?? 0] : [],
        signal: async () => { opened = true; closed = false }, sleep: async () => {} })
      const captured = await bridge.perform(target, window, { type: "capture" })
      expect(captured).toMatchObject({ type: "capture", width: 800, height: 500, scale: 1 })
      if (captured?.type === "capture") {
        const decoded = PhotonImage.new_from_byteslice(Buffer.from(captured.image, "base64"))
        try {
          const pixels = decoded.get_raw_pixels()
          expect(pixels[(5 * 800 + 40) * 4]).toBeLessThan(10)
          expect(pixels[(60 * 800 + 40) * 4]).toBeGreaterThan(50)
        } finally { decoded.free() }
      }
      expect(closed).toBe(true)
      opened = false
      closed = false
      const acted = await bridge.perform(target, window, { type: "action", action: { type: "desktop.click", x: 40, y: 60 } })
      expect(acted).toEqual({ type: "action", effect: "changed" })
      expect(closed).toBe(true)
    } finally { await server.stop(true) }
  })

  test("uses only a pid-owned exact renderer endpoint and never sends SIGUSR1 for a fuse-off app", async () => {
    let signals = 0
    let changed = false
    const dispatched: Array<{ method: string; params?: { x?: number; y?: number } }> = []
    const image = new PhotonImage(new Uint8Array([250, 0, 0, 255]), 1, 1)
    const png = Buffer.from(image.get_bytes()).toString("base64")
    image.free()
    const changedImage = new PhotonImage(new Uint8Array([50, 0, 0, 255]), 1, 1)
    const changedPNG = Buffer.from(changedImage.get_bytes()).toString("base64")
    changedImage.free()
    let title = "Fixture"
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/json/list") return Response.json([{ type: "page", id: "page-1", title, webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/ws` }])
        return server.upgrade(request) ? undefined : new Response("missing", { status: 404 })
      },
      websocket: { message(ws, message) {
        const command = parseCommand(JSON.parse(String(message)))
        if (command.method?.startsWith("Input.")) {
          changed = true
          dispatched.push({ method: command.method, params: command.params })
        }
        const result = command.method === "Browser.getWindowForTarget"
          ? { windowId: 1, bounds: { left: 100, top: 200, width: 800, height: 500 } }
          : command.method === "Runtime.evaluate" ? { result: { value: { width: 800, height: 478, outerWidth: 800, outerHeight: 500 } } }
            : command.method === "Page.captureScreenshot" ? { data: changed ? changedPNG : png } : {}
        ws.send(JSON.stringify({ id: command.id, result }))
      } },
    })
    try {
      const bridge = ElectronComputer.make({ appPath: async () => "/Applications/Fixture.app", fuseBytes: async () => fused("0000000"),
        ownedPorts: async () => [server.port ?? 0], signal: async () => { signals++ }, sleep: async () => {} })
      expect(await bridge.perform(target, window, { type: "capture" })).toMatchObject({ type: "capture", width: 800, height: 500 })
      expect(signals).toBe(0)
      expect(await bridge.perform(target, window, { type: "action", action: { type: "desktop.click", x: 40, y: 60 } })).toEqual({ type: "action", effect: "changed" })
      expect(dispatched).toContainEqual({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ x: 40, y: 38 }) })
      changed = false
      expect(await bridge.perform(target, window, { type: "action", action: { type: "desktop.type", text: "hello" } })).toEqual({ type: "action", effect: "changed" })
      expect(dispatched.some((item) => item.method === "Input.insertText")).toBe(true)
      title = "Not the exact window"
      expect(await bridge.perform(target, window, { type: "capture" }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: "target_not_found" })
    } finally { await server.stop(true) }
  })
})
