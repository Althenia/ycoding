/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { KeyEvent } from "@opentui/core"
import { expect, spyOn, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("drops key events with an empty name instead of erroring in the resolver", async () => {
  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <box />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  const errors: string[] = []
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "))
  })
  try {
    // Some terminal sequences parse into a key event with an empty name. OpenTUI's default
    // event-match resolver calls resolveKey({ name }) which throws on an empty name, so the
    // keymap must consume these before dispatch instead of erroring on every one.
    app.renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "",
        number: false,
        raw: "",
        eventType: "press",
        source: "raw",
      }),
    )
    await Bun.sleep(5)
    expect(errors.some((line) => line.includes("event-match-resolver-error"))).toBe(false)
  } finally {
    spy.mockRestore()
    app.renderer.destroy()
  }
})

test("legacy page key aliases compile as page keys", async () => {
  let read = () => ({ up: "", down: "" })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.page.up", run() {} },
        { id: "session.page.down", run() {} },
      ],
    }))
    read = () => ({
      up: shortcuts.get("session.page.up") ?? "",
      down: shortcuts.get("session.page.down") ?? "",
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider
      config={createTuiResolvedConfig({
        keybinds: {
          messages_page_up: "pgup",
          messages_page_down: "pgdown",
        },
      })}
    >
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({ up: "pgup", down: "pgdn" })
  } finally {
    app.renderer.destroy()
  }
})

test("formats navigation keys as arrows", async () => {
  let read = () => ({}) as Record<string, string>
  const commands = ["session.parent", "session.child.first", "session.child.previous", "session.child.next"]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: commands.map((id) => ({ id, run() {} })),
    }))
    read = () => Object.fromEntries(commands.map((id) => [id, shortcuts.get(id) ?? ""]))
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({
      "session.parent": "↑",
      "session.child.first": "↓",
      "session.child.previous": "←",
      "session.child.next": "→",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("leader bindings dispatch from real terminal input", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("model") }],
    }))
    return <box />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("m")
    await Bun.sleep(10)
    expect(calls).toEqual(["model"])
  } finally {
    app.renderer.destroy()
  }
})

test("inline leader sequences dispatch from real terminal input", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [{ bind: "ctrl+x k", title: "Cancel", run: () => void calls.push("cancel") }],
    }))
    return <box />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("k")
    await Bun.sleep(10)
    expect(calls).toEqual(["cancel"])
  } finally {
    app.renderer.destroy()
  }
})

test("plain tab dispatches the default agent cycle command", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [{ id: "agent.cycle", run: () => void calls.push("agent") }],
    }))
    return <box />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    app.mockInput.pressTab()
    await Bun.sleep(10)
    expect(calls).toEqual(["agent"])
  } finally {
    app.renderer.destroy()
  }
})

test("custom leader bindings dispatch from real terminal input", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("model") }],
    }))
    return <box />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ keybinds: { leader: "ctrl+o" } })}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    app.mockInput.pressKey("o", { ctrl: true })
    app.mockInput.pressKey("m")
    await Bun.sleep(10)
    expect(calls).toEqual(["model"])
  } finally {
    app.renderer.destroy()
  }
})

test("custom direct command binding replaces the default leader binding", async () => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("model") }],
    }))
    return <box />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ keybinds: { model_list: "ctrl+k" } })}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("m")
    await Bun.sleep(10)
    expect(calls).toEqual([])

    app.mockInput.pressKey("k", { ctrl: true })
    await Bun.sleep(10)
    expect(calls).toEqual(["model"])
  } finally {
    app.renderer.destroy()
  }
})

test("global commands stay reachable when the mode changes", async () => {
  const calls: string[] = []
  let exercise = () => {}

  function Harness() {
    const keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "session.list", run: () => void calls.push("global") }],
    }))
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("base") }],
    }))

    exercise = () => {
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      const pop = keymap.mode.push("question")
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      pop()
    }
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    exercise()
    expect(calls).toEqual(["global", "base", "global"])
  } finally {
    app.renderer.destroy()
  }
})
