/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Dots } from "@ycoding-ai/schema/dots"
import { DialogDotsConnection } from "../src/component/dialog-dots-connection"
import { createDotsConnection } from "../src/dots-connection"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { onMount } from "solid-js"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

for (const mode of ["dark", "light"] as const) for (const width of [60, 100]) {
  test(`${mode} ${width}-column Dots dialog separates permission, connection, and pending state`, async () => {
    const initial: Dots.NativeStatus = { access: { enabled: true, revision: 4 }, configuration: { ready: true, profile: "fixture-profile" }, connection: { state: "connecting", hostname: "fixture-computer" } }
    let current = initial
    let connection!: ReturnType<typeof createDotsConnection>
    let finish!: (value: Dots.NativeStatus) => void
    let writes = 0
    function Probe() {
      connection = createDotsConnection({
        connected: () => true, owner: () => "fixture",
        get: async () => current,
        set: () => { writes++; return new Promise((resolve) => { finish = resolve }) },
        attach: async () => current,
        error: (error) => { throw error },
      })
      return <DialogDotsConnection connection={connection} />
    }
    const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><Keymap.Provider>
      <ToastProvider><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
        <DialogProvider><Probe /></DialogProvider>
      </ThemeProvider></ToastProvider>
    </Keymap.Provider></ConfigProvider></TestTuiContexts>, { width, height: 30 })
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("Connection: Connecting"))
      expect(app.captureCharFrame()).toContain("Access: On")
      expect(app.captureCharFrame()).toContain("Disconnect")
      expect(app.captureCharFrame()).not.toContain("Connection: Connected")
      const pending = connection.toggle()
      await app.waitForFrame((frame) => frame.includes("Updating access"))
      expect(app.captureCharFrame()).toContain("Access: On")
      expect(app.captureCharFrame()).toContain("Disconnect")
      await connection.toggle()
      expect(writes).toBe(1)
      current = { ...initial, access: { enabled: false, revision: 5 }, connection: { state: "off", hostname: "fixture-computer" } }
      finish(current)
      await pending
      await app.waitForFrame((frame) => frame.includes("Access: Off") && frame.includes("Connection: Off"))
      expect(app.captureCharFrame()).toContain("Connect")
    } finally { app.renderer.destroy() }
  })
}

const base: Dots.NativeStatus = { access: { enabled: true, revision: 4 }, configuration: { ready: true, profile: "fixture-profile" }, connection: { state: "connected", hostname: "fixture-computer" } }

async function renderComputerDialog(initial: Dots.NativeStatus, width = 100) {
  let current = initial
  const attaches: { replaceOthers: true }[] = []
  const errors: unknown[] = []
  let finish!: (value: Dots.NativeStatus) => void
  let fail!: (error: unknown) => void
  let connection!: ReturnType<typeof createDotsConnection>
  function Probe() {
    connection = createDotsConnection({
      connected: () => true, owner: () => "fixture",
      get: async () => current,
      set: async () => current,
      attach: (input) => {
        attaches.push(input)
        return new Promise((resolve, reject) => { finish = resolve; fail = reject })
      },
      error: (error) => errors.push(error),
    })
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogDotsConnection connection={connection} />))
    return null
  }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><Keymap.Provider>
    <ToastProvider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
      <DialogProvider><Probe /></DialogProvider>
    </ThemeProvider></ToastProvider>
  </Keymap.Provider></ConfigProvider></TestTuiContexts>, { width, height: 36 })
  app.renderer.start()
  return {
    app, attaches, errors,
    frame: () => app.captureCharFrame(),
    settle: (value: Dots.NativeStatus) => { current = value; finish(value) },
    reject: (error: unknown) => fail(error),
    update: (value: Dots.NativeStatus) => { current = value },
    connection: () => connection,
  }
}

for (const width of [60, 100]) {
  test(`${width}-column Dots dialog shows executor state only while access is on`, async () => {
    for (const [computer, label] of [
      [{ state: "attached" }, "Executor: Attached"],
      [{ state: "detached" }, "Executor: Not attached"],
      [{ state: "unavailable", message: "Executor is not running" }, "Executor: Unavailable"],
    ] as const) {
      const view = await renderComputerDialog({ ...base, computer }, width)
      try {
        await view.app.waitForFrame((frame) => frame.includes(label))
        expect(view.frame().includes("Use this computer for Dots tasks")).toBe(computer.state === "detached")
        if (computer.state === "unavailable") expect(view.frame()).toContain("Executor is not running")
      } finally { view.app.renderer.destroy() }
    }
    const off = await renderComputerDialog({ ...base, access: { enabled: false, revision: 5 }, connection: { state: "off", hostname: "fixture-computer" }, computer: { state: "detached" } }, width)
    try {
      await off.app.waitForFrame((frame) => frame.includes("Access: Off"))
      expect(off.frame()).not.toContain("Executor:")
      expect(off.frame()).not.toContain("Use this computer for Dots tasks")
    } finally { off.app.renderer.destroy() }
  })
}

test("Dots dialog confirms before detaching other computers, then attaches once and refreshes", async () => {
  const view = await renderComputerDialog({ ...base, computer: { state: "detached" } })
  try {
    await view.app.waitForFrame((frame) => frame.includes("Use this computer for Dots tasks"))
    view.app.mockInput.pressArrow("down")
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("detach your other computers"))
    expect(view.attaches).toEqual([])
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("Updating access"))
    expect(view.attaches).toEqual([{ replaceOthers: true }])
    view.app.mockInput.pressEnter()
    expect(view.attaches).toHaveLength(1)
    view.settle({ ...base, computer: { state: "attached" } })
    await view.app.waitForFrame((frame) => frame.includes("Executor: Attached"))
    expect(view.frame()).not.toContain("Use this computer for Dots tasks")
    expect(view.attaches).toHaveLength(1)
  } finally { view.app.renderer.destroy() }
})

test("Dots dialog cancel leaves the computer detached without a request", async () => {
  const view = await renderComputerDialog({ ...base, computer: { state: "detached" } })
  try {
    await view.app.waitForFrame((frame) => frame.includes("Use this computer for Dots tasks"))
    view.app.mockInput.pressArrow("down")
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("detach your other computers"))
    view.app.mockInput.pressArrow("down")
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("Use this computer for Dots tasks") && !frame.includes("detach your other computers"))
    expect(view.attaches).toEqual([])
  } finally { view.app.renderer.destroy() }
})

test("Dots dialog shows an attach failure and does not retry", async () => {
  const view = await renderComputerDialog({ ...base, computer: { state: "detached" } })
  try {
    await view.app.waitForFrame((frame) => frame.includes("Use this computer for Dots tasks"))
    view.app.mockInput.pressArrow("down")
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("detach your other computers"))
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("Updating access"))
    view.reject(new Error("executor refused"))
    await view.app.waitForFrame((frame) => frame.includes("executor refused"))
    expect(view.attaches).toHaveLength(1)
    expect(view.errors).toHaveLength(1)
    expect(view.frame()).toContain("Executor: Not attached")
  } finally { view.app.renderer.destroy() }
})
