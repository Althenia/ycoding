import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const harness = createHarness()
const originalChrome = globalThis.chrome
const originalWebSocket = globalThis.WebSocket

beforeAll(async () => {
  globalThis.chrome = harness.chrome
  globalThis.WebSocket = harness.FakeWebSocket
  await import("../../service-worker.js")
})

afterAll(() => {
  if (originalChrome === undefined) Reflect.deleteProperty(globalThis, "chrome")
  else globalThis.chrome = originalChrome
  if (originalWebSocket === undefined) Reflect.deleteProperty(globalThis, "WebSocket")
  else globalThis.WebSocket = originalWebSocket
})

describe("Chrome bridge service worker", () => {
  test("restores only authenticated Session connectivity and backs off without replaying tabs or actions", async () => {
    await waitFor(() => harness.FakeWebSocket.instances.length === 1)
    const restored = harness.FakeWebSocket.instances[0]
    expect(restored.outgoing).toContainEqual({
      type: "authenticate",
      version: 2,
      extensionID: "extension-test",
      serverID: "server-restored-1",
      credential: "r".repeat(43),
    })
    expect(harness.commands).toEqual([])
    expect(harness.attached).toEqual([])

    await restored.disconnect()
    await waitFor(() => harness.alarms.created.length === 1)
    expect(harness.alarms.created[0]).toMatchObject({ name: "browser-reconnect", delayInMinutes: 1 / 60 })
    await harness.alarms.fire("browser-reconnect")
    await waitFor(() => harness.FakeWebSocket.instances.length === 2)
    const reconnected = harness.FakeWebSocket.instances[1]
    expect(reconnected.outgoing[0]).toMatchObject({ type: "authenticate", serverID: "server-restored-1" })
    expect(reconnected.outgoing.some((message) => message.type === "shared")).toBe(false)
    expect(harness.commands).toEqual([])
  })

  test("rejects guarded mutations before any action or guard command is dispatched", async () => {
    harness.reset()

    try {
      await popup(harness.runtimeMessages, {
        type: "pair",
        serverURL: "http://127.0.0.1:4096",
        sessionID: "ses_test",
        secret: "a".repeat(32),
      })
      let socket = harness.FakeWebSocket.instance
      await socket.receive({ type: "control", action: "stop" })
      expect(harness.storage.browserPairing.enabled).toBe(false)
      expect(await popup(harness.runtimeMessages, { type: "status" })).toMatchObject({ connected: false, paired: true })
      expect(
        await popup(harness.runtimeMessages, {
          type: "connect",
          serverURL: "http://127.0.0.1:4096",
          sessionID: "ses_test",
        }),
      ).toMatchObject({ connected: true, sessionID: "ses_test" })
      socket = harness.FakeWebSocket.instance
      expect(socket.outgoing[0]).toMatchObject({ type: "authenticate", serverID: "server-paired" })
      await popup(harness.runtimeMessages, { type: "share-current" })
      const shared = socket.outgoing.find((message) => message.type === "shared")
      harness.page.active = false
      await harness.tabActivations.emit({ tabId: 99 })
      await socket.receive({
        type: "observe",
        callID: "observe-1",
        tabID: shared.tabID,
        generation: "bridge-1",
      })
      const observation = socket.outgoing.find((message) => message.type === "observation")

      const actionStart = harness.commands.length
      await socket.receive(
        action("navigate-rejected", shared.tabID, observation, { type: "navigate", url: "https://example.test/next" }),
      )
      await socket.receive(action("click-rejected", shared.tabID, observation, { type: "click", ref: "b1" }))
      await socket.receive(
        action("type-rejected", shared.tabID, observation, { type: "type", ref: "b1", text: "hello" }),
      )
      expect(harness.commands.slice(actionStart)).toEqual([])
      for (const callID of ["navigate-rejected", "click-rejected", "type-rejected"])
        expect(socket.outgoing).toContainEqual({
          type: "error",
          callID,
          tabID: shared.tabID,
          generation: "bridge-1",
          dispatched: false,
          message:
            "Chrome's extension debugger API cannot enforce the required no-download guard; navigate, click, and type are unavailable",
        })
      expect(harness.detached).toEqual([])

      const forgotten = await popup(harness.runtimeMessages, { type: "forget" })
      expect(forgotten).toMatchObject({ paired: false, connected: false })
      expect(harness.storage.browserPairing).toBeUndefined()
      expect(socket.outgoing).toContainEqual({ type: "forget" })
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

  test("blocks capture for password inputs in frames and shadow roots before screenshot dispatch", async () => {
    harness.reset()

    try {
      await popup(harness.runtimeMessages, {
        type: "pair",
        serverURL: "http://127.0.0.1:4096",
        sessionID: "ses_capture",
        secret: "c".repeat(32),
      })
      const socket = harness.FakeWebSocket.instance
      await popup(harness.runtimeMessages, { type: "share-current" })
      const shared = socket.outgoing.find((message) => message.type === "shared")
      harness.page.active = false
      await harness.tabActivations.emit({ tabId: 99 })
      await socket.receive({
        type: "observe",
        callID: "observe-capture",
        tabID: shared.tabID,
        generation: "bridge-1",
      })
      const observation = socket.outgoing.find((message) => message.type === "observation")
      const fixtures = [
        node("#document", {
          children: [node("IFRAME", { contentDocument: node("#document", { children: [password()] }) })],
        }),
        node("#document", {
          children: [node("DIV", { shadowRoots: [node("#document-fragment", { children: [password()] })] })],
        }),
      ]

      for (const [index, root] of fixtures.entries()) {
        harness.page.documentRoot = root
        const commandStart = harness.commands.length
        const callID = `capture-${index}`
        await socket.receive(action(callID, shared.tabID, observation, { type: "capture" }))
        expect(socket.outgoing.find((message) => message.callID === callID)).toMatchObject({
          type: "error",
          dispatched: false,
          message: "Capture is disabled while password fields are present",
        })
        expect(harness.commands.slice(commandStart)).toEqual([
          {
            source: { tabId: 17 },
            method: "DOM.getDocument",
            params: { depth: 32, pierce: true },
          },
        ])
      }
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })
})

function createHarness() {
  const runtimeMessages = listeners()
  const tabActivations = listeners()
  const commands = []
  const attached = []
  const detached = []
  const storage = {
    browserPairing: {
      serverURL: "http://127.0.0.1:4096",
      sessionID: "ses_restored",
      serverID: "server-restored-1",
      credential: "r".repeat(43),
      enabled: true,
    },
  }
  const alarms = alarmHarness()
  const page = {
    active: true,
    documentRoot: node("#document"),
  }

  class FakeWebSocket {
    static OPEN = 1
    static instance
    static instances = []

    readyState = 0
    outgoing = []
    events = new Map()

    constructor() {
      FakeWebSocket.instance = this
      FakeWebSocket.instances.push(this)
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        void this.emit("open", {})
      })
    }

    addEventListener(type, listener, options = {}) {
      const current = this.events.get(type) ?? []
      current.push({ listener, once: options.once === true })
      this.events.set(type, current)
    }

    removeEventListener(type, listener) {
      this.events.set(
        type,
        (this.events.get(type) ?? []).filter((entry) => entry.listener !== listener),
      )
    }

    async emit(type, event) {
      const current = [...(this.events.get(type) ?? [])]
      this.events.set(
        type,
        current.filter((entry) => !entry.once),
      )
      await Promise.all(current.map((entry) => entry.listener(event)))
    }

    async receive(message) {
      await this.emit("message", { data: JSON.stringify(message) })
    }

    send(raw) {
      const message = JSON.parse(raw)
      this.outgoing.push(message)
      if (message.type === "pair")
        queueMicrotask(
          () =>
            void this.receive({
              type: "paired",
              version: 2,
              generation: "bridge-1",
              serverID: "server-paired",
              credential: "p".repeat(43),
            }),
        )
      if (message.type === "authenticate")
        queueMicrotask(
          () =>
            void this.receive({
              type: "paired",
              version: 2,
              generation: "bridge-1",
              serverID: message.serverID,
            }),
        )
    }

    close() {
      this.readyState = 3
    }

    async disconnect() {
      this.readyState = 3
      await this.emit("close", {})
    }
  }

  return {
    runtimeMessages,
    tabActivations,
    commands,
    attached,
    detached,
    storage,
    alarms,
    page,
    FakeWebSocket,
    chrome: {
      runtime: {
        id: "extension-test",
        onMessage: runtimeMessages,
      },
      storage: {
        local: {
          get: async (key) => ({ [key]: storage[key] }),
          set: async (values) => Object.assign(storage, values),
          remove: async (key) => void Reflect.deleteProperty(storage, key),
        },
      },
      alarms: alarms.api,
      tabs: {
        onActivated: tabActivations,
        query: async () => [{ id: 17, active: page.active, title: "Example" }],
        get: async () => ({ id: 17, active: page.active, title: "Example", url: "https://example.test/form" }),
      },
      debugger: {
        onDetach: listeners(),
        onEvent: listeners(),
        attach: async (source) => {
          attached.push(source)
        },
        detach: async (source) => {
          detached.push(source)
        },
        sendCommand: async (source, method, params = {}) => {
          commands.push({ source, method, params })
          if (method === "Page.getNavigationHistory")
            return {
              currentIndex: 0,
              entries: [{ title: "Example", url: "https://example.test/form" }],
            }
          if (method === "Accessibility.getFullAXTree")
            return {
              nodes: [
                {
                  ignored: false,
                  role: { value: "textbox" },
                  name: { value: "Name" },
                  backendDOMNodeId: 91,
                },
              ],
            }
          if (method === "DOM.describeNode") return { node: { nodeName: "INPUT", attributes: ["type", "text"] } }
          if (method === "DOM.getDocument") return { root: page.documentRoot }
          if (method === "Page.captureScreenshot") return { data: "AAAA" }
          return {}
        },
      },
    },
    reset() {
      commands.length = 0
      detached.length = 0
      page.active = true
      page.documentRoot = node("#document")
      FakeWebSocket.instance = undefined
    },
  }
}

function password() {
  return node("INPUT", { attributes: ["type", "password"] })
}

function node(nodeName, values = {}) {
  const children = Array.isArray(values.children) ? values.children : []
  return { nodeName, childNodeCount: children.length, ...values }
}

function alarmHarness() {
  const onAlarm = listeners()
  const created = []
  return {
    created,
    api: {
      onAlarm,
      create: (name, options) => created.push({ name, ...options }),
      clear: async (name) => {
        const index = created.findIndex((alarm) => alarm.name === name)
        if (index >= 0) created.splice(index, 1)
        return index >= 0
      },
    },
    async fire(name) {
      const index = created.findIndex((alarm) => alarm.name === name)
      if (index >= 0) created.splice(index, 1)
      await onAlarm.emit({ name })
    },
  }
}

function listeners() {
  const registered = []
  return {
    addListener(listener) {
      registered.push(listener)
    },
    emit(...args) {
      return Promise.all(registered.map((listener) => listener(...args)))
    },
  }
}

function popup(runtimeMessages, message) {
  return new Promise((resolve) => {
    void runtimeMessages.emit(message, {}, resolve)
  })
}

function action(callID, tabID, observation, input) {
  return {
    type: "action",
    callID,
    tabID,
    generation: "bridge-1",
    documentGeneration: observation.documentGeneration,
    observationRevision: observation.revision,
    allowedOrigins: ["https://example.test"],
    action: input,
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for service-worker state")
}
