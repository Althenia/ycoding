import { afterEach, expect, test } from "bun:test"

const originalDocument = globalThis.document
const originalChrome = globalThis.chrome
const originalSetInterval = globalThis.setInterval

afterEach(() => {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document")
  else globalThis.document = originalDocument
  if (originalChrome === undefined) Reflect.deleteProperty(globalThis, "chrome")
  else globalThis.chrome = originalChrome
  globalThis.setInterval = originalSetInterval
})

test("pairs once, then replaces the form with connection information", async () => {
  const { nodes, calls, dispatch } = await popup(
    { paired: false, connected: false, profileGranted: false, message: "Not paired" },
    { paired: true, connected: true, profileGranted: true, message: "Paired" },
  )
  expect(nodes.get("#connection-state").textContent).toBe("Disconnected")
  expect(nodes.get("#pairing-view").hidden).toBe(false)
  expect(nodes.get("#server").value).toBe("http://127.0.0.1:4096")
  nodes.get("#secret").value = "test-pairing-code"
  await Promise.all([dispatch("#pairing-form", "submit"), dispatch("#pairing-form", "submit")])
  expect(calls.filter((call) => call.type === "pair")).toEqual([
    { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "test-pairing-code" },
  ])
  expect(nodes.get("#secret").value).toBe("")
  expect(nodes.get("#pairing-view").hidden).toBe(true)
  expect(nodes.get("#connected-view").hidden).toBe(false)
  expect(nodes.get("#connection-state").textContent).toBe("Connected")
  expect(nodes.get("#forget").hidden).toBe(false)
})

test("a paired offline bridge retries without showing the pairing form again", async () => {
  const { nodes, calls } = await popup({
    paired: true,
    connected: false,
    enabled: true,
    profileGranted: true,
    serverURL: "http://127.0.0.1:4096",
    message: "Reconnecting to YCoding",
  })
  expect(nodes.get("#connection-state").textContent).toBe("Reconnecting")
  expect(nodes.get("#pairing-view").hidden).toBe(true)
  expect(nodes.get("#reconnecting-view").hidden).toBe(false)
  expect(nodes.get("#connected-view").hidden).toBe(true)
  expect(nodes.get("#forget").hidden).toBe(false)
  expect(calls).toEqual([{ type: "status" }])
})

test("an explicitly stopped pairing stays saved without claiming to reconnect", async () => {
  const { nodes } = await popup({
    paired: true,
    connected: false,
    enabled: false,
    profileGranted: false,
    message: "Stopped",
  })
  expect(nodes.get("#connection-state").textContent).toBe("Disconnected")
  expect(nodes.get("#pairing-view").hidden).toBe(true)
  expect(nodes.get("#reconnecting-view").hidden).toBe(false)
  expect(nodes.get("#reconnecting-message").textContent).toContain("paused")
  expect(nodes.get("#connect").hidden).toBe(false)
})

test("retrying a paused connection reuses the saved pairing", async () => {
  const { nodes, calls, dispatch } = await popup(
    { paired: true, connected: false, enabled: false, serverURL: "http://127.0.0.1:4096" },
    { paired: true, connected: true, enabled: true, profileGranted: true, message: "Connected" },
  )
  await dispatch("#connect", "click")
  expect(calls.at(-1)).toEqual({ type: "connect", serverURL: "http://127.0.0.1:4096" })
  expect(nodes.get("#connection-state").textContent).toBe("Connected")
  expect(nodes.get("#pairing-view").hidden).toBe(true)
  expect(nodes.get("#connect").hidden).toBe(true)
})

test("an open popup updates its connection indicator after background recovery", async () => {
  const { nodes, tick } = await popup([
    { paired: true, connected: false, profileGranted: true, message: "Reconnecting" },
    { paired: true, connected: true, profileGranted: true, message: "Connected" },
  ])
  expect(nodes.get("#connection-state").textContent).toBe("Reconnecting")
  await tick()
  expect(nodes.get("#connection-state").textContent).toBe("Connected")
  expect(nodes.get("#connected-view").hidden).toBe(false)
})

test("a status response started before pairing cannot replace the connected view", async () => {
  const stale = Promise.withResolvers()
  const disconnected = { paired: false, connected: false, profileGranted: false, message: "Not paired" }
  const { nodes, tick, dispatch } = await popup([disconnected, stale.promise], {
    paired: true,
    connected: true,
    profileGranted: false,
    message: "Paired",
  })
  const pending = tick()
  nodes.get("#secret").value = "test-pairing-code"
  await dispatch("#pairing-form", "submit")
  stale.resolve(disconnected)
  await pending
  expect(nodes.get("#connection-state").textContent).toBe("Connected")
  expect(nodes.get("#pairing-view").hidden).toBe(true)
})

test("an unavailable background worker hides stale connected controls", async () => {
  const failed = Promise.withResolvers()
  const { nodes, tick } = await popup([
    { paired: true, connected: true, profileGranted: true, message: "Connected" },
    failed.promise,
  ])
  const pending = tick()
  failed.reject(new Error("worker unavailable"))
  await pending
  expect(nodes.get("#connection-state").textContent).toBe("Status unavailable")
  expect(nodes.get("#connected-view").hidden).toBe(true)
  expect(nodes.get("#forget").hidden).toBe(true)
})

test("connected summary has no access or tab-sharing controls", async () => {
  const { nodes, calls } = await popup({
    paired: true,
    connected: true,
    profileGranted: true,
    currentShared: false,
    message: "2 tabs listed",
  })
  expect(nodes.get("#pairing-view").hidden).toBe(true)
  expect(nodes.get("#connected-view").hidden).toBe(false)
  expect(nodes.get("#forget").hidden).toBe(false)
  expect(calls).toEqual([{ type: "status" }])
})

test("forgetting pairing restores the connection form", async () => {
  const { nodes, calls, dispatch } = await popup(
    { paired: true, connected: true, profileGranted: true, message: "Connected" },
    { paired: false, connected: false, profileGranted: false, message: "Pairing forgotten" },
  )
  await dispatch("#forget", "click")
  expect(calls.at(-1)).toEqual({ type: "forget" })
  expect(nodes.get("#connection-state").textContent).toBe("Disconnected")
  expect(nodes.get("#pairing-view").hidden).toBe(false)
  expect(nodes.get("#forget").hidden).toBe(true)
})

test("popup markup and colors support the three views in both themes", async () => {
  const html = await Bun.file(new URL("../popup.html", import.meta.url)).text()
  const css = await Bun.file(new URL("../popup.css", import.meta.url)).text()
  for (const id of ["connection-state", "pairing-view", "connected-view", "reconnecting-view", "forget"])
    expect(html).toContain(`id="${id}"`)
  for (const id of ["grant-profile", "revoke-profile", "share", "revoke", "settings-toggle", "profile-state"])
    expect(html).not.toContain(`id="${id}"`)
  expect(html).toContain("including the active tab")
  expect(html.split('id="pairing-view"')[1].split('id="reconnecting-view"')[0]).toContain(
    "eligible current and future tabs, including the active tab",
  )
  expect(html.split('id="pairing-view"')[1].split('id="reconnecting-view"')[0]).toContain("debugger warning")
  expect(html).toContain('aria-live="polite"')
  expect(css).toContain("prefers-color-scheme: dark")
  expect(css).toContain("prefers-color-scheme: light")
})

async function popup(initial, next) {
  const nodes = new Map()
  const calls = []
  const intervals = []
  const statuses = Array.isArray(initial) ? [...initial] : [initial]
  for (const id of [
    "server",
    "secret",
    "pair",
    "pairing-form",
    "pairing-view",
    "connected-view",
    "reconnecting-view",
    "reconnecting-message",
    "connection-state",
    "connection-actions",
    "connect",
    "forget",
    "feedback",
    "status",
  ])
    nodes.set(`#${id}`, node())
  nodes.get("#server").value = "http://127.0.0.1:4096"
  globalThis.document = { querySelector: (selector) => nodes.get(selector) }
  globalThis.setInterval = (callback) => intervals.push(callback)
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(message)
        if (message.type === "status") return statuses.length > 1 ? statuses.shift() : statuses[0]
        return next ?? statuses[0]
      },
    },
  }
  await import(`../popup.js?popup-test=${crypto.randomUUID()}`)
  await Promise.resolve()
  return {
    nodes,
    calls,
    dispatch: async (selector, type) => {
      await nodes.get(selector).listeners.get(type)({ preventDefault() {} })
    },
    tick: async () => {
      expect(intervals).toHaveLength(1)
      await intervals[0]()
    },
  }
}

function node() {
  return {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    dataset: {},
    attributes: new Map(),
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener)
    },
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
  }
}
