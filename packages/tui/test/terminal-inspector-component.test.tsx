/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MouseEvent, TextRenderable, type Renderable } from "@opentui/core"
import { PtyProtocol } from "@ycoding-ai/core/pty/protocol"
import { Pty } from "@ycoding-ai/schema/pty"
import { testRender } from "@opentui/solid"
import { Schema } from "effect"
import {
  TerminalInspector,
  type TerminalInspectorRef,
  type TerminalInspectorTransport,
  TerminalViewportRenderable,
} from "../src/component/terminal-inspector"
import { TerminalInspectorState } from "../src/component/terminal-inspector-state"

const info = Schema.decodeUnknownSync(Pty.Info)({
  id: "pty_component",
  sessionID: "ses_component",
  title: "Owned fixture",
  command: "/bin/sh",
  args: [],
  cwd: "/tmp",
  status: "running",
  pid: 42,
  generation: 1,
  size: { rows: 4, cols: 30 },
  control: { owner: "agent", fence: 1 },
  output: { startOffset: 0, endOffset: 5, truncated: false },
  limits: { maxRuntimeSeconds: 300, maxRetainedBytes: Pty.MAX_RETAINED_BYTES, maxInputBytes: Pty.MAX_INPUT_BYTES },
} as unknown)

test("read-only inspector is passive, renders native terminal state, and separates close from control/resize", async () => {
  const writes: Uint8Array[] = []
  const connections: Parameters<TerminalInspectorTransport["connect"]>[0][] = []
  const controls: Pty.ControlInput[] = []
  let disconnected = 0
  const transport: TerminalInspectorTransport = {
    connect: (input, handlers) => {
      connections.push(input)
      handlers.frame(
        PtyProtocol.controlFrame({
          type: "replay",
          generation: 1,
          startOffset: input.offset,
          endOffset: 5,
          gap: false,
        }),
      )
      if (input.offset === 0) {
        handlers.frame(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 0, endOffset: 5 }))
        handlers.frame(PtyProtocol.dataFrame(new TextEncoder().encode("READY")))
      }
      return () => {
        disconnected += 1
      }
    },
    control: async (input) => {
      controls.push(input)
      return Schema.decodeUnknownSync(Pty.Info)({
        ...info,
        control: { owner: "user", fence: 2 },
      } as unknown)
    },
    resize: async () => info,
    write: (data) => writes.push(data),
  }
  const state = new TerminalInspectorState(info)
  const app = await testRender(
    () => <TerminalInspector state={state} transport={transport} pane={{ rows: 6, cols: 40 }} onClose={() => {}} />,
    { width: 50, height: 10 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("READY"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Owned fixture · ses_component · running · 30×4")
    expect(frame).toContain("agent")
    expect(frame).toContain("Take control")
    expect(frame).toContain("Close view")
    expect(frame).not.toContain("Fit terminal to pane")
    expect(writes).toHaveLength(0)

    const take = findText(app.renderer.root, "Take control")
    if (!take) throw new Error("Take control action did not render")
    take.processMouseEvent(
      new MouseEvent(take, {
        type: "up",
        button: 0,
        x: take.x,
        y: take.y,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    )
    await app.waitForFrame((value) => value.includes("You") && value.includes("Fit terminal to pane"))
    expect(controls).toEqual([{ sessionID: info.sessionID, generation: 1, expectedFence: 1, action: "take" }])
    expect(connections).toEqual([
      { generation: 1, offset: 0, access: "inspect", fence: undefined },
      { generation: 1, offset: 5, access: "control", fence: 2 },
    ])
    expect(disconnected).toBe(1)
    expect(writes).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
  expect(disconnected).toBe(2)
})

test("reconnect resumes the resident emulator at the last ordered offset", async () => {
  const connections: Parameters<TerminalInspectorTransport["connect"]>[0][] = []
  const handlers: Parameters<TerminalInspectorTransport["connect"]>[1][] = []
  const transport: TerminalInspectorTransport = {
    connect: (input, next) => {
      connections.push(input)
      handlers.push(next)
      next.frame(
        PtyProtocol.controlFrame({
          type: "replay",
          generation: 1,
          startOffset: input.offset,
          endOffset: 5,
          gap: false,
        }),
      )
      if (input.offset === 0) {
        next.frame(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 0, endOffset: 5 }))
        next.frame(PtyProtocol.dataFrame(new TextEncoder().encode("READY")))
      }
      return () => {}
    },
    control: async () => info,
    resize: async () => info,
    write: () => {},
  }
  const app = await testRender(
    () => (
      <TerminalInspector
        state={new TerminalInspectorState(info)}
        transport={transport}
        pane={{ rows: 6, cols: 40 }}
        reconnectDelay={0}
        onClose={() => {}}
      />
    ),
    { width: 50, height: 10 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("READY"))
    handlers[0].close()
    await Bun.sleep(5)
    expect(connections).toEqual([
      { generation: 1, offset: 0, access: "inspect", fence: undefined },
      { generation: 1, offset: 5, access: "inspect", fence: undefined },
    ])
    expect(app.captureCharFrame()).toContain("READY")
  } finally {
    app.renderer.destroy()
  }
})

test("holds input, focus, and resize until the current fenced control replay connects after take and reconnect", async () => {
  const user = Schema.decodeUnknownSync(Pty.Info)({
    ...info,
    control: { owner: "user", fence: 2 },
  } as unknown)
  const connections: Parameters<TerminalInspectorTransport["connect"]>[0][] = []
  const handlers: Parameters<TerminalInspectorTransport["connect"]>[1][] = []
  const writes: Uint8Array[] = []
  const resizes: Pty.UpdateInput[] = []
  let inspector: TerminalInspectorRef | undefined
  const transport: TerminalInspectorTransport = {
    connect: (input, next) => {
      connections.push(input)
      handlers.push(next)
      if (connections.length === 1) {
        next.frame(
          PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 0, endOffset: 5, gap: false }),
        )
        next.frame(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 0, endOffset: 5 }))
        next.frame(PtyProtocol.dataFrame(new TextEncoder().encode("READY")))
      }
      return () => {}
    },
    control: async () => user,
    resize: async (input) => {
      resizes.push(input)
      return user
    },
    write: (data) => writes.push(data),
  }
  const state = new TerminalInspectorState(info)
  const app = await testRender(
    () => (
      <TerminalInspector
        ref={(value) => (inspector = value)}
        state={state}
        transport={transport}
        pane={{ rows: 6, cols: 40 }}
        reconnectDelay={0}
        onClose={() => {}}
      />
    ),
    { width: 70, height: 10 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("READY"))
    const terminal = findTerminal(app.renderer.root)
    if (!terminal || !inspector) throw new Error("Terminal inspector did not mount")

    expect(await inspector.takeControl()).toBe(true)
    await app.renderOnce()
    expect(connections[1]).toEqual({ generation: 1, offset: 5, access: "control", fence: 2 })
    expect(state.snapshot().connection).toBe("connecting")
    expect(state.canInput()).toBe(false)
    expect(terminal.focused).toBe(false)
    app.mockInput.pressKey("x")
    expect(await inspector.fit()).toBe(false)
    expect(writes).toHaveLength(0)
    expect(resizes).toHaveLength(0)

    handlers[1].frame(
      PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 5, endOffset: 10, gap: false }),
    )
    await app.renderOnce()
    expect(state.canInput()).toBe(false)
    expect(terminal.focused).toBe(false)
    app.mockInput.pressKey("x")
    expect(await inspector.fit()).toBe(false)
    expect(writes).toHaveLength(0)
    expect(resizes).toHaveLength(0)

    handlers[1].frame(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 5, endOffset: 10 }))
    await app.renderOnce()
    expect(state.canInput()).toBe(false)
    handlers[1].frame(PtyProtocol.dataFrame(new TextEncoder().encode("CATCH")))
    await app.renderOnce()
    expect(state.canInput()).toBe(true)
    expect(terminal.focused).toBe(true)
    app.mockInput.pressKey("y")
    expect(await inspector.fit()).toBe(true)

    handlers[1].close()
    await Bun.sleep(5)
    await app.renderOnce()
    expect(connections[2]).toEqual({ generation: 1, offset: 10, access: "control", fence: 2 })
    expect(state.snapshot().connection).toBe("connecting")
    expect(state.canInput()).toBe(false)
    expect(terminal.focused).toBe(false)
    app.mockInput.pressKey("x")
    expect(await inspector.fit()).toBe(false)

    handlers[2].frame(
      PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 10, endOffset: 10, gap: false }),
    )
    await app.renderOnce()
    app.mockInput.pressKey("z")
    expect(writes.map((data) => new TextDecoder().decode(data))).toEqual(["y", "z"])
    expect(resizes).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("an already user-controlled terminal receives input after replay synchronization", async () => {
  const writes: Uint8Array[] = []
  const user = Schema.decodeUnknownSync(Pty.Info)({
    ...info,
    control: { owner: "user", fence: 2 },
  } as unknown)
  const transport: TerminalInspectorTransport = {
    connect: (input, handlers) => {
      handlers.frame(
        PtyProtocol.controlFrame({
          type: "replay",
          generation: 1,
          startOffset: input.offset,
          endOffset: input.offset,
          gap: false,
        }),
      )
      return () => {}
    },
    control: async () => user,
    resize: async () => user,
    write: (data) => writes.push(data),
  }
  const app = await testRender(
    () => (
      <TerminalInspector
        state={new TerminalInspectorState(user)}
        transport={transport}
        pane={{ rows: 6, cols: 40 }}
        onClose={() => {}}
      />
    ),
    { width: 70, height: 10 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Return control"))
    app.mockInput.pressKey("x")
    await Promise.resolve()
    expect(new TextDecoder().decode(writes[0])).toBe("x")
  } finally {
    app.renderer.destroy()
  }
})

test("close keeps user-controlled inspector open when pause fails and hides raw error details", async () => {
  let closed = 0
  const user = Schema.decodeUnknownSync(Pty.Info)({
    ...info,
    control: { owner: "user", fence: 2 },
  } as unknown)
  const transport: TerminalInspectorTransport = {
    connect: (input, handlers) => {
      handlers.frame(
        PtyProtocol.controlFrame({
          type: "replay",
          generation: 1,
          startOffset: input.offset,
          endOffset: input.offset,
          gap: false,
        }),
      )
      return () => {}
    },
    control: async () => {
      throw new Error("private path /Users/example/secret and token=hidden")
    },
    resize: async () => user,
    write: () => {},
  }
  const app = await testRender(
    () => (
      <TerminalInspector
        state={new TerminalInspectorState(user)}
        transport={transport}
        pane={{ rows: 6, cols: 40 }}
        onClose={() => {
          closed += 1
        }}
      />
    ),
    { width: 70, height: 10 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Close view"))
    const close = findText(app.renderer.root, "Close view")
    if (!close) throw new Error("Close view action did not render")
    close.processMouseEvent(
      new MouseEvent(close, {
        type: "up",
        button: 0,
        x: close.x,
        y: close.y,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    )
    await app.waitForFrame((frame) => frame.includes("Unable to return terminal control"))
    expect(closed).toBe(0)
    expect(app.captureCharFrame()).not.toContain("/Users/example")
    expect(app.captureCharFrame()).not.toContain("token=hidden")
  } finally {
    app.renderer.destroy()
  }
})

test("unmount cancels an in-flight control acquisition before late settlement", async () => {
  let signal: AbortSignal | undefined
  let resolve!: (value: Pty.Info) => void
  const pending = new Promise<Pty.Info>((done) => (resolve = done))
  const transport: TerminalInspectorTransport = {
    connect: (input, handlers) => {
      handlers.frame(
        PtyProtocol.controlFrame({
          type: "replay",
          generation: 1,
          startOffset: input.offset,
          endOffset: input.offset,
          gap: false,
        }),
      )
      return () => {}
    },
    control: (_input, options) => {
      signal = options?.signal
      return pending
    },
    resize: async () => info,
    write: () => {},
  }
  const app = await testRender(
    () => (
      <TerminalInspector
        state={new TerminalInspectorState(info)}
        transport={transport}
        pane={{ rows: 6, cols: 40 }}
        onClose={() => {}}
      />
    ),
    { width: 70, height: 10 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Take control"))
  const take = findText(app.renderer.root, "Take control")
  if (!take) throw new Error("Take control action did not render")
  take.processMouseEvent(
    new MouseEvent(take, {
      type: "up",
      button: 0,
      x: take.x,
      y: take.y,
      modifiers: { shift: false, alt: false, ctrl: false },
    }),
  )
  await Promise.resolve()
  app.renderer.destroy()

  expect(signal?.aborted).toBe(true)
  resolve(info)
  await Promise.resolve()
})

function findText(node: Renderable, text: string): TextRenderable | undefined {
  if (node instanceof TextRenderable && node.plainText.includes(text)) return node
  return node
    .getChildren()
    .map((child) => findText(child, text))
    .find((child) => child !== undefined)
}

function findTerminal(node: Renderable): TerminalViewportRenderable | undefined {
  if (node instanceof TerminalViewportRenderable) return node
  return node
    .getChildren()
    .map(findTerminal)
    .find((child) => child !== undefined)
}
