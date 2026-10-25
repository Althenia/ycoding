/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { KeyEvent, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogConfirm } from "../../src/ui/dialog-confirm"
import { DialogPrompt } from "../../src/ui/dialog-prompt"
import { ToastProvider } from "../../src/ui/toast"
import { backend, docsID, groupID, leadID } from "../fixture/coordination-backend"
import { mountCoordination } from "../fixture/coordination-screen"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const memberTitle = "Synthetic worker reviewing the complete release acceptance evidence and outstanding integration details"
const viewports = [{ width: 80, height: 24 }, { width: 120, height: 36 }]

async function waitFor(screen: Awaited<ReturnType<typeof mountCoordination>>["screen"], check: () => boolean) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    await screen.renderOnce()
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Confirmation transition missing:\n${screen.frame()}`)
}

async function projectConfirmation(action: "remove" | "delete", viewport: { width: number; height: number }) {
  const initial = backend()
  initial.state.projects[0].name = "Dots"
  initial.state.sessions[docsID].title = memberTitle
  const mounted = await mountCoordination({ ...viewport, backend: { projects: initial.state.projects, sessions: initial.state.sessions } })
  const screen = mounted.screen
  if (action === "delete") {
    mounted.router().navigate({ type: "projects", sessionID: leadID })
    await waitFor(screen, () => screen.frame().includes("Dots") && screen.frame().includes("PROJECTS"))
    screen.input.pressKey("d", { shift: true })
  } else {
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitFor(screen, () => screen.frame().includes("MEMBERS 4 + MASTER"))
    screen.input.pressArrow("down")
    screen.input.pressKey("x")
  }
  await waitFor(screen, () => screen.frame().includes(action === "remove" ? "Remove Synthetic" : "Delete Dots?"))
  return mounted
}

for (const viewport of viewports) {
  for (const action of ["remove", "delete"] as const) {
    test(`${action} confirmation accepts keyboard cancel without parent navigation at ${viewport.width}x${viewport.height}`, async () => {
      const mounted = await projectConfirmation(action, viewport)
      const screen = mounted.screen
      try {
        const frame = screen.frame()
        expect(screen.lines().some((line) => /\bCancel\b/.test(line))).toBe(true)
        expect(screen.lines().some((line) => new RegExp(`\\b${action === "remove" ? "Remove" : "Delete"}\\b(?!.*\\?)`).test(line))).toBe(true)
        console.info(`${action} confirmation ${viewport.width}x${viewport.height}\n${frame}`)
        await screen.input.typeText("nx")
        screen.input.pressKey("d", { shift: true })
        await screen.renderOnce()
        expect(mounted.server.state.writes).toEqual([])
        expect(screen.frame()).toContain(action === "remove" ? "Remove Synthetic" : "Delete Dots?")
        screen.input.pressArrow("up")
        await screen.renderOnce()
        expect(screen.frame()).toContain(action === "remove" ? "Remove Synthetic" : "Delete Dots?")
        const cancel = screen.spans().lines.find((line) => line.spans.some((span) => span.text.includes("Cancel")))
        expect(cancel?.spans.some((span) => span.text.includes("Cancel") && span.bg.toInts().slice(0, 3).join(",") === "121,184,255")).toBe(true)
        screen.input.pressEnter()
        await waitFor(screen, () => !screen.frame().includes(action === "remove" ? "Remove Synthetic" : "Delete Dots?"))
        expect(mounted.server.state.writes).toEqual([])
        expect(mounted.router().data).toMatchObject({ type: action === "remove" ? "session" : "projects", sessionID: leadID })
        expect(frame).not.toContain("Search")
      } finally { await screen.dispose() }
    }, 30000)
  }
}

for (const viewport of viewports) {
  for (const action of ["remove", "delete"] as const) {
    test(`${action} confirmation uses a real mouse click and dispatches exactly once at ${viewport.width}x${viewport.height}`, async () => {
      const mounted = await projectConfirmation(action, viewport)
      const screen = mounted.screen
      try {
        const label = action === "remove" ? "Remove" : "Delete"
        const row = screen.lines().findIndex((line) => new RegExp(`(?:^|\\s)${label}\\s*(?:│\\s*)?$`).test(line))
        expect(row).toBeGreaterThanOrEqual(0)
        const column = screen.lines()[row].indexOf(label)
        await screen.mouse.click(column, row)
        await waitFor(screen, () => mounted.server.state.writes.length === 1)
        expect(mounted.server.state.writes).toHaveLength(1)
        expect(mounted.server.state.writes[0]).toMatchObject(action === "remove"
          ? { method: "PATCH", path: `/api/coordination/${groupID}` }
          : { method: "DELETE", path: `/api/coordination/${groupID}` })
      } finally { await screen.dispose() }
    }, 30000)
  }
}

async function dialogFixture() {
  let editor!: TextareaRenderable
  let dialog!: ReturnType<typeof useDialog>
  let keys!: ReturnType<typeof Keymap.use>
  const results: Array<boolean | undefined> = []
  const confirms: string[] = []
  function Fixture() {
    dialog = useDialog()
    keys = Keymap.use()
    onMount(() => { editor.setText("Preserved composer draft"); editor.focus() })
    return <textarea ref={(value: TextareaRenderable) => { editor = value }} width="100%" height={2} />
  }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
    <Keymap.Provider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ToastProvider>
      <DialogProvider><Fixture /></DialogProvider>
    </ToastProvider></ThemeProvider></Keymap.Provider>
  </ConfigProvider></TestTuiContexts>, { width: 80, height: 24, kittyKeyboard: true })
  app.renderer.start()
  await app.waitFor(() => editor?.focused)
  return { app, get editor() { return editor }, get keys() { return keys }, get dialog() { return dialog }, results, confirms }
}

test("confirmation Escape, Cancel and repeated reopen preserve the invoker and isolate typing", async () => {
  const view = await dialogFixture()
  try {
    for (const outcome of [undefined, false, true]) {
      void DialogConfirm.show(view.dialog, "Confirm synthetic action", "No external action is performed.", "Confirm").then((value) => view.results.push(value))
      await view.app.waitForFrame((frame) => frame.includes("Confirm synthetic action"))
      expect(view.keys.mode.current()).toBe("modal")
      await view.app.mockInput.typeText("nDx")
      expect(view.editor.plainText).toBe("Preserved composer draft")
      if (outcome === undefined) view.app.mockInput.pressEscape()
      if (outcome === false) { view.app.mockInput.pressArrow("left"); view.app.mockInput.pressEnter() }
      if (outcome === true) { view.app.mockInput.pressArrow("left"); view.app.mockInput.pressArrow("right"); view.app.mockInput.pressEnter() }
      await view.app.waitFor(() => view.results.length > 0 && view.results.at(-1) === outcome && view.editor.focused)
      expect(view.editor.plainText).toBe("Preserved composer draft")
    }
    expect(view.results).toEqual([undefined, false, true])
  } finally { view.app.renderer.destroy() }
})

test("confirmation guards an in-flight direct callback against repeated input and generic prompt remains editable", async () => {
  const view = await dialogFixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  try {
    view.dialog.replace(() => <DialogConfirm title="Confirm once" message="No external action." onConfirm={async () => { view.confirms.push("confirmed"); await pending }} />)
    await view.app.waitForFrame((frame) => frame.includes("Confirm once"))
    view.app.mockInput.pressEnter()
    view.app.mockInput.pressEnter()
    await view.app.waitFor(() => view.editor.focused)
    expect(view.confirms).toEqual(["confirmed"])
    void DialogPrompt.show(view.dialog, "Editable prompt", { value: "original" }).then((value) => { if (value !== null) view.confirms.push(value); view.dialog.clear() })
    await view.app.waitFor(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable && view.app.renderer.currentFocusedEditor !== view.editor)
    await view.app.mockInput.typeText(" updated")
    view.app.mockInput.pressEnter()
    await view.app.waitFor(() => view.confirms.length === 2)
    expect(view.confirms[1]).toBe("original updated")
  } finally { release(); view.app.renderer.destroy() }
})

test("confirmation settlement preserves a replacement opened by its callback", async () => {
  const view = await dialogFixture()
  try {
    view.dialog.replace(() => <DialogConfirm title="First confirmation" message="No external action." onConfirm={() => {
      view.confirms.push("confirmed")
      view.dialog.replace(() => <text>Follow-up remains open</text>)
    }} />)
    await view.app.waitForFrame((frame) => frame.includes("First confirmation"))
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("Follow-up remains open"))
    expect(view.confirms).toEqual(["confirmed"])
    view.app.mockInput.pressEscape()
    await view.app.waitFor(() => view.editor.focused)
  } finally { view.app.renderer.destroy() }
})

test.each(viewports)("long confirmation titles keep choices reachable at $width x $height", async (viewport) => {
  const initial = backend()
  initial.state.projects[0].name = "Dots"
  initial.state.sessions[docsID].title = `${memberTitle} ${memberTitle} ${memberTitle} ${memberTitle} ${memberTitle} ${memberTitle} ${memberTitle}`
  const mounted = await mountCoordination({ ...viewport, backend: { projects: initial.state.projects, sessions: initial.state.sessions } })
  const screen = mounted.screen
  try {
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitFor(screen, () => screen.frame().includes("MEMBERS 4 + MASTER"))
    screen.input.pressArrow("down")
    screen.input.pressKey("x")
    await waitFor(screen, () => screen.frame().includes("Remove Synthetic"))
    expect(screen.lines().some((line) => /\bCancel\b/.test(line))).toBe(true)
    expect(screen.lines().some((line) => /\bRemove\b(?!.*Synthetic)/.test(line))).toBe(true)
    screen.renderer.keyInput.emit("keypress", new KeyEvent({
      name: "pagedown", sequence: "\u001b[6~", raw: "\u001b[6~", eventType: "press", source: "raw",
      ctrl: false, meta: false, shift: false, option: false, number: false,
    }))
    await waitFor(screen, () => screen.frame().includes("The Session keeps running"))
    expect(screen.lines().some((line) => /\bCancel\b/.test(line))).toBe(true)
    screen.input.pressEscape()
    await waitFor(screen, () => !screen.frame().includes("Remove Synthetic"))
    expect(mounted.server.state.writes).toEqual([])
  } finally { await screen.dispose() }
}, 30000)
