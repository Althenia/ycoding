import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { createFakeControls, createFakePage } from "./fake-page.js"
import { timing } from "../../indicator.js"

const harness = createHarness()
harness.storage.browserProfileGrant = { serverID: "server-restored-1" }
harness.storage.browserProfileDeniedTabs = { serverID: "server-restored-1", tabIDs: [18] }
const originalChrome = globalThis.chrome
const originalWebSocket = globalThis.WebSocket
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const intervals = new Map()

beforeAll(async () => {
  globalThis.chrome = harness.chrome
  globalThis.WebSocket = harness.FakeWebSocket
  globalThis.setInterval = (callback, delay) => {
    const id = intervals.size + 1 + Math.max(0, ...intervals.keys())
    intervals.set(id, { callback, delay })
    return id
  }
  globalThis.clearInterval = (id) => void intervals.delete(id)
  await import("../../service-worker.js")
})

afterAll(() => {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  if (originalChrome === undefined) Reflect.deleteProperty(globalThis, "chrome")
  else globalThis.chrome = originalChrome
  if (originalWebSocket === undefined) Reflect.deleteProperty(globalThis, "WebSocket")
  else globalThis.WebSocket = originalWebSocket
})

describe("Chrome bridge service worker", () => {
  test("restores only authenticated backend connectivity and backs off without replaying tabs or actions", async () => {
    await waitFor(() => harness.FakeWebSocket.instances.length === 1)
    const restored = harness.FakeWebSocket.instances[0]
    expect(restored.outgoing).toContainEqual({
      type: "authenticate",
      version: 6,
      extensionID: "extension-test",
      serverID: "server-restored-1",
      credential: "r".repeat(43),
    })
    expect(harness.commands).toEqual([])
    expect(harness.attached).toEqual([])
    expect(harness.storage.browserProfileGrant).toBeUndefined()
    expect(harness.storage.browserProfileDeniedTabs).toMatchObject({ serverID: "server-restored-1", tabIDs: [18] })
    expect(harness.alarms.created).toContainEqual({
      name: "browser-recovery",
      periodInMinutes: 0.5,
      persistAcrossSessions: true,
    })

    await restored.disconnect()
    await waitFor(() => harness.alarms.created.some((alarm) => alarm.name === "browser-reconnect"))
    expect(harness.alarms.created.find((alarm) => alarm.name === "browser-reconnect")).toMatchObject({
      delayInMinutes: 1 / 60,
    })
    await harness.alarms.fire("browser-reconnect")
    await waitFor(() => harness.FakeWebSocket.instances.length === 2)
    const reconnected = harness.FakeWebSocket.instances[1]
    expect(reconnected.outgoing[0]).toMatchObject({ type: "authenticate", serverID: "server-restored-1" })
    expect(reconnected.outgoing.some((message) => message.type === "shared")).toBe(false)
    expect(harness.commands).toEqual([])
  })

  test("keeps durable recovery active through a silent disconnect but clears it on stop and forget", async () => {
    harness.reset()
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "q".repeat(32) })
    const first = harness.FakeWebSocket.instance
    expect((await popup(harness.runtimeMessages, { type: "status" })).enabled).toBe(true)
    expect(harness.alarms.created).toContainEqual({
      name: "browser-recovery",
      periodInMinutes: 0.5,
      persistAcrossSessions: true,
    })
    await harness.alarms.fire("browser-recovery")
    expect(harness.FakeWebSocket.instance).toBe(first)
    expect(harness.alarms.created.some((alarm) => alarm.name === "browser-recovery")).toBe(true)

    first.readyState = 3
    await harness.alarms.fire("browser-recovery")
    await waitFor(() => harness.FakeWebSocket.instance !== first)
    const recovered = harness.FakeWebSocket.instance
    await waitFor(() => recovered.outgoing.some((message) => message.type === "profile_access"))
    expect(recovered.outgoing[0]).toMatchObject({ type: "authenticate", serverID: "server-paired" })
    expect(recovered.outgoing).toContainEqual({ type: "profile_access", enabled: true })
    expect(harness.storage.browserProfileGrant).toBeUndefined()
    await recovered.receive({ type: "control", action: "stop" })
    expect(await popup(harness.runtimeMessages, { type: "status" })).toMatchObject({
      paired: true,
      connected: false,
      enabled: false,
    })
    expect(harness.alarms.created).toEqual([])
    await harness.alarms.fire("browser-recovery")
    expect(harness.FakeWebSocket.instance).toBe(recovered)

    await popup(harness.runtimeMessages, { type: "connect", serverURL: "http://127.0.0.1:4096" })
    expect((await popup(harness.runtimeMessages, { type: "status" })).enabled).toBe(true)
    expect(harness.alarms.created.some((alarm) => alarm.name === "browser-recovery")).toBe(true)
    await popup(harness.runtimeMessages, { type: "forget" })
    expect((await popup(harness.runtimeMessages, { type: "status" })).enabled).toBe(false)
    expect(harness.alarms.created).toEqual([])
    expect(harness.storage.browserPairing).toBeUndefined()
    expect(harness.storage.browserProfileGrant).toBeUndefined()
  })

  test("keeps recovery active until an offline pending forget reaches the paired server", async () => {
    harness.reset()
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "y".repeat(32) })
    await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    harness.FakeWebSocket.failConnections = true
    await popup(harness.runtimeMessages, { type: "forget" })
    expect(harness.storage.browserPairing).toMatchObject({ enabled: true, forgetPending: true })
    expect(harness.alarms.created.some((alarm) => alarm.name === "browser-recovery")).toBe(true)
    harness.FakeWebSocket.failConnections = false
    await harness.alarms.fire("browser-recovery")
    await waitFor(() => harness.storage.browserPairing === undefined)
    expect(harness.alarms.created).toEqual([])
  })

  test("Chrome startup wakes a saved pairing without requiring the alarm to persist", async () => {
    harness.reset()
    await popup(harness.runtimeMessages, {
      type: "pair",
      serverURL: "http://127.0.0.1:4096",
      secret: "c".repeat(32),
    })
    const first = harness.FakeWebSocket.instance
    first.readyState = 3
    await harness.runtimeStartup.emit()
    await waitFor(() => harness.FakeWebSocket.instance !== first)
    expect(harness.FakeWebSocket.instance.outgoing[0]).toMatchObject({
      type: "authenticate",
      serverID: "server-paired",
    })
    await harness.FakeWebSocket.instance.emit("close", { code: 4400 })
    expect(harness.storage.browserPairing).toBeDefined()
    expect((await popup(harness.runtimeMessages, { type: "status" })).paired).toBe(true)
    await popup(harness.runtimeMessages, { type: "forget" })
  })

  test("revokes an authenticated bridge when the pairing cannot be saved", async () => {
    harness.reset()
    const save = harness.chrome.storage.local.set
    harness.chrome.storage.local.set = async (values) => {
      if (values.browserPairing) throw new Error("storage unavailable")
      return save(values)
    }
    try {
      const result = await popup(harness.runtimeMessages, {
        type: "pair", serverURL: "http://127.0.0.1:4096", secret: "s".repeat(32),
      })
      expect(result).toMatchObject({ paired: false, connected: false, profileGranted: false })
      expect(harness.FakeWebSocket.instance.outgoing).toContainEqual({ type: "forget" })
      expect(harness.FakeWebSocket.instance.readyState).toBe(harness.FakeWebSocket.CLOSED)
    } finally {
      harness.chrome.storage.local.set = save
    }
  })

  test("pairing lists eligible existing and future tabs and acts on the active tab only after command dispatch", async () => {
    harness.reset()
    harness.page.profileTabs = [
      { id: 17, active: true, windowId: 1, url: "https://example.test/form", title: "Foreground" },
      { id: 18, active: false, windowId: 1, url: "https://example.test/background", title: "Background" },
      { id: 19, active: false, windowId: 1, url: "chrome://settings", title: "Restricted" },
      { id: 20, active: false, windowId: 1, url: "https://user:secret@example.test/private", title: "Credential" },
    ]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "a".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      expect((await popup(harness.runtimeMessages, { type: "status" })).profileGranted).toBe(true)
      expect(socket.outgoing.findIndex((message) => message.type === "profile_access")).toBeLessThan(
        socket.outgoing.findIndex((message) => message.type === "shared"),
      )
      const shared = socket.outgoing.filter((message) => message.type === "shared" && message.mode === "profile")
      expect(shared.map((message) => message.url)).toEqual([
        "https://example.test/form",
        "https://example.test/background",
      ])
      expect(harness.attached).toEqual([])
      harness.page.profileTabs.push({
        id: 21,
        active: false,
        windowId: 1,
        url: "https://example.test/future",
        title: "Future",
      })
      await harness.tabCreated.emit(harness.page.profileTabs.at(-1))
      expect(socket.outgoing).toContainEqual(
        expect.objectContaining({ type: "shared", mode: "profile", url: "https://example.test/future" }),
      )
      const foreground = shared[0]
      await socket.receive({
        type: "observe",
        callID: "foreground-observe",
        tabID: foreground.tabID,
        generation: "bridge-1",
      })
      const observed = socket.outgoing.find((message) => message.callID === "foreground-observe")
      expect(observed).toMatchObject({ type: "observation", tabID: foreground.tabID })
      expect(harness.attached).toEqual([{ tabId: 17 }])
      for (const [callID, input, method] of [
        ["foreground-type", { type: "type", ref: "b1", text: "synthetic-value" }, "Input.insertText"],
        ["foreground-click", { type: "click", ref: "b1" }, "Input.dispatchMouseEvent"],
        ["foreground-scroll", { type: "scroll", deltaY: 12 }, "Input.dispatchMouseEvent"],
        ["foreground-capture", { type: "capture" }, "Page.captureScreenshot"],
      ]) {
        await socket.receive(action(callID, foreground.tabID, observed, input))
        expect(socket.outgoing.find((message) => message.callID === callID)).toMatchObject({
          type: "result",
          status: "completed",
        })
        expect(harness.commands.some((command) => command.source.tabId === 17 && command.method === method)).toBe(true)
      }
      expect(harness.removed).toEqual([])
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("reconnect reenumerates eligible tabs with fresh identities and retains native Cancel denial", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "https://example.test/form", title: "Private" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "c".repeat(32) })
    const first = harness.FakeWebSocket.instance
    const listed = first.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
    expect(listed).toBeDefined()
    await first.disconnect()
    await harness.alarms.fire("browser-reconnect")
    await waitFor(() => harness.FakeWebSocket.instance !== first)
    const second = harness.FakeWebSocket.instance
    await waitFor(() => second.outgoing.some((message) => message.type === "shared"))
    const reloaded = second.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
    expect(reloaded.tabID).not.toBe(listed.tabID)
    expect(harness.attached).toEqual([])
    await second.receive({ type: "observe", callID: "before-cancel", tabID: reloaded.tabID, generation: "bridge-1" })
    await harness.debuggerDetach.emit({ tabId: 18 }, "canceled_by_user")
    await harness.tabUpdated.emit(18, { url: "https://example.test/form" }, harness.page.profileTabs[0])
    expect(second.outgoing.filter((message) => message.type === "shared" && message.mode === "profile")).toHaveLength(1)
    expect(harness.storage.browserProfileDeniedTabs).toMatchObject({ serverID: "server-paired", tabIDs: [18] })
    await second.receive({ type: "control", action: "stop" })
  })

  test("an explicit stop revokes attached personal tabs without closing them", async () => {
    harness.reset()
    harness.page.profileTabs = [
      { id: 17, active: true, url: "https://example.test/form", title: "Active" },
      { id: 18, active: false, url: "https://example.test/second?secret=hidden", title: "Background" },
    ]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "z".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      expect((await popup(harness.runtimeMessages, { type: "status" })).profileGranted).toBe(true)
      const shared = socket.outgoing.filter((message) => message.type === "shared" && message.mode === "profile")
      expect(shared).toHaveLength(2)
      expect(harness.attached).toEqual([])
      expect((await popup(harness.runtimeMessages, { type: "status" })).message).toBe("2 tabs listed")
      expect(shared[1].url).toBe("https://example.test/second?secret=hidden")
      await socket.receive({
        type: "observe",
        callID: "profile-observe",
        tabID: shared[1].tabID,
        generation: "bridge-1",
      })
      expect(harness.attached).toEqual([{ tabId: 18 }])
      expect(socket.outgoing.find((message) => message.callID === "profile-observe")).toMatchObject({
        type: "observation",
      })
      await socket.receive({ type: "control", action: "stop" })
      expect(harness.detached).toContainEqual({ tabId: 18 })
      expect(harness.removed).toEqual([])
      expect((await popup(harness.runtimeMessages, { type: "status" })).profileGranted).toBe(false)
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("reports why a tab was revoked and links the re-listed tab to its predecessor after leaving approved sites", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: false, url: "https://example.test/form", title: "Form" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "m".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const first = socket.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
      expect(first.replaces).toBeUndefined()
      const moved = { id: 17, active: false, url: "https://other.test/page", title: "Other" }
      harness.page.profileTabs = [moved]
      await harness.tabUpdated.emit(17, { url: moved.url }, moved)
      await waitFor(() => socket.outgoing.filter((message) => message.type === "shared").length === 2)
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: first.tabID, reason: "navigated" })
      const second = socket.outgoing.filter((message) => message.type === "shared")[1]
      expect(second.tabID).not.toBe(first.tabID)
      expect(second.replaces).toBe(first.tabID)
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("links the tab re-listed after a debugger-observed navigation to the revoked tab", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Form" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "n".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const first = socket.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
      await socket.receive({ type: "observe", tabID: first.tabID, generation: "bridge-1", callID: "before-frame-navigation" })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Page.frameNavigated", { frame: { url: "https://other.test/secret" } })
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: first.tabID, reason: "navigated" })
      const moved = { id: 17, active: true, url: "https://other.test/secret", title: "Other" }
      harness.page.profileTabs = [moved]
      await harness.tabUpdated.emit(17, { url: moved.url }, moved)
      const second = socket.outgoing.filter((message) => message.type === "shared")[1]
      expect(second.replaces).toBe(first.tabID)
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("reports a closed tab as closed and never links a later tab with the same ID to it", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "https://example.test/form", title: "Form" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "p".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const first = socket.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
      await harness.tabRemoved.emit(18, { windowId: 1, isWindowClosing: false })
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: first.tabID, reason: "closed" })
      await harness.tabUpdated.emit(18, { url: "https://example.test/form" }, harness.page.profileTabs[0])
      const relisted = socket.outgoing.filter((message) => message.type === "shared")[1]
      expect(relisted.replaces).toBeUndefined()
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("bounds Chrome's detach reason and never re-lists the detached tab", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "https://example.test/form", title: "Form" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "q".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const first = socket.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
      await socket.receive({ type: "observe", callID: "before-long-detach", tabID: first.tabID, generation: "bridge-1" })
      await harness.debuggerDetach.emit({ tabId: 18 }, "x".repeat(200))
      expect(socket.outgoing).toContainEqual({
        type: "revoked", tabID: first.tabID, reason: "detached", detachReason: "x".repeat(64),
      })
      await harness.tabUpdated.emit(18, { url: "https://example.test/form" }, harness.page.profileTabs[0])
      expect(socket.outgoing.filter((message) => message.type === "shared")).toHaveLength(1)
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("reports access_revoked for every profile tab when pairing is forgotten", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "https://example.test/form", title: "Form" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "r".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    const first = socket.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
    await socket.receive({ type: "control", action: "forget" })
    expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: first.tabID, reason: "access_revoked" })
  })

  test("a new pairing resets native Cancel denial without reusing a separate grant", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "https://example.test/form", title: "Private" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "j".repeat(32) })
    const previous = harness.FakeWebSocket.instance
    const first = previous.outgoing.find((message) => message.type === "shared")
    await previous.receive({
      type: "observe",
      callID: "new-pair-before-cancel",
      tabID: first.tabID,
      generation: "bridge-1",
    })
    await harness.debuggerDetach.emit({ tabId: 18 }, "canceled_by_user")
    expect(harness.storage.browserProfileDeniedTabs).toMatchObject({ tabIDs: [18] })
    const result = await popup(harness.runtimeMessages, {
      type: "pair",
      serverURL: "http://127.0.0.1:4096",
      secret: "k".repeat(32),
    })
    expect(result).toMatchObject({ connected: true, profileGranted: true })
    expect(harness.storage.browserProfileGrant).toBeUndefined()
    expect(previous.outgoing).toContainEqual({ type: "profile_access", enabled: false })
    expect(harness.storage.browserProfileDeniedTabs).toBeUndefined()
    expect(harness.FakeWebSocket.instance.outgoing).toContainEqual(
      expect.objectContaining({ type: "shared", mode: "profile", url: "https://example.test/form" }),
    )
    await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  })

  test("switching a paused pairing revokes the old server without listing tabs to it", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/private", title: "Private" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "j".repeat(32) })
    await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    const nextSocketIndex = harness.FakeWebSocket.instances.length
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "k".repeat(32) })
    const revocation = harness.FakeWebSocket.instances[nextSocketIndex]
    expect(revocation.outgoing[0]).toMatchObject({ type: "authenticate", serverID: "server-paired" })
    expect(revocation.outgoing).toContainEqual({ type: "forget" })
    expect(
      revocation.outgoing.some(
        (message) => message.type === "shared" || (message.type === "profile_access" && message.enabled),
      ),
    ).toBe(false)
    expect(harness.FakeWebSocket.instance.outgoing).toContainEqual(
      expect.objectContaining({ type: "shared", mode: "profile", url: "https://example.test/private" }),
    )
    await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  })

  test("discovers a tab that becomes eligible after pairing", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "about:blank", title: "Loading" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "u".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      expect(socket.outgoing.filter((message) => message.type === "shared")).toEqual([])
      harness.page.profileTabs[0].url = "https://example.test/loaded"
      await harness.tabUpdated.emit(
        18,
        { url: "https://example.test/loaded", status: "complete" },
        harness.page.profileTabs[0],
      )
      expect(socket.outgoing).toContainEqual(
        expect.objectContaining({ type: "shared", mode: "profile", url: "https://example.test/loaded" }),
      )
      expect(harness.attached).toEqual([])
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("profile metadata never consumes the owned tab limit", async () => {
    harness.reset()
    harness.page.profileTabs = [
      { id: 17, active: true, windowId: 1, url: "https://example.test/form", title: "Active" },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: 30 + index,
        active: false,
        windowId: 1,
        url: `https://example.test/tab-${index}`,
        title: "Background",
      })),
    ]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "m".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      expect(socket.outgoing.filter((message) => message.type === "shared" && message.mode === "profile")).toHaveLength(
        10,
      )
      await socket.receive({
        type: "open",
        callID: "owned-with-profile",
        tabID: "btab_owned_with_profile",
        generation: "bridge-1",
        url: "https://example.test/owned",
      })
      expect(socket.outgoing).toContainEqual(expect.objectContaining({ type: "opened", callID: "owned-with-profile" }))
      expect(socket.outgoing.filter((message) => message.type === "shared" && !message.mode)).toHaveLength(0)
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("shows a per-tab badge only while attached and clears it on Chrome's native Cancel detach", async () => {
    harness.reset()
    harness.page.profileTabs = [
      { id: 17, active: true, windowId: 1, url: "https://example.test/form", title: "Active" },
    ]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "b".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const shared = socket.outgoing.find((message) => message.type === "shared")
      expect(harness.badges.filter((badge) => badge.text === "ON")).toEqual([])
      await socket.receive({ type: "observe", callID: "badge-attach", tabID: shared.tabID, generation: "bridge-1" })
      expect(harness.badges.at(-1)).toEqual({ tabId: 17, text: "ON" })
      await harness.tabActivations.emit({ tabId: 99, windowId: 2 })
      expect(harness.badges.at(-1)).toEqual({ tabId: 17, text: "ON" })
      harness.page.active = false
      harness.page.profileTabs[0].active = false
      await harness.tabActivations.emit({ tabId: 99, windowId: 1 })
      expect(harness.badges.at(-1)).toEqual({ tabId: 17, text: "ON" })
      await harness.debuggerDetach.emit({ tabId: 17 }, "canceled_by_user")
      expect(harness.badges.at(-1)).toEqual({ tabId: 17, text: "" })
      expect(socket.outgoing).toContainEqual({
        type: "revoked", tabID: shared.tabID, reason: "detached", detachReason: "canceled_by_user",
      })
      await socket.receive({ type: "observe", callID: "after-cancel", tabID: shared.tabID, generation: "bridge-1" })
      expect(harness.commands.filter((item) => item.method === "Accessibility.getFullAXTree")).toHaveLength(1)
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("native Cancel prevents a profile tab from being rediscovered within the current pairing", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 18, active: false, url: "https://example.test/form", title: "Background" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "v".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const shared = socket.outgoing.find((message) => message.type === "shared" && message.mode === "profile")
      await socket.receive({ type: "observe", callID: "initial-profile", tabID: shared.tabID, generation: "bridge-1" })
      expect(harness.badges.at(-1)).toEqual({ tabId: 18, text: "ON" })
      await harness.debuggerDetach.emit({ tabId: 18 }, "canceled_by_user")
      expect(harness.badges.at(-1)).toEqual({ tabId: 18, text: "" })
      expect(harness.storage.browserProfileDeniedTabs).toMatchObject({ serverID: "server-paired", tabIDs: [18] })
      await harness.tabUpdated.emit(18, { url: "https://example.test/form" }, harness.page.profileTabs[0])
      expect(socket.outgoing.filter((message) => message.type === "shared" && message.mode === "profile")).toHaveLength(
        1,
      )
      await socket.receive({
        type: "observe",
        callID: "after-profile-cancel",
        tabID: shared.tabID,
        generation: "bridge-1",
      })
      expect(harness.attached).toEqual([{ tabId: 18 }])
      expect(socket.outgoing.find((message) => message.callID === "after-profile-cancel")).toMatchObject({
        type: "error",
      })
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("groups only inactive paired tabs and reverses only extension-created groups", async () => {
    harness.reset()
    harness.page.profileTabs = [
      { id: 17, active: true, groupId: -1, windowId: 1, url: "https://example.test/form", title: "Active" },
      { id: 18, active: false, groupId: -1, windowId: 1, url: "https://example.test/second", title: "Background" },
      { id: 19, active: false, groupId: -1, windowId: 1, url: "https://example.test/third", title: "Third" },
    ]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "x".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const profile = socket.outgoing.filter((message) => message.type === "shared" && message.mode === "profile")
      const request = {
        type: "action",
        generation: "bridge-1",
        documentGeneration: 1,
        observationRevision: 0,
        allowedOrigins: ["https://example.test"],
      }
      await socket.receive({
        ...request,
        tabID: profile[0].tabID,
        callID: "active-group",
        action: { type: "group", tabIDs: [profile[0].tabID], title: "Task" },
      })
      expect(harness.grouped).toEqual([])
      await socket.receive({
        ...request,
        tabID: profile[1].tabID,
        callID: "profile-group",
        action: { type: "group", tabIDs: [profile[1].tabID, profile[2].tabID], title: "Task" },
      })
      expect(harness.grouped).toEqual([{ tabIds: [18, 19] }])
      expect(harness.groupUpdates).toEqual([{ groupId: 7, updateProperties: { title: "Task" } }])
      expect(socket.outgoing.find((message) => message.callID === "profile-group")).toMatchObject({
        type: "result",
        groupID: 7,
      })
      harness.page.profileTabs.push({
        id: 20,
        active: false,
        groupId: 7,
        windowId: 1,
        url: "https://example.test/other",
        title: "Outside",
      })
      await socket.receive({
        ...request,
        tabID: profile[1].tabID,
        callID: "changed-group",
        action: { type: "ungroup", tabIDs: [profile[1].tabID, profile[2].tabID], groupID: 7 },
      })
      expect(harness.ungrouped).toEqual([])
      harness.page.profileTabs.pop()
      await socket.receive({
        ...request,
        tabID: profile[1].tabID,
        callID: "other-group",
        action: { type: "ungroup", tabIDs: [profile[1].tabID, profile[2].tabID], groupID: 8 },
      })
      expect(harness.ungrouped).toEqual([])
      await socket.receive({
        ...request,
        tabID: profile[1].tabID,
        callID: "revert-group",
        action: { type: "ungroup", tabIDs: [profile[1].tabID, profile[2].tabID], groupID: 7 },
      })
      expect(harness.ungrouped).toEqual([[18, 19]])
      expect(harness.removed).toEqual([])
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })
  test("opens only a new background tab and closes it without touching a personal tab", async () => {
    harness.reset()
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "g".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      await socket.receive({
        type: "open",
        callID: "open-owned",
        tabID: "btab_owned",
        generation: "bridge-1",
        url: "https://example.test/new",
      })
      expect(harness.created).toEqual([{ url: "about:blank", active: false }])
      expect(harness.attached).toEqual([{ tabId: 24 }])
      expect(harness.commands[0]).toEqual({
        source: { tabId: 24 }, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true },
      })
      expect(harness.commands.filter((item) => item.method === "Emulation.setFocusEmulationEnabled")).toEqual([
        { source: { tabId: 24 }, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      ])
      expect(socket.outgoing).toContainEqual(
        expect.objectContaining({
          type: "opened",
          callID: "open-owned",
          tabID: "btab_owned",
          url: "https://example.test/new",
        }),
      )
      expect(harness.commands).toContainEqual(
        expect.objectContaining({
          source: { tabId: 24 },
          method: "Page.navigate",
          params: { url: "https://example.test/new" },
        }),
      )
      await socket.receive({ type: "close", callID: "close-owned", tabID: "btab_owned", generation: "bridge-1" })
      expect(harness.removed).toEqual([24])
      expect(socket.outgoing).toContainEqual({
        type: "closed",
        callID: "close-owned",
        tabID: "btab_owned",
        generation: "bridge-1",
      })
      await socket.receive({
        type: "open",
        callID: "stale",
        tabID: "btab_stale",
        generation: "old",
        url: "https://example.test",
      })
      expect(harness.created).toHaveLength(1)
      expect(harness.removed).toEqual([24])
      await socket.receive({
        type: "open",
        callID: "open-active",
        tabID: "btab_active",
        generation: "bridge-1",
        url: "https://example.test/active",
      })
      harness.page.ownedActive = true
      await socket.receive({
        type: "observe",
        callID: "owned-active-observe",
        tabID: "btab_active",
        generation: "bridge-1",
      })
      const activeObservation = socket.outgoing.find((item) => item.callID === "owned-active-observe")
      expect(activeObservation).toMatchObject({ type: "observation" })
      await socket.receive(
        action("owned-active-scroll", "btab_active", activeObservation, { type: "scroll", deltaY: 24 }),
      )
      expect(socket.outgoing.find((item) => item.callID === "owned-active-scroll")).toMatchObject({
        type: "result",
        status: "completed",
      })
      await socket.receive({ type: "close", callID: "close-active", tabID: "btab_active", generation: "bridge-1" })
      expect(socket.outgoing.find((item) => item.callID === "close-active")).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(harness.removed).toEqual([24])
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("waits for a newly navigated background page before reading its Chrome history", async () => {
    harness.reset()
    harness.page.historyUnavailable = 2
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "n".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      await socket.receive({
        type: "open",
        callID: "warming-page",
        tabID: "btab_warming",
        generation: "bridge-1",
        url: "https://example.test/new",
      })
      expect(socket.outgoing).toContainEqual(expect.objectContaining({ type: "opened", callID: "warming-page" }))
      expect(harness.commands.filter((item) => item.method === "Page.getNavigationHistory")).toHaveLength(3)
      expect(harness.removed).toEqual([])
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("releases active owned tabs without closing them and closes inactive owned tabs without revoking paired tabs", async () => {
    harness.reset()
    harness.page.profileTabs = [
      { id: 17, active: true, windowId: 1, url: "https://example.test/form", title: "Personal" },
    ]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "o".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    try {
      const personal = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({
        type: "open",
        callID: "open-foreground",
        tabID: "btab_foreground",
        generation: "bridge-1",
        url: "https://example.test/foreground",
      })
      harness.page.ownedActive = true
      harness.page.active = false
      await harness.tabActivations.emit({ tabId: 24 })
      await socket.receive({ type: "release", tabID: "btab_foreground", generation: "bridge-1" })
      expect(harness.detached).toContainEqual({ tabId: 24 })
      expect(harness.removed).toEqual([])
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: "btab_foreground", reason: "closed" })
      expect(harness.detached).not.toContainEqual({ tabId: 17 })

      harness.page.ownedActive = false
      await socket.receive({
        type: "open",
        callID: "open-inactive",
        tabID: "btab_inactive",
        generation: "bridge-1",
        url: "https://example.test/inactive",
      })
      await socket.receive({ type: "release", tabID: "btab_inactive", generation: "bridge-1" })
      expect(harness.removed).toEqual([24])
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: "btab_inactive", reason: "closed" })
      await socket.receive({ type: "release", tabID: personal.tabID, generation: "bridge-1" })
      expect(harness.detached).not.toContainEqual({ tabId: 17 })
      await socket.receive({
        type: "observe",
        tabID: personal.tabID,
        generation: "bridge-1",
        callID: "personal-after-release",
      })
      expect(socket.outgoing.find((message) => message.callID === "personal-after-release")).toMatchObject({
        type: "observation",
      })
    } finally {
      await socket.receive({ type: "control", action: "stop" })
    }
  })

  test("drops owned references and closes inactive agent tabs on disconnect without replay", async () => {
    harness.reset()
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "h".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    await socket.receive({
      type: "open",
      callID: "disconnect-open",
      tabID: "btab_disconnected",
      generation: "bridge-1",
      url: "https://example.test/new",
    })
    expect(harness.removed).toEqual([])
    await socket.disconnect()
    expect(harness.removed).toEqual([24])
    const created = harness.created.length
    await harness.alarms.fire("browser-reconnect")
    expect(harness.created).toHaveLength(created)
    expect(
      harness.FakeWebSocket.instance.outgoing.some((item) => item.type === "shared" || item.type === "opened"),
    ).toBe(false)
    await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  })

  test("fails closed when the bridge disconnects before background tab creation settles", async () => {
    harness.reset()
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "i".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    let release
    harness.page.holdCreate = new Promise((resolve) => {
      release = resolve
    })
    const opening = socket.receive({
      type: "open",
      callID: "raced-open",
      tabID: "btab_raced",
      generation: "bridge-1",
      url: "https://example.test/race",
    })
    await waitFor(() => harness.created.length === 1)
    await socket.disconnect()
    release()
    await opening
    expect(harness.attached).toEqual([])
    expect(harness.removed).toEqual([24])
    expect(socket.outgoing.some((item) => item.type === "opened")).toBe(false)
  })

  test("dispatches site-approved mutations while retaining action fences", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]

    try {
      await popup(harness.runtimeMessages, {
        type: "pair",
        serverURL: "http://127.0.0.1:4096",
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
        }),
      ).toMatchObject({ connected: true })
      socket = harness.FakeWebSocket.instance
      expect(socket.outgoing[0]).toMatchObject({ type: "authenticate", serverID: "server-paired" })
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({
        type: "observe",
        callID: "observe-1",
        tabID: shared.tabID,
        generation: "bridge-1",
      })
      const observation = socket.outgoing.find((message) => message.type === "observation")

      await socket.receive(
        action("navigate-approved", shared.tabID, observation, { type: "navigate", url: "https://example.test/next" }),
      )
      await socket.receive(action("click-approved", shared.tabID, observation, { type: "click", ref: "b1" }))
      await socket.receive(
        action("type-approved", shared.tabID, observation, { type: "type", ref: "b1", text: "hello" }),
      )
      for (const method of ["Page.navigate", "Input.dispatchMouseEvent", "Input.insertText"])
        expect(harness.commands.some((item) => item.method === method)).toBe(true)
      for (const callID of ["navigate-approved", "click-approved", "type-approved"])
        expect(socket.outgoing).toContainEqual(expect.objectContaining({ type: "result", callID, status: "completed" }))
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

  test("revokes autonomous cross-origin navigation without forwarding destination metadata or content", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "d".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "before-revoke" })
      expect(harness.attached).toEqual([{ tabId: 17 }])
      await harness.debuggerEvents.emit({ tabId: 17 }, "Page.frameNavigated", {
        frame: { url: "https://other.test/secret" },
      })
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: shared.tabID, reason: "navigated" })
      expect(JSON.stringify(socket.outgoing)).not.toContain("other.test")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "after-revoke" })
      expect(socket.outgoing.find((item) => item.callID === "after-revoke")).toMatchObject({ type: "error" })
      expect(harness.commands.filter((item) => item.method === "Accessibility.getFullAXTree")).toHaveLength(1)
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

  test("requires a static cross-site link destination before mouse dispatch", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "e".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      harness.page.href = "https://other.test/arrive"
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-link" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-link")
      expect(observation.elements[0].destination).toBe("https://other.test/arrive")
      const denied = action("unapproved-link", shared.tabID, observation, { type: "click", ref: "b1" })
      await socket.receive(denied)
      expect(socket.outgoing.find((item) => item.callID === "unapproved-link")).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(false)
      await socket.receive({
        ...denied,
        callID: "approved-link",
        allowedOrigins: ["https://example.test", "https://other.test"],
      })
      expect(socket.outgoing.find((item) => item.callID === "approved-link")).toMatchObject({
        type: "result",
        status: "completed",
      })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(true)
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

  test("animates the isolated agent cursor at the click point before CDP input", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "c".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-cursor" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-cursor")
      await socket.receive(action("cursor-click", shared.tabID, observation, { type: "click", ref: "b1" }))
      const world = harness.commands.findIndex((item) => item.method === "Page.createIsolatedWorld")
      const animation = harness.commands.findIndex(
        (item) => item.method === "Runtime.evaluate" && item.params.expression.includes('"cursor":{'),
      )
      const mouse = harness.commands.findIndex((item) => item.method === "Input.dispatchMouseEvent")
      expect(world).toBeGreaterThan(-1)
      expect(animation).toBeGreaterThan(world)
      expect(mouse).toBeGreaterThan(animation)
      expect(harness.commands.some((item) => item.method === "Runtime.enable")).toBe(true)
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Click"])
      expect(harness.commands[animation].params.contextId).toBe(1)
      expect(harness.commands[animation].params.expression).toContain('"x":5,"y":5')
      expect(harness.commands[mouse].params).toMatchObject({ type: "mousePressed", x: 5, y: 5 })
      expect(harness.cursorDOM.hosts()).toHaveLength(1)
      expect(harness.cursorDOM.moves.at(-1)).toBe("translate(5px,5px)")

      harness.commands.length = 0
      await socket.receive(action("cursor-type", shared.tabID, observation, { type: "type", ref: "b1", text: "hello" }))
      const typingAnimation = harness.commands.findIndex(
        (item) => item.method === "Runtime.evaluate" && item.params.expression.includes('"cursor":{'),
      )
      expect(typingAnimation).toBeGreaterThan(-1)
      expect(typingAnimation).toBeLessThan(harness.commands.findIndex((item) => item.method === "DOM.focus"))
      expect(typingAnimation).toBeLessThan(harness.commands.findIndex((item) => item.method === "Input.insertText"))
      expect(harness.commands[typingAnimation].params.expression).toContain('"x":5,"y":5')

      harness.commands.length = 0
      const movesBeforeScroll = harness.cursorDOM.moves.length
      await socket.receive(action("cursor-scroll", shared.tabID, observation, { type: "scroll", deltaY: 120 }))
      const scrollAnimation = harness.commands.findIndex(
        (item) => item.method === "Runtime.evaluate" && item.params.expression.includes('"cursor":{'),
      )
      const wheel = harness.commands.findIndex((item) => item.method === "Input.dispatchMouseEvent")
      expect(scrollAnimation).toBeGreaterThan(-1)
      expect(scrollAnimation).toBeLessThan(wheel)
      expect(harness.commands[scrollAnimation].params.expression).toContain('"x":50,"y":40')
      expect(harness.commands[wheel].params).toMatchObject({ type: "mouseWheel", x: 50, y: 40 })
      expect(harness.cursorDOM.hosts()).toHaveLength(1)
      expect(harness.cursorDOM.moves[movesBeforeScroll]).toBe("translate(5px,5px)")
      expect(harness.cursorDOM.moves.at(-1)).toBe("translate(50px,40px)")
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

  test("hidden-page cursor placement skips animation and still completes the action", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: false, url: "https://example.test/form", title: "Background" }]
    harness.cursorDOM.setVisibility("hidden")
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "g".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-hidden-cursor" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-hidden-cursor")
      await socket.receive(action("hidden-cursor-click", shared.tabID, observation, { type: "click", ref: "b1" }))
      expect(socket.outgoing.find((item) => item.callID === "hidden-cursor-click")).toMatchObject({ type: "result" })
      expect(harness.cursorDOM.frameRequests).toBe(0)
      expect(harness.cursorDOM.hosts()).toHaveLength(1)
      expect(harness.cursorDOM.moves.at(-1)).toBe("translate(5px,5px)")
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 1500)

  test("hidden tabs click and scroll with CDP input under focus emulation", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: false, url: "https://example.test/form", title: "Background" }]
    harness.cursorDOM.setVisibility("hidden")
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "k".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-hidden-input" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-hidden-input")
      await socket.receive(action("hidden-click", shared.tabID, observation, { type: "click", ref: "b1" }))
      const clickResult = socket.outgoing.find((item) => item.callID === "hidden-click")
      expect(clickResult).toMatchObject({ type: "result", status: "completed" })
      expect(clickResult).not.toHaveProperty("input")
      await socket.receive(action("hidden-scroll", shared.tabID, observation, { type: "scroll", deltaY: 120 }))
      const scrollResult = socket.outgoing.find((item) => item.callID === "hidden-scroll")
      expect(scrollResult).toMatchObject({ type: "result", status: "completed" })
      expect(scrollResult).not.toHaveProperty("input")
      expect(harness.commands.filter((item) => item.method === "Input.dispatchMouseEvent").map((item) => item.params.type))
        .toEqual(["mousePressed", "mouseReleased", "mouseWheel"])
      expect(harness.commands.some((item) => item.method === "Runtime.callFunctionOn")).toBe(false)
      expect(harness.commands.some((item) => item.method === "Runtime.evaluate" && item.params.expression.includes("scrollBy")))
        .toBe(false)
      expect(harness.commands[0]).toEqual({
        source: { tabId: 17 }, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true },
      })
      expect(harness.commands.filter((item) => item.method === "Emulation.setFocusEmulationEnabled")).toEqual([
        { source: { tabId: 17 }, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      ])
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 3000)

  test("failed focus emulation detaches a profile tab and fails the action closed", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: false, url: "https://example.test/form", title: "Background" }]
    harness.page.focusEmulationFails = true
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "l".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-focus-failure" })
      const observation = socket.outgoing.find((item) => item.callID === "observe-focus-failure")
      await socket.receive(action("focus-failure", shared.tabID, observation, { type: "click", ref: "b1" }))
      expect(socket.outgoing.find((item) => item.callID === "focus-failure")).toMatchObject({ type: "error", dispatched: false })
      expect(harness.detached).toContainEqual({ tabId: 17 })
      expect(harness.badges).not.toContainEqual({ tabId: 17, text: "ON" })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(false)
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 1500)

  test("an unanswered CDP input command fails as dispatched instead of hanging the action", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: false, url: "https://example.test/form", title: "Background" }]
    harness.page.inputHangs = true
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "m".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-hung-input" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-hung-input")
      await socket.receive(action("hung-scroll", shared.tabID, observation, { type: "scroll", deltaY: 40 }))
      expect(socket.outgoing.find((item) => item.callID === "hung-scroll")).toMatchObject({
        type: "error",
        dispatched: true,
      })
    } finally {
      harness.page.inputHangs = false
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 4000)

  test("cursor CDP hangs cannot hold up browser input", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    harness.page.cursorPlacementHangs = true
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "h".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-stuck-cursor" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-stuck-cursor")
      await socket.receive(action("stuck-cursor-click", shared.tabID, observation, { type: "click", ref: "b1" }))
      expect(socket.outgoing.find((item) => item.callID === "stuck-cursor-click")).toMatchObject({ type: "result" })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(true)
    } finally {
      harness.page.cursorPlacementHangs = false
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 1500)

  test("cursor placement failure does not block input and native detach sends no cleanup", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    harness.page.cursorPlacementFails = true
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "d".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-cursor-fail" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-cursor-fail")
      await socket.receive(action("cursor-click-fail", shared.tabID, observation, { type: "click", ref: "b1" }))
      expect(socket.outgoing.find((item) => item.callID === "cursor-click-fail")).toMatchObject({ type: "result" })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(true)
      harness.page.cursorPlacementFails = false
      harness.commands.length = 0
      await harness.debuggerDetach.emit({ tabId: 17 })
      expect(harness.commands.some((item) => item.method === "Runtime.evaluate")).toBe(false)
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

  test("a hung marker fails closed before input instead of controlling an unmarked tab", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    harness.page.cursorEvaluationHangs = true
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "y".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-hung-marker" })
      expect(socket.outgoing.find((item) => item.callID === "observe-hung-marker")).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(false)
    } finally {
      harness.page.cursorEvaluationHangs = false
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 4000)

  test("revokes an unknown script navigation during typing without sending its page metadata", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "f".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-typing" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-typing")
      harness.page.typeRedirect = "https://unknown.test/private"
      await socket.receive(
        action("type-redirect", shared.tabID, observation, { type: "type", ref: "b1", text: "hello" }),
      )
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: shared.tabID, reason: "navigated" })
      expect(socket.outgoing.find((message) => message.callID === "type-redirect")).toMatchObject({
        type: "error",
        dispatched: true,
      })
      expect(JSON.stringify(socket.outgoing)).not.toContain("unknown.test")
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

  test("blocks capture for password inputs in frames and shadow roots before screenshot dispatch", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]

    try {
      await popup(harness.runtimeMessages, {
        type: "pair",
        serverURL: "http://127.0.0.1:4096",
        secret: "c".repeat(32),
      })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
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
        expect(harness.commands.slice(commandStart).filter((item) => item.method !== "Runtime.evaluate")).toEqual([
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

describe("Chrome bridge cross-origin frames", () => {
  const childURL = "https://child.example.test/tempo"
  async function stopBridge() {
    if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
      await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  }
  async function connectWithChild() {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Shell" }]
    harness.page.child = { url: childURL }
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "o".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    const shared = socket.outgoing.find((message) => message.type === "shared")
    await socket.receive({ type: "observe", callID: "observe-attach", tabID: shared.tabID, generation: "bridge-1" })
    await harness.debuggerEvents.emit({ tabId: 17 }, "Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: { targetId: "child-target", type: "iframe", url: childURL },
      waitingForDebugger: false,
    })
    return { socket, shared }
  }
  async function observeFrames(socket, tabID, frameOrigins, callID) {
    await socket.receive({ type: "observe", callID, tabID, generation: "bridge-1", frameOrigins })
    return socket.outgoing.find((message) => message.callID === callID)
  }
  function frameAction(callID, tabID, observation, input) {
    return { ...action(callID, tabID, observation, input), frameOrigins: ["https://child.example.test"] }
  }

  test("merges a permitted child session tree and readable text into one observation", async () => {
    const { socket, shared } = await connectWithChild()
    try {
      expect(harness.commands.some((item) => item.method === "Target.setAutoAttach")).toBe(true)
      const observation = await observeFrames(socket, shared.tabID, ["https://child.example.test"], "observe-merged")
      expect(observation.type).toBe("observation")
      expect(observation.elements).toContainEqual(
        expect.objectContaining({ role: "button", name: "Child button", frame: childURL }),
      )
      expect(observation.elements).toContainEqual(
        expect.objectContaining({ role: "textbox", name: "Child input", frame: childURL }),
      )
      expect(observation.elements).toContainEqual(expect.objectContaining({ role: "textbox", name: "Name" }))
      expect(observation.texts).toContainEqual(expect.objectContaining({ role: "heading", name: "Shell heading" }))
      expect(observation.texts).toContainEqual(
        expect.objectContaining({ role: "StaticText", name: "Tempo rows", frame: childURL }),
      )
      expect(observation.frames).toContainEqual({ url: childURL, observed: true })
      expect(
        harness.commands.some(
          (item) => item.method === "Accessibility.getFullAXTree" && item.source.sessionId === "child-1",
        ),
      ).toBe(true)
    } finally {
      await stopBridge()
    }
  })

  test("excludes child content for an unpermitted frame origin but reports the frame", async () => {
    const { socket, shared } = await connectWithChild()
    try {
      const observation = await observeFrames(socket, shared.tabID, [], "observe-gated")
      expect(observation.type).toBe("observation")
      expect(observation.elements.some((element) => element.name === "Child button")).toBe(false)
      expect((observation.texts ?? []).some((text) => text.name === "Tempo rows")).toBe(false)
      expect(observation.frames).toContainEqual({ url: childURL, observed: false })
    } finally {
      await stopBridge()
    }
  })

  test("routes click and type to the child session with main-viewport mouse coordinates", async () => {
    const { socket, shared } = await connectWithChild()
    try {
      const observation = await observeFrames(socket, shared.tabID, ["https://child.example.test"], "observe-act")
      const button = observation.elements.find((element) => element.name === "Child button")
      const input = observation.elements.find((element) => element.name === "Child input")
      const start = harness.commands.length
      await socket.receive(frameAction("click-child", shared.tabID, observation, { type: "click", ref: button.ref }))
      expect(socket.outgoing.find((message) => message.callID === "click-child")).toMatchObject({
        type: "result",
        status: "completed",
      })
      const clicks = harness.commands.slice(start)
      expect(clicks).toContainEqual({
        source: { tabId: 17, sessionId: "child-1" },
        method: "DOM.describeNode",
        params: { backendNodeId: 201, depth: 0 },
      })
      expect(clicks.some((item) => item.method === "DOM.getFrameOwner" && item.source.sessionId === undefined)).toBe(true)
      expect(clicks).toContainEqual(
        expect.objectContaining({
          source: { tabId: 17 },
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ type: "mousePressed", x: 105, y: 55 }),
        }),
      )
      await socket.receive(
        frameAction("type-child", shared.tabID, observation, { type: "type", ref: input.ref, text: "2h" }),
      )
      expect(socket.outgoing.find((message) => message.callID === "type-child")).toMatchObject({
        type: "result",
        status: "completed",
      })
      expect(harness.commands).toContainEqual({
        source: { tabId: 17, sessionId: "child-1" },
        method: "DOM.focus",
        params: { backendNodeId: 202 },
      })
      expect(harness.commands).toContainEqual({
        source: { tabId: 17, sessionId: "child-1" },
        method: "Input.insertText",
        params: { text: "2h" },
      })
    } finally {
      await stopBridge()
    }
  })

  test("a subframe navigation invalidates only that frame's refs", async () => {
    const { socket, shared } = await connectWithChild()
    try {
      const observation = await observeFrames(socket, shared.tabID, ["https://child.example.test"], "observe-subnav")
      const button = observation.elements.find((element) => element.name === "Child button")
      const main = observation.elements.find((element) => element.name === "Name")
      await harness.debuggerEvents.emit({ tabId: 17, sessionId: "child-1" }, "Page.frameNavigated", {
        frame: { id: "child-frame", url: "https://child.example.test/other" },
      })
      await socket.receive(frameAction("click-stale-child", shared.tabID, observation, { type: "click", ref: button.ref }))
      expect(socket.outgoing.find((message) => message.callID === "click-stale-child")).toMatchObject({
        type: "error",
        dispatched: false,
      })
      await socket.receive(frameAction("click-main-still", shared.tabID, observation, { type: "click", ref: main.ref }))
      expect(socket.outgoing.find((message) => message.callID === "click-main-still")).toMatchObject({
        type: "result",
        status: "completed",
        documentGeneration: observation.documentGeneration,
      })
    } finally {
      await stopBridge()
    }
  })

  test("capture inspects the child session document instead of failing on its iframe", async () => {
    const { socket, shared } = await connectWithChild()
    try {
      const observation = await observeFrames(socket, shared.tabID, ["https://child.example.test"], "observe-capture-frame")
      harness.page.documentRoot = node("#document", { children: [node("IFRAME")] })
      harness.page.childDocumentRoot = node("#document", { children: [node("DIV")] })
      await socket.receive(frameAction("capture-oopif", shared.tabID, observation, { type: "capture" }))
      expect(socket.outgoing.find((message) => message.callID === "capture-oopif")).toMatchObject({
        type: "result",
        status: "completed",
        capture: { mediaType: "image/png" },
      })
      harness.page.childDocumentRoot = node("#document", { children: [password()] })
      await socket.receive(frameAction("capture-oopif-password", shared.tabID, observation, { type: "capture" }))
      expect(socket.outgoing.find((message) => message.callID === "capture-oopif-password")).toMatchObject({
        type: "error",
        dispatched: false,
        message: "Capture is disabled while password fields are present",
      })
    } finally {
      await stopBridge()
    }
  })

  test("dispatches history, reload, key, and wait actions and rejects unknown actions", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Shell" }]
    harness.page.historyEntries = [
      { id: 11, url: "https://example.test/one", title: "One" },
      { id: 12, url: "https://example.test/form", title: "Shell" },
    ]
    harness.page.historyIndex = 1
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "n".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", callID: "observe-actions", tabID: shared.tabID, generation: "bridge-1" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-actions")
      const run = async (callID, input) => {
        await socket.receive(action(callID, shared.tabID, observation, input))
        return socket.outgoing.find((message) => message.callID === callID)
      }
      expect(await run("act-back", { type: "back" })).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands).toContainEqual(
        expect.objectContaining({ method: "Page.navigateToHistoryEntry", params: { entryId: 11 } }),
      )
      harness.page.historyIndex = 0
      expect(await run("act-forward", { type: "forward" })).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands).toContainEqual(
        expect.objectContaining({ method: "Page.navigateToHistoryEntry", params: { entryId: 12 } }),
      )
      expect(await run("act-reload", { type: "reload" })).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands.some((item) => item.method === "Page.reload")).toBe(true)
      expect(await run("act-key", { type: "key", key: "Enter" })).toMatchObject({ type: "error", dispatched: false })
      expect(harness.commands.some((item) => item.method === "Input.dispatchKeyEvent")).toBe(false)
      expect(await run("act-key-shift", { type: "key", key: "Tab", modifiers: ["Shift"] })).toMatchObject({
        type: "result",
        status: "completed",
      })
      expect(harness.commands).toContainEqual(
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ type: "keyDown", key: "Tab", modifiers: 8 }),
        }),
      )
      expect(await run("act-wait-ref", { type: "wait", ref: "b1", timeoutMs: 1000 })).toMatchObject({
        type: "result",
        status: "completed",
      })
      expect(await run("act-wait-missing", { type: "wait", ref: "b99", timeoutMs: 250 })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(await run("act-unknown", { type: "drag", ref: "b1" })).toMatchObject({ type: "error", dispatched: false })
    } finally {
      await stopBridge()
    }
  })
})

describe("Chrome bridge form controls and waits", () => {
  const childURL = "https://child.example.test/tempo"
  const quad = [0, 0, 10, 0, 10, 10, 0, 10]
  const realNow = Date.now
  const checked = (value) => ({ name: "checked", value: { type: "tristate", value } })
  const selectedProperty = (value) => ({ name: "selected", value: { type: "booleanOrUndefined", value } })
  const expandedProperty = (value) => ({ name: "expanded", value: { type: "booleanOrUndefined", value } })
  const field = (element, name, extra = {}) => ({ role: "textbox", name, element, quad, ...extra })

  function useClock() {
    let offset = 0
    Date.now = () => realNow() + offset
    return {
      advance(ms) {
        offset += ms
      },
      restore() {
        Date.now = realNow
      },
    }
  }
  async function stopBridge() {
    if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
      await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  }
  async function connect(controls, { child = false } = {}) {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Form" }]
    harness.page.controls = controls
    if (child) harness.page.child = { url: childURL }
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "f".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    const shared = socket.outgoing.find((message) => message.type === "shared")
    await socket.receive({ type: "observe", callID: "forms-attach", tabID: shared.tabID, generation: "bridge-1" })
    if (child)
      await harness.debuggerEvents.emit({ tabId: 17 }, "Target.attachedToTarget", {
        sessionId: "child-1",
        targetInfo: { targetId: "child-target", type: "iframe", url: childURL },
        waitingForDebugger: false,
      })
    const reply = (callID) => socket.outgoing.find((message) => message.callID === callID)
    const observe = async (callID, frameOrigins) => {
      await socket.receive({ type: "observe", callID, tabID: shared.tabID, generation: "bridge-1", ...(frameOrigins ? { frameOrigins } : {}) })
      return reply(callID)
    }
    const run = async (callID, observation, input, frameOrigins) => {
      await socket.receive({ ...action(callID, shared.tabID, observation, input), ...(frameOrigins ? { frameOrigins } : {}) })
      return reply(callID)
    }
    return { socket, shared, observe, run, reply }
  }
  const refOf = (observation, name) => {
    const element = observation.elements.find((item) => item.name === name)
    if (!element) throw new Error(`No observed element named ${name}`)
    return element.ref
  }
  const calls = (start = 0) => harness.commands.slice(start).filter((item) => item.method === "Runtime.callFunctionOn")
  const mouse = (start, type) =>
    harness.commands.slice(start).filter((item) => item.method === "Input.dispatchMouseEvent" && item.params.type === type)
  const controlWorlds = (sessionId) =>
    harness.commands.filter(
      (item) =>
        item.method === "Page.createIsolatedWorld" && item.params.worldName === "ycoding-control" && item.source.sessionId === sessionId,
    )

  test("reports checked, pressed, expanded, selected, and value from the accessibility tree", async () => {
    const { observe } = await connect({
      11: { role: "checkbox", name: "Remember", nodeName: "INPUT", attributes: ["type", "checkbox"], properties: [checked("true")], quad },
      12: { role: "button", name: "Bold", nodeName: "BUTTON", properties: [{ name: "pressed", value: { type: "tristate", value: "mixed" } }], quad },
      13: { role: "combobox", name: "Country", nodeName: "INPUT", attributes: ["type", "text"], properties: [expandedProperty(true)], value: "Thailand", quad },
      14: { role: "option", name: "Bangkok", nodeName: "DIV", properties: [selectedProperty(true)], quad },
      15: { role: "textbox", name: "Notes", nodeName: "TEXTAREA", value: "synthetic note", quad },
      16: { role: "slider", name: "Volume", nodeName: "INPUT", attributes: ["type", "range"], value: 5, quad },
      17: { role: "checkbox", name: "Unset", nodeName: "INPUT", attributes: ["type", "checkbox"], properties: [checked("false")], quad },
    })
    try {
      const observation = await observe("state-observe")
      const named = (name) => observation.elements.find((item) => item.name === name)
      expect(named("Remember")).toMatchObject({ role: "checkbox", checked: true })
      expect(named("Remember").value).toBeUndefined()
      expect(named("Bold")).toMatchObject({ pressed: "mixed" })
      expect(named("Bold").expanded).toBeUndefined()
      expect(named("Country")).toMatchObject({ expanded: true, value: "Thailand" })
      expect(named("Bangkok")).toMatchObject({ selected: true })
      expect(named("Notes")).toMatchObject({ value: "synthetic note" })
      expect(named("Volume")).toMatchObject({ value: "5" })
      expect(named("Unset")).toMatchObject({ checked: false })
      expect(observation.elements.some((item) => item.sensitive)).toBe(false)
    } finally {
      await stopBridge()
    }
  })

  test("marks password, one-time-code, payment, and secret-named fields sensitive and never sends their values", async () => {
    const { observe } = await connect({
      21: { role: "textbox", name: "Account", nodeName: "INPUT", attributes: ["type", "password"], value: "synthetic-secret-1", quad },
      22: { role: "textbox", name: "Code", nodeName: "INPUT", attributes: ["type", "text", "autocomplete", "one-time-code"], value: "synthetic-secret-2", quad },
      23: { role: "textbox", name: "Card", nodeName: "INPUT", attributes: ["type", "text", "autocomplete", "cc-number"], value: "synthetic-secret-3", quad },
      24: { role: "textbox", name: "Field", nodeName: "INPUT", attributes: ["type", "text", "name", "user_pin"], value: "synthetic-secret-4", quad },
      25: { role: "textbox", name: "Email", nodeName: "INPUT", attributes: ["type", "email"], value: "person@example.test", quad },
    })
    try {
      const observation = await observe("sensitive-observe")
      for (const name of ["Account", "Code", "Card", "Field"]) {
        const element = observation.elements.find((item) => item.name === name)
        expect(element).toMatchObject({ sensitive: true })
        expect(element.value).toBeUndefined()
      }
      const email = observation.elements.find((item) => item.name === "Email")
      expect(email).toMatchObject({ value: "person@example.test" })
      expect(email.sensitive).toBeUndefined()
      expect(JSON.stringify(observation)).not.toContain("synthetic-secret")
    } finally {
      await stopBridge()
    }
  })

  test("marks label-named secret fields sensitive in observation and omits their value", async () => {
    const { observe } = await connect({
      26: { role: "textbox", name: "Password", nodeName: "INPUT", attributes: ["type", "text", "id", "f1"], value: "synthetic-secret-5", quad },
      27: { role: "textbox", name: "One-time code", nodeName: "INPUT", attributes: ["type", "text", "aria-labelledby", "otp"], value: "synthetic-secret-6", quad },
      28: { role: "textbox", name: "Verification   code", nodeName: "DIV", attributes: ["contenteditable", "true"], value: "synthetic-secret-7", quad },
    })
    try {
      const observation = await observe("label-sensitive-observe")
      for (const name of ["Password", "One-time code", "Verification   code"]) {
        const element = observation.elements.find((item) => item.name === name)
        expect(element).toMatchObject({ sensitive: true })
        expect(element.value).toBeUndefined()
      }
      expect(JSON.stringify(observation)).not.toContain("synthetic-secret")
    } finally {
      await stopBridge()
    }
  })

  test("fill selects existing contents in the control world and replaces them with inserted text; empty text sends Delete", async () => {
    const dom = createFakeControls()
    const input = dom.control({ tag: "input", attributes: { type: "text" }, value: "old text" })
    const area = dom.control({ tag: "textarea", value: "old area" })
    const editor = dom.control({ tag: "div", attributes: { contenteditable: "true" }, contentEditable: true, value: "old editor" })
    const date = dom.control({ tag: "input", attributes: { type: "date" } })
    const short = dom.control({ tag: "input", attributes: { type: "text" }, maxLength: 3 })
    const { observe, run } = await connect({
      31: field(input, "Title"),
      32: field(area, "Body"),
      33: field(editor, "Editor"),
      34: field(date, "Due"),
      35: field(short, "Initials"),
    })
    try {
      const observation = await observe("fill-observe")
      const start = harness.commands.length
      expect(await run("fill-input", observation, { type: "fill", ref: refOf(observation, "Title"), text: "new text" })).toMatchObject({
        type: "result",
        status: "completed",
        control: { value: "new text" },
      })
      expect(input.value).toBe("new text")
      const fills = calls(start)
      expect(fills.map((item) => item.params.arguments.map((argument) => argument.value))).toEqual([
        ["new text", false],
        ["new text", true],
        [],
      ])
      expect(fills.every((item) => !item.params.functionDeclaration.includes("new text"))).toBe(true)
      expect(fills.every((item) => item.params.returnByValue === true && item.params.objectId === "node-31")).toBe(true)
      expect(harness.commands.slice(start)).toContainEqual({ source: { tabId: 17 }, method: "Input.insertText", params: { text: "new text" } })
      expect(
        harness.commands.slice(start).findIndex((item) => item.method === "Input.insertText"),
      ).toBeGreaterThan(harness.commands.slice(start).findIndex((item) => item.method === "Runtime.callFunctionOn" && item.params.arguments[1]?.value === true))

      expect(await run("fill-editor", observation, { type: "fill", ref: refOf(observation, "Editor"), text: "fresh" })).toMatchObject({
        type: "result",
        control: { value: "fresh" },
      })
      expect(editor.value).toBe("fresh")

      const clearStart = harness.commands.length
      expect(await run("fill-clear", observation, { type: "fill", ref: refOf(observation, "Body"), text: "" })).toMatchObject({
        type: "result",
        control: { value: "" },
      })
      expect(area.value).toBe("")
      const cleared = harness.commands.slice(clearStart)
      expect(cleared.some((item) => item.method === "Input.insertText")).toBe(false)
      expect(cleared.filter((item) => item.method === "Input.dispatchKeyEvent").map((item) => [item.params.type, item.params.key])).toEqual([
        ["keyDown", "Delete"],
        ["keyUp", "Delete"],
      ])

      const dateStart = harness.commands.length
      expect(await run("fill-date", observation, { type: "fill", ref: refOf(observation, "Due"), text: "2026-11-07" })).toMatchObject({
        type: "result",
        control: { value: "2026-11-07" },
      })
      expect(harness.commands.slice(dateStart).some((item) => item.method === "Input.insertText")).toBe(false)
      expect(date.events.map((event) => event.type)).toEqual(["input", "change"])

      const differs = await run("fill-short", observation, { type: "fill", ref: refOf(observation, "Initials"), text: "abcdef" })
      expect(differs).toMatchObject({ type: "result", control: { value: "abc" }, message: "The field value differs from the requested text" })
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Type"])
    } finally {
      await stopBridge()
    }
  })

  test("fill and type refuse sensitive and file inputs before dispatch", async () => {
    const dom = createFakeControls()
    const { observe, run, socket } = await connect({
      41: field(dom.control({ tag: "input", attributes: { type: "password" }, value: "synthetic-stored-secret" }), "Account"),
      42: field(dom.control({ tag: "input", attributes: { type: "text", autocomplete: "cc-csc" } }), "Security"),
      43: { role: "button", name: "Upload", element: dom.control({ tag: "input", attributes: { type: "file" } }), quad },
    })
    try {
      const observation = await observe("refuse-observe")
      const start = harness.commands.length
      for (const name of ["Account", "Security", "Upload"])
        for (const type of ["fill", "type"]) {
          const outcome = await run(`refuse-${type}-${name}`, observation, { type, ref: refOf(observation, name), text: "synthetic-typed-secret" })
          expect(outcome).toMatchObject({ type: "error", dispatched: false })
        }
      const after = harness.commands.slice(start)
      for (const method of ["Input.insertText", "Input.dispatchKeyEvent", "Runtime.callFunctionOn", "DOM.focus"])
        expect(after.some((item) => item.method === method)).toBe(false)
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-typed-secret")
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-stored-secret")
    } finally {
      await stopBridge()
    }
  })

  test("refuses fill and type on a text field labelled Password by label for and never reads or sends its value", async () => {
    const dom = createFakeControls()
    const label = dom.label("pw-label", "  Password ")
    const labelled = dom.control({ tag: "input", attributes: { type: "text", id: "pw" }, labels: [label], value: "synthetic-label-secret" })
    const hidden = dom.control({ tag: "input", attributes: { type: "text", id: "pw2" }, labels: [label], value: "synthetic-label-secret" })
    const { observe, run, socket } = await connect({
      44: field(labelled, "Password", { value: "synthetic-label-secret" }),
      45: field(hidden, "Field"),
    })
    try {
      const observation = await observe("label-for-observe")
      const start = harness.commands.length
      for (const type of ["fill", "type"])
        expect(await run(`label-for-${type}`, observation, { type, ref: refOf(observation, "Password"), text: "synthetic-typed" })).toMatchObject({
          type: "error",
          dispatched: false,
        })
      expect(calls(start)).toEqual([])
      const pageStart = harness.commands.length
      expect(await run("label-for-page", observation, { type: "fill", ref: refOf(observation, "Field"), text: "synthetic-typed" })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(calls(pageStart).map((item) => item.params.arguments[1]?.value)).toEqual([false])
      const after = harness.commands.slice(start)
      expect(after.some((item) => item.method === "Input.insertText" || item.method === "Input.dispatchKeyEvent")).toBe(false)
      expect(labelled.value).toBe("synthetic-label-secret")
      expect(hidden.focused).toBe(false)
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-label-secret")
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-typed")
    } finally {
      await stopBridge()
    }
  })

  test("refuses fill and type on a field named One-time code by aria-labelledby and never reads or sends its value", async () => {
    const dom = createFakeControls()
    dom.label("otp", "One-time\n code")
    const named = dom.control({ tag: "input", attributes: { type: "text", "aria-labelledby": "missing otp" }, value: "synthetic-otp-secret" })
    const hidden = dom.control({ tag: "input", attributes: { type: "text", "aria-labelledby": "otp" }, value: "synthetic-otp-secret" })
    const { observe, run, socket } = await connect({
      46: field(named, "One-time code", { value: "synthetic-otp-secret" }),
      47: field(hidden, "Entry"),
    })
    try {
      const observation = await observe("labelledby-observe")
      const start = harness.commands.length
      for (const type of ["fill", "type"])
        expect(await run(`labelledby-${type}`, observation, { type, ref: refOf(observation, "One-time code"), text: "123456" })).toMatchObject({
          type: "error",
          dispatched: false,
        })
      expect(calls(start)).toEqual([])
      const pageStart = harness.commands.length
      expect(await run("labelledby-page", observation, { type: "fill", ref: refOf(observation, "Entry"), text: "123456" })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(calls(pageStart).map((item) => item.params.arguments[1]?.value)).toEqual([false])
      expect(harness.commands.slice(start).some((item) => item.method === "Input.insertText" || item.method === "Input.dispatchKeyEvent")).toBe(false)
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-otp-secret")
      expect(JSON.stringify(socket.outgoing)).not.toContain("123456")
    } finally {
      await stopBridge()
    }
  })

  test("select sets native options by value, label, and index with JSON arguments and never puts option text in the function source", async () => {
    const dom = createFakeControls()
    const countries = [{ value: "th", label: "Thailand" }, { value: "jp", label: "Japan" }, { value: "fr", label: "France" }]
    const single = dom.control({ tag: "select", options: countries })
    const multiple = dom.control({ tag: "select", options: countries, multiple: true })
    const { observe, run } = await connect({
      51: { role: "combobox", name: "Country", element: single, quad },
      52: { role: "listbox", name: "Visited", element: multiple, quad },
    })
    try {
      const observation = await observe("select-observe")
      const start = harness.commands.length
      expect(await run("select-value", observation, { type: "select", ref: refOf(observation, "Country"), values: ["jp"] })).toMatchObject({
        type: "result",
        control: { selected: [{ value: "jp", label: "Japan", index: 1 }] },
      })
      expect(single.events.map((event) => [event.type, event.bubbles])).toEqual([["input", true], ["change", true]])
      expect(await run("select-label", observation, { type: "select", ref: refOf(observation, "Country"), labels: ["France"] })).toMatchObject({
        control: { selected: [{ value: "fr", label: "France", index: 2 }] },
      })
      expect(await run("select-index", observation, { type: "select", ref: refOf(observation, "Country"), indexes: [0] })).toMatchObject({
        control: { selected: [{ value: "th", label: "Thailand", index: 0 }] },
      })
      expect(await run("select-many", observation, { type: "select", ref: refOf(observation, "Visited"), values: ["th", "fr"] })).toMatchObject({
        control: { selected: [{ value: "th" }, { value: "fr" }] },
      })
      const selects = calls(start)
      expect(selects.filter((item) => item.params.arguments.length === 2).map((item) => item.params.arguments[0].value)).toEqual([
        { values: ["jp"] },
        { values: ["jp"] },
        { labels: ["France"] },
        { labels: ["France"] },
        { indexes: [0] },
        { indexes: [0] },
        { values: ["th", "fr"] },
        { values: ["th", "fr"] },
      ])
      for (const text of ["Japan", "France", "Thailand", '"jp"', '"fr"'])
        expect(selects.some((item) => item.params.functionDeclaration.includes(text))).toBe(false)
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Select"])
    } finally {
      await stopBridge()
    }
  })

  test("select rejects a missing option, a disabled option, and two values on a single select before dispatch", async () => {
    const dom = createFakeControls()
    const single = dom.control({ tag: "select", options: [{ value: "a", label: "Alpha", selected: true }, { value: "b", label: "Beta", disabled: true }, { value: "c", label: "Gamma" }] })
    const { observe, run } = await connect({ 53: { role: "combobox", name: "Letter", element: single, quad } })
    try {
      const observation = await observe("select-reject-observe")
      const ref = refOf(observation, "Letter")
      const start = harness.commands.length
      for (const [callID, criteria, message] of [
        ["select-missing", { values: ["z"] }, "Option not found"],
        ["select-disabled", { labels: ["Beta"] }, "Option is disabled"],
        ["select-two", { values: ["a", "c"] }, "Select accepts one option"],
      ])
        expect(await run(callID, observation, { type: "select", ref, ...criteria })).toMatchObject({ type: "error", dispatched: false, message })
      expect(calls(start).every((item) => item.params.arguments[1]?.value === false)).toBe(true)
      expect(single.events).toEqual([])
      expect(single.selectedOptions.map((option) => option.value)).toEqual(["a"])
    } finally {
      await stopBridge()
    }
  })

  test("select clicks one rendered listbox option and refuses a collapsed combobox", async () => {
    const optionQuad = [20, 20, 30, 20, 30, 30, 20, 30]
    const controls = {
      61: { role: "listbox", name: "Fruits", nodeName: "UL", options: [62, 63], quad },
      62: { role: "option", name: "Apple", nodeName: "LI", properties: [selectedProperty(false)], quad: [0, 40, 10, 40, 10, 50, 0, 50] },
      63: { role: "option", name: " Banana \n", nodeName: "LI", properties: [selectedProperty(false)], quad: optionQuad },
      64: { role: "combobox", name: "Closed", nodeName: "INPUT", attributes: ["type", "text"], properties: [expandedProperty(false)], quad },
      65: {
        role: "combobox",
        name: "Open",
        nodeName: "INPUT",
        attributes: ["type", "text"],
        properties: [expandedProperty(true), { name: "controls", value: { type: "idrefList", relatedNodes: [{ backendDOMNodeId: 61 }] } }],
        quad,
      },
    }
    const { observe, run } = await connect(controls)
    try {
      const observation = await observe("aria-observe")
      harness.page.clickEffect = ({ x, y }) => {
        const option = x === 25 && y === 25 ? controls[63] : x === 5 && y === 45 ? controls[62] : undefined
        if (option) option.properties = [selectedProperty(true)]
      }
      const start = harness.commands.length
      expect(await run("aria-label", observation, { type: "select", ref: refOf(observation, "Fruits"), labels: ["Banana"] })).toMatchObject({
        type: "result",
        control: { selected: [{ label: "Banana", index: 1 }] },
      })
      expect(mouse(start, "mousePressed").map((item) => [item.params.x, item.params.y])).toEqual([[25, 25]])
      expect(harness.commands.slice(start)).toContainEqual(
        expect.objectContaining({ method: "Accessibility.queryAXTree", params: { backendNodeId: 61, role: "option" } }),
      )
      const comboStart = harness.commands.length
      expect(await run("aria-combo", observation, { type: "select", ref: refOf(observation, "Open"), indexes: [0] })).toMatchObject({
        type: "result",
        control: { selected: [{ label: "Apple", index: 0 }] },
      })
      expect(mouse(comboStart, "mousePressed")).toHaveLength(1)
      const already = harness.commands.length
      expect(await run("aria-already", observation, { type: "select", ref: refOf(observation, "Fruits"), indexes: [1] })).toMatchObject({
        type: "result",
        control: { selected: [{ label: "Banana", index: 1 }] },
      })
      expect(mouse(already, "mousePressed")).toEqual([])
      const rejected = harness.commands.length
      expect(await run("aria-closed", observation, { type: "select", ref: refOf(observation, "Closed"), labels: ["Apple"] })).toMatchObject({
        type: "error",
        dispatched: false,
        message: expect.stringContaining("Open the list first"),
      })
      expect(await run("aria-values", observation, { type: "select", ref: refOf(observation, "Fruits"), values: ["Apple"] })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(await run("aria-two", observation, { type: "select", ref: refOf(observation, "Fruits"), labels: ["Apple", "Banana"] })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(mouse(rejected, "mousePressed")).toEqual([])
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Select"])
    } finally {
      await stopBridge()
    }
  })

  test("check does nothing when the state matches, clicks once otherwise, and reports a state that did not change", async () => {
    const controls = {
      71: { role: "checkbox", name: "Done", nodeName: "INPUT", attributes: ["type", "checkbox"], properties: [checked("true")], quad },
      72: { role: "switch", name: "Alerts", nodeName: "BUTTON", properties: [checked("false")], quad: [20, 0, 30, 0, 30, 10, 20, 10] },
      73: { role: "checkbox", name: "Stuck", nodeName: "INPUT", attributes: ["type", "checkbox"], properties: [checked("false")], quad: [40, 0, 50, 0, 50, 10, 40, 10] },
    }
    const { observe, run } = await connect(controls)
    try {
      const observation = await observe("check-observe")
      harness.page.clickEffect = ({ x }) => {
        if (x === 25) controls[72].properties = [checked("true")]
      }
      const start = harness.commands.length
      expect(await run("check-same", observation, { type: "check", ref: refOf(observation, "Done"), checked: true })).toMatchObject({
        type: "result",
        status: "completed",
        control: { checked: true },
      })
      expect(harness.commands.slice(start).some((item) => item.method === "Input.dispatchMouseEvent")).toBe(false)
      const toggled = await run("check-toggle", observation, { type: "check", ref: refOf(observation, "Alerts"), checked: true })
      expect(toggled).toMatchObject({ type: "result", control: { checked: true } })
      expect(toggled.message).toBeUndefined()
      expect(mouse(start, "mousePressed")).toHaveLength(1)
      const stuckStart = harness.commands.length
      expect(await run("check-stuck", observation, { type: "check", ref: refOf(observation, "Stuck"), checked: true })).toMatchObject({
        type: "result",
        status: "completed",
        control: { checked: false },
        message: "The control did not change state",
      })
      expect(mouse(stuckStart, "mousePressed")).toHaveLength(1)
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Click"])
    } finally {
      await stopBridge()
    }
  })

  test("check refuses to uncheck a radio and to check an element without checked state before dispatch", async () => {
    const { observe, run } = await connect({
      74: { role: "radio", name: "Express", nodeName: "INPUT", attributes: ["type", "radio"], properties: [checked("true")], quad },
      75: { role: "button", name: "Plain", nodeName: "BUTTON", quad },
    })
    try {
      const observation = await observe("check-refuse-observe")
      const start = harness.commands.length
      expect(await run("check-radio", observation, { type: "check", ref: refOf(observation, "Express"), checked: false })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(await run("check-plain", observation, { type: "check", ref: refOf(observation, "Plain"), checked: true })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(harness.commands.slice(start).some((item) => item.method === "Input.dispatchMouseEvent")).toBe(false)
    } finally {
      await stopBridge()
    }
  })

  test("hover dispatches one mouseMoved at the element point with the Hover label and no press", async () => {
    const { observe, run } = await connect({ 76: { role: "button", name: "Menu", nodeName: "BUTTON", quad: [20, 20, 40, 20, 40, 40, 20, 40] } })
    try {
      const observation = await observe("hover-observe")
      const start = harness.commands.length
      expect(await run("hover-menu", observation, { type: "hover", ref: refOf(observation, "Menu") })).toMatchObject({
        type: "result",
        status: "completed",
      })
      const moves = harness.commands.slice(start).filter((item) => item.method === "Input.dispatchMouseEvent")
      expect(moves).toEqual([{ source: { tabId: 17 }, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 30, y: 30 } }])
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Hover"])
    } finally {
      await stopBridge()
    }
  })

  test("waits for a locator to become visible, hidden, and detached and ignores matches in unapproved frames", async () => {
    const controls = {
      81: { role: "button", name: "Save", nodeName: "BUTTON", quad: undefined },
      82: { role: "heading", name: "Child total", nodeName: "H2", quad, session: "child-1" },
    }
    const { observe, run } = await connect(controls, { child: true })
    try {
      const observation = await observe("locator-observe", [])
      const locator = 'role=button[name="Save"]'
      expect(await run("locator-attached", observation, { type: "wait", locator, state: "attached", timeoutMs: 0 })).toMatchObject({
        type: "result",
        status: "completed",
      })
      setTimeout(() => (controls[81].quad = quad), 50)
      expect(await run("locator-visible", observation, { type: "wait", locator, timeoutMs: 2000 })).toMatchObject({ type: "result" })
      setTimeout(() => (controls[81].quad = undefined), 50)
      expect(await run("locator-hidden", observation, { type: "wait", locator, state: "hidden", timeoutMs: 2000 })).toMatchObject({ type: "result" })
      controls[81].detached = true
      expect(await run("locator-detached", observation, { type: "wait", locator, state: "detached", timeoutMs: 0 })).toMatchObject({ type: "result" })
      expect(await run("locator-gone", observation, { type: "wait", locator, timeoutMs: 0 })).toMatchObject({ type: "error", dispatched: false })
      const child = 'role=heading[name="Child total"]'
      const unapproved = await run("locator-unapproved", observation, { type: "wait", locator: child, timeoutMs: 0 }, [])
      expect(unapproved).toMatchObject({ type: "error", dispatched: false })
      expect(JSON.stringify(unapproved)).not.toContain("child.example.test")
      expect(await run("locator-approved", observation, { type: "wait", locator: child, timeoutMs: 0 }, ["https://child.example.test"])).toMatchObject({
        type: "result",
        frame: childURL,
      })
      expect(await run("locator-malformed", observation, { type: "wait", locator: "button Save", timeoutMs: 0 })).toMatchObject({
        type: "error",
        dispatched: false,
      })
    } finally {
      await stopBridge()
    }
  })

  test("key refuses printable text after Tab moves focus into a password field and sends no key event", async () => {
    const dom = createFakeControls()
    const secret = dom.control({ tag: "input", attributes: { type: "password" }, value: "synthetic-key-secret" })
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run, socket } = await connect({ 101: field(plain, "Name"), 102: field(secret, "Account") })
    try {
      const document = harness.page.documents.main
      document.activeElement = plain
      harness.page.keyEffect = (params) => {
        if (params.type === "keyDown" && params.key === "Tab") document.activeElement = secret
      }
      const observation = await observe("key-observe")
      const textKeys = (start) =>
        harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent" && item.params.text !== undefined)
      const start = harness.commands.length
      expect(await run("key-tab", observation, { type: "key", key: "Tab" })).toMatchObject({ type: "result", status: "completed" })
      expect(document.activeElement).toBe(secret)
      expect(await run("key-secret", observation, { type: "key", key: "a" })).toMatchObject({ type: "error", dispatched: false })
      expect(textKeys(start)).toEqual([])
      expect(secret.value).toBe("synthetic-key-secret")
      expect(await run("key-enter", observation, { type: "key", key: "Enter" })).toMatchObject({ type: "error", dispatched: false })
      expect(await run("key-chord", observation, { type: "key", key: "a", modifiers: ["Control"] })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(textKeys(start)).toEqual([])
      expect(secret.value).toBe("synthetic-key-secret")
      document.activeElement = plain
      expect(await run("key-plain", observation, { type: "key", key: "b" })).toMatchObject({ type: "result", status: "completed" })
      expect(textKeys(start).map((item) => item.params.text)).toEqual(["b"])
      expect(plain.value).toBe("b")
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-key-secret")
    } finally {
      await stopBridge()
    }
  })

  test("key refuses text into secret fields reached through shadow roots, frames, labels, accessible names, and file inputs", async () => {
    const dom = createFakeControls()
    const otp = dom.control({ tag: "input", attributes: { type: "text", autocomplete: "one-time-code" } })
    const shadowHost = dom.control({ tag: "div" })
    shadowHost.shadowRoot = { activeElement: otp }
    const cardLabel = dom.label("card-label", "Card number")
    const labelled = dom.control({ tag: "input", attributes: { type: "text" }, labels: [cardLabel] })
    const sameOrigin = dom.control({ tag: "iframe" })
    sameOrigin.contentDocument = { activeElement: labelled }
    const pin = dom.control({ tag: "input", attributes: { type: "text" } })
    const upload = dom.control({ tag: "input", attributes: { type: "file" } })
    const crossOrigin = dom.control({ tag: "iframe" })
    crossOrigin.contentDocument = null
    const unknownFrame = dom.control({ tag: "iframe" })
    unknownFrame.contentDocument = null
    const childSecret = dom.control({ tag: "input", attributes: { type: "password" } })
    const childPlain = dom.control({ tag: "input", attributes: { type: "text" } })
    const plainHost = dom.control({ tag: "div" })
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    plainHost.shadowRoot = { activeElement: plain }
    const { observe, run } = await connect(
      {
        103: { role: "generic", name: "", element: shadowHost },
        104: field(otp, "Code entry"),
        105: { role: "generic", name: "", element: sameOrigin },
        106: field(labelled, "Entry"),
        107: field(pin, "PIN code"),
        108: { role: "button", name: "Upload", element: upload, quad },
        109: { role: "generic", name: "", element: crossOrigin, frameId: "child-target" },
        110: { role: "generic", name: "", element: unknownFrame, frameId: "unknown-target" },
        111: field(childSecret, "Child account", { session: "child-1" }),
        112: field(childPlain, "Child notes", { session: "child-1" }),
        113: { role: "generic", name: "", element: plainHost },
        114: field(plain, "Plain"),
      },
      { child: true },
    )
    try {
      const document = harness.page.documents.main
      const observation = await observe("focus-observe", ["https://child.example.test"])
      const start = harness.commands.length
      for (const [callID, focused, child] of [
        ["focus-shadow", shadowHost],
        ["focus-frame-label", sameOrigin],
        ["focus-name", pin],
        ["focus-file", upload],
        ["focus-cross-origin", crossOrigin, childSecret],
        ["focus-unknown-frame", unknownFrame],
      ]) {
        document.activeElement = focused
        harness.page.documents["child-1"].activeElement = child
        expect(await run(callID, observation, { type: "key", key: "z" })).toMatchObject({ type: "error", dispatched: false })
      }
      expect(harness.commands.slice(start).some((item) => item.method === "Input.dispatchKeyEvent")).toBe(false)
      for (const element of [otp, labelled, pin, childSecret]) expect(element.value).toBe("")
      document.activeElement = plainHost
      expect(await run("focus-plain-shadow", observation, { type: "key", key: "y" })).toMatchObject({ type: "result" })
      expect(plain.value).toBe("y")
      document.activeElement = crossOrigin
      harness.page.documents["child-1"].activeElement = childPlain
      expect(await run("focus-plain-child", observation, { type: "key", key: "x" })).toMatchObject({ type: "result" })
    } finally {
      await stopBridge()
    }
  })

  test("key refuses printable text into a password field inside a focused cross-origin iframe while Tab passes", async () => {
    const dom = createFakeControls()
    const frame = dom.control({ tag: "iframe" })
    frame.contentDocument = null
    const secret = dom.control({ tag: "input", attributes: { type: "password" }, value: "synthetic-frame-secret" })
    const { observe, run, socket } = await connect(
      {
        141: { role: "generic", name: "", element: frame, frameId: "child-target" },
        142: field(secret, "Child login", { session: "child-1" }),
      },
      { child: true },
    )
    try {
      const frameOrigins = ["https://child.example.test"]
      const observation = await observe("frame-key-observe", frameOrigins)
      harness.page.documents.main.activeElement = frame
      harness.page.documents["child-1"].activeElement = secret
      const start = harness.commands.length
      expect(await run("frame-key-text", observation, { type: "key", key: "a" }, frameOrigins)).toMatchObject({ type: "error", dispatched: false })
      expect(harness.commands.slice(start).some((item) => item.method === "Input.dispatchKeyEvent")).toBe(false)
      expect(await run("frame-key-tab", observation, { type: "key", key: "Tab" }, frameOrigins)).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent").map((item) => item.params.key)).toEqual([
        "Tab",
        "Tab",
      ])
      expect(secret.value).toBe("synthetic-frame-secret")
      expect(JSON.stringify(socket.outgoing)).not.toContain("synthetic-frame-secret")
    } finally {
      await stopBridge()
    }
  })

  test("key refuses printable text when the focused cross-origin frame is unapproved, has no child session, or has no provable focus", async () => {
    const dom = createFakeControls()
    const frame = dom.control({ tag: "iframe" })
    frame.contentDocument = null
    const orphan = dom.control({ tag: "iframe" })
    orphan.contentDocument = null
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run } = await connect(
      {
        143: { role: "generic", name: "", element: frame, frameId: "child-target" },
        144: { role: "generic", name: "", element: orphan, frameId: "missing-target" },
        145: field(plain, "Child notes", { session: "child-1" }),
      },
      { child: true },
    )
    try {
      const approved = ["https://child.example.test"]
      const observation = await observe("unproven-observe", approved)
      const document = harness.page.documents.main
      const child = harness.page.documents["child-1"]
      const textKeys = (start) =>
        harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent" && item.params.text !== undefined)
      const start = harness.commands.length
      for (const [callID, tabCallID, focused, childFocus, frameOrigins] of [
        ["unproven-unapproved", "unproven-unapproved-tab", frame, plain, []],
        ["unproven-no-session", "unproven-no-session-tab", orphan, plain, approved],
        ["unproven-no-focus", "unproven-no-focus-tab", frame, null, approved],
      ]) {
        document.activeElement = focused
        child.activeElement = childFocus
        expect(await run(callID, observation, { type: "key", key: "a" }, frameOrigins)).toMatchObject({ type: "error", dispatched: false })
        expect(await run(tabCallID, observation, { type: "key", key: "Tab" }, frameOrigins)).toMatchObject({ type: "result" })
      }
      expect(textKeys(start)).toEqual([])
      expect(plain.value).toBe("")
      document.activeElement = frame
      child.activeElement = plain
      expect(await run("unproven-approved-plain", observation, { type: "key", key: "a" }, approved)).toMatchObject({ type: "result" })
      expect(textKeys(start).map((item) => item.params.text)).toEqual(["a"])
    } finally {
      await stopBridge()
    }
  })

  test("key refuses printable text when focus is on a host with a closed shadow root", async () => {
    const dom = createFakeControls()
    const host = dom.control({ tag: "x-field" })
    host.shadowRoot = null
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run } = await connect({
      146: { role: "generic", name: "", element: host, shadowRoots: [{ nodeName: "#document-fragment", shadowRootType: "closed" }] },
      147: field(plain, "Plain", { shadowRoots: [{ nodeName: "#document-fragment", shadowRootType: "user-agent" }] }),
    })
    try {
      const observation = await observe("closed-shadow-observe")
      const document = harness.page.documents.main
      document.activeElement = host
      const start = harness.commands.length
      expect(await run("closed-shadow-text", observation, { type: "key", key: "a" })).toMatchObject({ type: "error", dispatched: false })
      expect(harness.commands.slice(start).some((item) => item.method === "Input.dispatchKeyEvent")).toBe(false)
      expect(await run("closed-shadow-escape", observation, { type: "key", key: "Escape" })).toMatchObject({ type: "result" })
      document.activeElement = plain
      expect(await run("user-agent-shadow-text", observation, { type: "key", key: "a" })).toMatchObject({ type: "result" })
      expect(plain.value).toBe("a")
    } finally {
      await stopBridge()
    }
  })

  const navigationKeys = ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]
    .map((key) => ({ type: "key", key }))
    .concat([{ type: "key", key: "Tab", modifiers: ["Shift"] }])
  const editingKeys = ["a", " ", "Space", "Enter", "Backspace", "Delete", "Insert"]
    .map((key) => ({ type: "key", key }))
    .concat(
      ["Shift", "Alt", "Control", "Meta"].flatMap((modifier) =>
        ["a", " ", "Space", "Enter", "Backspace", "Delete", "Insert", ...navigationKeys.slice(0, 10).map((item) => item.key)]
          .filter((key) => modifier !== "Shift" || key !== "Tab")
          .map((key) => ({ type: "key", key, modifiers: [modifier] })),
      ),
      ["Control", "Meta"].flatMap((modifier) =>
        ["v", "x", "y", "z", "c"].map((key) => ({ type: "key", key, modifiers: [modifier] })),
      ),
      [{ type: "key", key: "Tab", modifiers: ["Control", "Shift"] }, { type: "key", key: "v", modifiers: ["Meta", "Shift"] }],
    )

  test.each([
    "password", "autocomplete", "name", "label", "aria-labelledby", "AX name", "file", "closed root",
    "unapproved frame", "sessionless frame", "unknown frame", "missing child focus", "missing main focus", "failed child session",
    "child password", "child file", "child closed root",
  ])("key safety table refuses editing and preserves navigation for %s", async (kind) => {
    const dom = createFakeControls()
    const sensitive = dom.control({
      tag: "input",
      attributes: {
        type: kind === "password" ? "password" : kind === "file" ? "file" : "text",
        ...(kind === "autocomplete" ? { autocomplete: "one-time-code" } : {}),
        ...(kind === "name" ? { name: "account_password" } : {}),
        ...(kind === "aria-labelledby" ? { "aria-labelledby": "secret-label" } : {}),
      },
      labels: kind === "label" ? [dom.label("card-label", "Card number")] : [],
    })
    dom.label("secret-label", "PIN code")
    const host = dom.control({ tag: "x-field" })
    const frame = dom.control({ tag: "iframe" })
    frame.contentDocument = null
    const child = dom.control({ tag: "input", attributes: { type: kind === "child password" ? "password" : kind === "child file" ? "file" : "text" } })
    const { observe, run } = await connect({
      151: field(sensitive, kind === "AX name" ? "Password" : "Entry"),
      152: { role: "generic", name: "", element: host, shadowRoots: [{ shadowRootType: "closed" }] },
      153: { role: "generic", name: "", element: frame, ...(kind !== "unknown frame" ? { frameId: kind === "sessionless frame" ? "missing-target" : "child-target" } : {}) },
      154: field(child, "Child notes", { session: "child-1", ...(kind === "child closed root" ? { shadowRoots: [{ shadowRootType: "closed" }] } : {}) }),
    }, { child: kind !== "sessionless frame" })
    try {
      const origins = kind === "unapproved frame" ? [] : ["https://child.example.test"]
      const observation = await observe(`key-safety-${kind}`, origins)
      harness.page.documents.main.activeElement = kind === "missing main focus" ? null
        : kind === "closed root" ? host : kind.includes("frame") || kind.includes("child") ? frame : sensitive
      harness.page.documents["child-1"].activeElement = kind === "missing child focus" ? null : child
      if (kind === "failed child session") {
        await harness.debuggerEvents.emit({ tabId: 17 }, "Target.detachedFromTarget", { sessionId: "child-1" })
        harness.page.focusEmulationFails = true
        await harness.debuggerEvents.emit({ tabId: 17 }, "Target.attachedToTarget", {
          sessionId: "child-1",
          targetInfo: { targetId: "child-target", type: "iframe", url: childURL },
          waitingForDebugger: false,
        })
        harness.page.focusEmulationFails = false
      }
      for (const [index, input] of editingKeys.entries()) {
        const start = harness.commands.length
        expect(await run(`key-safety-edit-${index}`, observation, input, origins), JSON.stringify(input)).toMatchObject({ type: "error", dispatched: false })
        expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent")).toEqual([])
      }
      for (const [index, input] of navigationKeys.entries()) {
        const start = harness.commands.length
        expect(await run(`key-safety-nav-${index}`, observation, input, origins), JSON.stringify(input)).toMatchObject({ type: "result", status: "completed" })
        expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent")).toHaveLength(2)
        expect(harness.commands.slice(start).some((item) => item.method === "Accessibility.getPartialAXTree" || item.method === "DOM.describeNode" || (item.method === "Runtime.callFunctionOn" && item.params.returnByValue === false))).toBe(false)
      }
    } finally {
      await stopBridge()
    }
  })

  test.each(["main", "open shadow", "same-origin frame", "approved child"])("key safety table allows ordinary-input editing in %s", async (kind) => {
    const dom = createFakeControls()
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    const host = dom.control({ tag: kind.includes("frame") || kind === "approved child" ? "iframe" : "div" })
    if (kind === "open shadow") host.shadowRoot = { activeElement: plain }
    if (kind === "same-origin frame") host.contentDocument = { activeElement: plain }
    if (kind === "approved child") host.contentDocument = null
    const { observe, run } = await connect({
      155: field(plain, "Notes", kind === "approved child" ? { session: "child-1" } : {}),
      156: { role: "generic", name: "", element: host, frameId: "child-target" },
    }, { child: kind === "approved child" })
    try {
      const origins = ["https://child.example.test"]
      const observation = await observe(`key-safety-plain-${kind}`, origins)
      harness.page.documents.main.activeElement = kind === "main" ? plain : host
      harness.page.documents["child-1"].activeElement = plain
      for (const [index, input] of editingKeys.entries()) {
        const start = harness.commands.length
        expect(await run(`key-safety-plain-${index}`, observation, input, origins), JSON.stringify(input)).toMatchObject({ type: "result", status: "completed" })
        const commands = harness.commands.slice(start)
        expect(commands.filter((item) => item.method === "Input.dispatchKeyEvent")).toHaveLength(2)
        expect(commands.findIndex((item) => item.method === "Accessibility.getPartialAXTree")).toBeLessThan(commands.findIndex((item) => item.method === "Input.dispatchKeyEvent"))
        expect(commands.some((item) => item.method === "Accessibility.getPartialAXTree" && item.source.sessionId === (kind === "approved child" ? "child-1" : undefined))).toBe(true)
        if (kind === "approved child") {
          expect(commands.find((item) => item.method === "Runtime.releaseObject" && item.params.objectId === "node-156")?.source.sessionId).toBeUndefined()
          expect(commands.find((item) => item.method === "Runtime.releaseObject" && item.params.objectId === "node-155")?.source.sessionId).toBe("child-1")
        }
      }
    } finally {
      await stopBridge()
    }
  })

  test.each(["focus exception", "DOM failure", "AX failure", "empty AX", "unmatched AX", "sensitivity exception", "missing sensitivity"])("key safety table refuses editing on %s", async (failure) => {
    const dom = createFakeControls()
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run } = await connect({ 157: field(plain, "Notes") })
    const send = harness.chrome.debugger.sendCommand
    try {
      const observation = await observe(`key-safety-inspection-${failure}`)
      harness.page.documents.main.activeElement = plain
      harness.chrome.debugger.sendCommand = async (source, method, params) => {
        if (method === "DOM.describeNode" && params.objectId && failure === "DOM failure") throw new Error("DOM unavailable")
        if (method === "Accessibility.getPartialAXTree" && params.objectId) {
          if (failure === "AX failure") throw new Error("AX unavailable")
          if (failure === "empty AX") return { nodes: [] }
          if (failure === "unmatched AX") return { nodes: [{ backendDOMNodeId: 999, name: { value: "Notes" } }] }
        }
        if (method === "Runtime.callFunctionOn") {
          if (failure === "focus exception" && params.returnByValue === false) return { exceptionDetails: { text: "focus unavailable" } }
          if (params.functionDeclaration.includes("return isSensitive(this)")) {
            if (failure === "sensitivity exception") return { exceptionDetails: { text: "inspection unavailable" } }
            if (failure === "missing sensitivity") return { result: { type: "undefined" } }
          }
        }
        return send(source, method, params)
      }
      for (const [index, input] of [{ type: "key", key: "a" }, { type: "key", key: "Enter" }, { type: "key", key: "v", modifiers: ["Control"] }].entries()) {
        const start = harness.commands.length
        expect(await run(`key-safety-inspection-${index}`, observation, input)).toMatchObject({ type: "error", dispatched: false })
        expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent")).toEqual([])
      }
    } finally {
      harness.chrome.debugger.sendCommand = send
      await stopBridge()
    }
  })

  test.each([
    "missing AX name", "non-string AX name", "missing DOM", "missing nodeType", "non-element nodeType",
    "missing nodeName", "empty nodeName", "non-string nodeName", "missing backend id", "zero backend id", "non-string backend id",
    "missing attributes", "non-array attributes", "odd attributes", "non-string attributes",
    "null shadowRoots", "non-array shadowRoots", "null shadow entry", "missing shadow type", "unknown shadow type",
    "disconnected leaf", "connection exception", "missing connection proof", "retained object", "retained embed", "retained iframe",
  ])("key focus proof refuses %s before editing but preserves plain navigation", async (failure) => {
    const dom = createFakeControls()
    const tag = failure === "retained object" ? "object" : failure === "retained embed" ? "embed" : failure === "retained iframe" ? "iframe" : "input"
    const plain = dom.control({ tag, attributes: tag === "input" ? { type: "text" } : {} })
    if (tag === "iframe") plain.contentDocument = { activeElement: null }
    const { observe, run } = await connect({ 158: field(plain, "Notes") })
    const send = harness.chrome.debugger.sendCommand
    try {
      const observation = await observe(`focus-proof-${failure}`)
      harness.page.documents.main.activeElement = plain
      if (failure === "disconnected leaf") plain.isConnected = false
      harness.chrome.debugger.sendCommand = async (source, method, params) => {
        if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function () { return this.isConnected }") {
          if (failure === "connection exception") return { exceptionDetails: { text: "connection unavailable" } }
          if (failure === "missing connection proof") return { result: { type: "undefined" } }
        }
        const result = await send(source, method, params)
        if (method === "Accessibility.getPartialAXTree" && params.objectId) {
          if (failure === "missing AX name") delete result.nodes[0].name
          if (failure === "non-string AX name") result.nodes[0].name = { value: 12 }
        }
        if (method === "DOM.describeNode" && params.objectId) {
          if (failure === "missing DOM") return {}
          const node = result.node
          if (failure === "missing nodeType") delete node.nodeType
          if (failure === "non-element nodeType") node.nodeType = 3
          if (failure === "missing nodeName") delete node.nodeName
          if (failure === "empty nodeName") node.nodeName = ""
          if (failure === "non-string nodeName") node.nodeName = 12
          if (failure === "missing backend id") delete node.backendNodeId
          if (failure === "zero backend id") node.backendNodeId = 0
          if (failure === "non-string backend id") node.backendNodeId = "158"
          if (failure === "missing attributes") delete node.attributes
          if (failure === "non-array attributes") node.attributes = {}
          if (failure === "odd attributes") node.attributes = ["type"]
          if (failure === "non-string attributes") node.attributes = ["type", 12]
          if (failure === "null shadowRoots") node.shadowRoots = null
          if (failure === "non-array shadowRoots") node.shadowRoots = {}
          if (failure === "null shadow entry") node.shadowRoots = [null]
          if (failure === "missing shadow type") node.shadowRoots = [{}]
          if (failure === "unknown shadow type") node.shadowRoots = [{ shadowRootType: "unknown" }]
        }
        return result
      }
      for (const [index, input] of editingKeys.entries()) {
        const start = harness.commands.length
        expect(await run(`focus-proof-edit-${index}`, observation, input), JSON.stringify(input)).toMatchObject({ type: "error", dispatched: false })
        expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent")).toEqual([])
      }
      for (const [index, input] of navigationKeys.entries()) {
        const start = harness.commands.length
        expect(await run(`focus-proof-navigation-${index}`, observation, input)).toMatchObject({ type: "result", status: "completed" })
        expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent")).toHaveLength(2)
        expect(harness.commands.slice(start).some((item) => item.method === "DOM.describeNode" || item.method === "Accessibility.getPartialAXTree")).toBe(false)
      }
    } finally {
      harness.chrome.debugger.sendCommand = send
      await stopBridge()
    }
  })

  test("key focus proof permits an attached ordinary input with an actual empty AX name", async () => {
    const dom = createFakeControls()
    const plain = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run } = await connect({ 159: field(plain, "") })
    try {
      const observation = await observe("focus-proof-empty-name")
      harness.page.documents.main.activeElement = plain
      for (const [index, input] of editingKeys.entries()) {
        const start = harness.commands.length
        expect(await run(`focus-proof-empty-name-${index}`, observation, input)).toMatchObject({ type: "result", status: "completed" })
        expect(harness.commands.slice(start).filter((item) => item.method === "Input.dispatchKeyEvent")).toHaveLength(2)
      }
    } finally {
      await stopBridge()
    }
  })

  test("observes date, time, and color inputs by their input type, fills a date with its ISO value, and ignores other roles", async () => {
    const dom = createFakeControls()
    const date = dom.control({ tag: "input", attributes: { type: "date" } })
    const time = dom.control({ tag: "input", attributes: { type: "time" } })
    const color = dom.control({ tag: "input", attributes: { type: "color" } })
    const { observe, run } = await connect({
      121: { role: "date", name: "Due", element: date, quad },
      122: { role: "inputTime", name: "Start", element: time, quad },
      123: { role: "colorWell", name: "Tint", element: color, quad },
      124: { role: "time", name: "Clock", nodeName: "TIME", quad },
      125: { role: "dateTime", name: "Deadline label", nodeName: "SPAN", quad },
    })
    try {
      const observation = await observe("date-observe")
      expect(observation.elements.map((item) => [item.role, item.name])).toEqual([
        ["date", "Due"],
        ["inputTime", "Start"],
        ["colorWell", "Tint"],
      ])
      const filled = await run("date-fill", observation, { type: "fill", ref: refOf(observation, "Due"), text: "2026-11-07" })
      expect(filled).toMatchObject({ type: "result", status: "completed", control: { value: "2026-11-07" } })
      expect(filled.message).toBeUndefined()
      expect(date.value).toBe("2026-11-07")
      expect(date.events.map((event) => event.type)).toEqual(["input", "change"])
      expect(await run("time-fill", observation, { type: "fill", ref: refOf(observation, "Start"), text: "09:30" })).toMatchObject({
        control: { value: "09:30" },
      })
    } finally {
      await stopBridge()
    }
  })

  test("observes a date input inside an approved same-origin iframe and fills it", async () => {
    const dom = createFakeControls()
    const inner = dom.control({ tag: "input", attributes: { type: "date" } })
    const outer = dom.control({ tag: "input", attributes: { type: "date" } })
    const { observe, run } = await connect({
      131: { role: "date", name: "Arrival", element: inner, quad, frame: "same-frame" },
      132: { role: "date", name: "Departure", element: outer, quad },
    })
    try {
      harness.page.sameOriginFrame = true
      const observation = await observe("same-frame-observe")
      expect(observation.elements.map((item) => [item.name, item.frame])).toEqual([
        ["Departure", undefined],
        ["Arrival", "https://example.test/inner"],
      ])
      const filled = await run("same-frame-fill", observation, { type: "fill", ref: refOf(observation, "Arrival"), text: "2026-12-24" })
      expect(filled).toMatchObject({ type: "result", status: "completed", control: { value: "2026-12-24" } })
      expect(inner.value).toBe("2026-12-24")
      expect(outer.value).toBe("")
    } finally {
      await stopBridge()
    }
  })

  test("a ref wait treats a node removed from the document as detached although Chrome still describes it", async () => {
    const dom = createFakeControls()
    const banner = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run } = await connect({ 79: field(banner, "Banner") })
    try {
      const observation = await observe("ref-observe")
      const ref = refOf(observation, "Banner")
      expect(await run("ref-attached", observation, { type: "wait", ref, timeoutMs: 0 })).toMatchObject({ type: "result" })
      expect(await run("ref-visible", observation, { type: "wait", ref, state: "visible", timeoutMs: 0 })).toMatchObject({ type: "result" })
      expect(await run("ref-not-detached", observation, { type: "wait", ref, state: "detached", timeoutMs: 0 })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      setTimeout(() => (banner.isConnected = false), 50)
      const start = harness.commands.length
      expect(await run("ref-removed", observation, { type: "wait", ref, state: "detached", timeoutMs: 2000 })).toMatchObject({
        type: "result",
        status: "completed",
      })
      expect(harness.commands.slice(start).some((item) => item.method === "DOM.describeNode")).toBe(false)
      expect(calls(start).every((item) => item.params.functionDeclaration === "function () { return this.isConnected }")).toBe(true)
      expect(calls(start).every((item) => item.params.arguments.length === 0 && item.params.objectId === "node-79")).toBe(true)
      expect(await run("ref-hidden", observation, { type: "wait", ref, state: "hidden", timeoutMs: 0 })).toMatchObject({ type: "result" })
      expect(await run("ref-gone", observation, { type: "wait", ref, timeoutMs: 0 })).toMatchObject({ type: "error", dispatched: false })
    } finally {
      await stopBridge()
    }
  })

  test("waits for a URL pattern over origin and path and never matches the query or fragment", async () => {
    const { observe, run } = await connect({ 83: { role: "button", name: "Next", nodeName: "BUTTON", quad } })
    try {
      const first = await observe("url-observe")
      setTimeout(() => (harness.page.profileTabs[0].url = "https://example.test/done?step=synthetic-query#synthetic-fragment"), 50)
      const met = await run("url-met", first, { type: "wait", url: "https://example.test/do*e", timeoutMs: 2000 })
      expect(met).toMatchObject({ type: "result", status: "completed" })
      for (const [callID, url] of [
        ["url-query", "*synthetic-query*"],
        ["url-fragment", "*synthetic-fragment"],
        ["url-full", "https://example.test/done?step=synthetic-query"],
      ]) {
        const observation = await observe(`${callID}-observe`)
        const outcome = await run(callID, observation, { type: "wait", url, timeoutMs: 0 })
        expect(outcome).toMatchObject({ type: "error", dispatched: false })
        expect(outcome.message).not.toContain("synthetic")
      }
    } finally {
      await stopBridge()
    }
  })

  test("waits for domcontentloaded and load from readyState and for networkidle from in-flight request tracking", async () => {
    const { observe, run } = await connect({ 84: { role: "button", name: "Go", nodeName: "BUTTON", quad } })
    const clock = useClock()
    try {
      const observation = await observe("load-observe")
      expect(harness.commands).toContainEqual(expect.objectContaining({ source: { tabId: 17 }, method: "Network.enable" }))
      harness.page.documents.main.readyState = "loading"
      setTimeout(() => (harness.page.documents.main.readyState = "interactive"), 50)
      const start = harness.commands.length
      expect(await run("load-dom", observation, { type: "wait", load: "domcontentloaded", timeoutMs: 2000 })).toMatchObject({ type: "result" })
      const ready = calls(start)
      expect(ready.length).toBeGreaterThan(0)
      expect(ready.every((item) => item.params.executionContextId !== undefined && item.params.objectId === undefined)).toBe(true)
      expect(await run("load-load", observation, { type: "wait", load: "load", timeoutMs: 0 })).toMatchObject({ type: "error", dispatched: false })
      harness.page.documents.main.readyState = "complete"
      expect(await run("load-default", observation, { type: "wait", timeoutMs: 0 })).toMatchObject({ type: "result" })
      const idle = run("load-idle", observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
      await Bun.sleep(50)
      clock.advance(500)
      expect(await idle).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands.some((item) => item.method === "Page.setLifecycleEventsEnabled")).toBe(false)
      expect(harness.commands.some((item) => item.method === "Runtime.callFunctionOn" && item.params.functionDeclaration.includes("getEntriesByType"))).toBe(false)
    } finally {
      clock.restore()
      await stopBridge()
    }
  })

  test("networkidle is met after load when no request is pending", async () => {
    const { observe, run, reply } = await connect({ 85: { role: "button", name: "Go", nodeName: "BUTTON", quad } })
    const clock = useClock()
    try {
      const observation = await observe("idle-observe")
      const idle = run("idle-quiet", observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
      await Bun.sleep(50)
      expect(reply("idle-quiet")).toBeUndefined()
      clock.advance(500)
      expect(await idle).toMatchObject({ type: "result", status: "completed" })
    } finally {
      clock.restore()
      await stopBridge()
    }
  })

  test("networkidle is not met while a request started after load is pending", async () => {
    const { observe, run, reply } = await connect({ 86: { role: "button", name: "Go", nodeName: "BUTTON", quad } }, { child: true })
    const clock = useClock()
    try {
      const observation = await observe("pending-observe", ["https://child.example.test"])
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/slow" } })
      const blocked = run("pending-main", observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
      await Bun.sleep(50)
      clock.advance(2000)
      await Bun.sleep(150)
      expect(reply("pending-main")).toBeUndefined()
      clock.advance(3500)
      expect(await blocked).toMatchObject({ type: "error", dispatched: false, message: expect.stringContaining("Timed out") })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.loadingFinished", { requestId: "r1" })

      await waitFor(() => harness.commands.some((item) => item.method === "Network.enable" && item.source.sessionId === "child-1"))
      await harness.debuggerEvents.emit({ tabId: 17, sessionId: "child-1" }, "Network.requestWillBeSent", { requestId: "c1", request: { url: childURL } })
      const childBlocked = run("pending-child", observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
      await Bun.sleep(50)
      clock.advance(1000)
      await Bun.sleep(150)
      expect(reply("pending-child")).toBeUndefined()
      await harness.debuggerEvents.emit({ tabId: 17 }, "Target.detachedFromTarget", { sessionId: "child-1" })
      clock.advance(500)
      expect(await childBlocked).toMatchObject({ type: "result", status: "completed" })
    } finally {
      clock.restore()
      await stopBridge()
    }
  })

  test("networkidle is met 500 ms after the pending request finishes and after it fails", async () => {
    const { observe, run, reply } = await connect({ 87: { role: "button", name: "Go", nodeName: "BUTTON", quad } })
    const clock = useClock()
    try {
      const observation = await observe("settle-observe")
      for (const [requestId, settle] of [["r2", "Network.loadingFinished"], ["r3", "Network.loadingFailed"]]) {
        await harness.debuggerEvents.emit({ tabId: 17 }, "Network.requestWillBeSent", { requestId, request: { url: "https://example.test/api" } })
        const callID = `settle-${requestId}`
        const pending = run(callID, observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
        await Bun.sleep(50)
        clock.advance(1000)
        await Bun.sleep(150)
        expect(reply(callID)).toBeUndefined()
        await harness.debuggerEvents.emit({ tabId: 17 }, settle, { requestId, errorText: "net::ERR_FAILED" })
        await Bun.sleep(150)
        expect(reply(callID)).toBeUndefined()
        clock.advance(500)
        expect(await pending).toMatchObject({ type: "result", status: "completed" })
      }
    } finally {
      clock.restore()
      await stopBridge()
    }
  })

  test("a redirected request counts once and settles once", async () => {
    const { observe, run, reply } = await connect({ 88: { role: "button", name: "Go", nodeName: "BUTTON", quad } })
    const clock = useClock()
    try {
      const observation = await observe("redirect-observe")
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.requestWillBeSent", { requestId: "r4", request: { url: "https://example.test/a" } })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.requestWillBeSent", {
        requestId: "r4",
        request: { url: "https://example.test/b" },
        redirectResponse: { status: 302, url: "https://example.test/a" },
      })
      const pending = run("redirect-wait", observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
      await Bun.sleep(50)
      clock.advance(1000)
      await Bun.sleep(150)
      expect(reply("redirect-wait")).toBeUndefined()
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.loadingFinished", { requestId: "r4" })
      clock.advance(500)
      expect(await pending).toMatchObject({ type: "result", status: "completed" })
    } finally {
      clock.restore()
      await stopBridge()
    }
  })

  test("networkidle results and errors contain no URL, header or request data", async () => {
    const { observe, run, socket } = await connect({ 89: { role: "button", name: "Go", nodeName: "BUTTON", quad } })
    const clock = useClock()
    try {
      const observation = await observe("private-observe")
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.requestWillBeSent", {
        requestId: "r5",
        request: {
          url: "https://example.test/synthetic-private-path?token=synthetic-request-secret",
          method: "POST",
          headers: { Authorization: "synthetic-header-secret" },
          postData: "synthetic-body-secret",
        },
        initiator: { type: "script", url: "https://example.test/synthetic-initiator" },
        type: "Fetch",
      })
      expect(await run("private-timeout", observation, { type: "wait", load: "networkidle", timeoutMs: 0 })).toMatchObject({
        type: "error",
        dispatched: false,
      })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Network.loadingFailed", { requestId: "r5", errorText: "synthetic-error-secret" })
      const pending = run("private-idle", observation, { type: "wait", load: "networkidle", timeoutMs: 5000 })
      await Bun.sleep(50)
      clock.advance(500)
      expect(await pending).toMatchObject({ type: "result", status: "completed" })
      const sent = JSON.stringify(socket.outgoing)
      for (const secret of ["synthetic-private-path", "synthetic-request-secret", "synthetic-header-secret", "synthetic-body-secret", "synthetic-initiator", "synthetic-error-secret", "Fetch"])
        expect(sent).not.toContain(secret)
    } finally {
      clock.restore()
      await stopBridge()
    }
  })

  test("waits for text and returns only completion and the matching frame", async () => {
    const { observe, run } = await connect({ 90: { role: "button", name: "Go", nodeName: "BUTTON", quad } }, { child: true })
    try {
      const observation = await observe("text-observe", ["https://child.example.test"])
      harness.page.documents.main.body.innerText = "Loading"
      setTimeout(() => (harness.page.documents.main.body.innerText = "Order\n   saved for synthetic-customer"), 50)
      const met = await run("text-main", observation, { type: "wait", text: "Order saved", timeoutMs: 2000 })
      expect(met).toMatchObject({ type: "result", status: "completed" })
      expect(met.frame).toBeUndefined()
      expect(met.text).toBeUndefined()
      expect(JSON.stringify(met)).not.toContain("synthetic-customer")
      harness.page.documents["child-1"].body.innerText = "Child total 42"
      const framed = await run("text-child", observation, { type: "wait", text: "total 42", timeoutMs: 0 })
      expect(framed).toMatchObject({ type: "result", frame: childURL })
      expect(framed.text).toBeUndefined()
      expect(await run("text-missing", observation, { type: "wait", text: "Absent words", timeoutMs: 0 })).toMatchObject({
        type: "error",
        dispatched: false,
      })
    } finally {
      await stopBridge()
    }
  })

  test("creates one control world per frame document and recreates it after that frame navigates", async () => {
    const dom = createFakeControls()
    const main = dom.control({ tag: "input", attributes: { type: "text" } })
    const inner = dom.control({ tag: "input", attributes: { type: "text" } })
    const { observe, run } = await connect({ 91: field(main, "Main field"), 92: field(inner, "Child field", { session: "child-1" }) }, { child: true })
    try {
      const frameOrigins = ["https://child.example.test"]
      const observation = await observe("world-observe", frameOrigins)
      for (const callID of ["world-main-1", "world-main-2"])
        expect(await run(callID, observation, { type: "fill", ref: refOf(observation, "Main field"), text: callID }, frameOrigins)).toMatchObject({ type: "result" })
      for (const callID of ["world-child-1", "world-child-2"])
        expect(await run(callID, observation, { type: "fill", ref: refOf(observation, "Child field"), text: callID }, frameOrigins)).toMatchObject({ type: "result" })
      expect(controlWorlds(undefined)).toHaveLength(1)
      expect(controlWorlds("child-1")).toHaveLength(1)
      expect(controlWorlds(undefined)[0].params).toEqual({ frameId: "main-frame", worldName: "ycoding-control" })
      expect(controlWorlds("child-1")[0].params).toEqual({ frameId: "child-frame", worldName: "ycoding-control" })
      expect(inner.value).toBe("world-child-2")
      await harness.debuggerEvents.emit({ tabId: 17, sessionId: "child-1" }, "Page.frameNavigated", {
        frame: { id: "child-frame", url: "https://child.example.test/next" },
      })
      const next = await observe("world-observe-next", frameOrigins)
      expect(await run("world-child-3", next, { type: "fill", ref: refOf(next, "Child field"), text: "after" }, frameOrigins)).toMatchObject({ type: "result" })
      expect(controlWorlds("child-1")).toHaveLength(2)
      expect(controlWorlds(undefined)).toHaveLength(1)
    } finally {
      await stopBridge()
    }
  })
})

describe("Chrome bridge peripherals", () => {
  async function stopBridge() {
    if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
      await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  }
  async function connect() {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Shell" }]
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "p".repeat(32) })
    const socket = harness.FakeWebSocket.instance
    const shared = socket.outgoing.find((message) => message.type === "shared")
    await socket.receive({ type: "observe", callID: "peripheral-observe", tabID: shared.tabID, generation: "bridge-1" })
    const observation = socket.outgoing.find((message) => message.callID === "peripheral-observe")
    return { socket, shared, observation }
  }

  test("searches history with the optional permission and filters credential URLs", async () => {
    const { socket } = await connect()
    try {
      await socket.receive({ type: "history", callID: "h1", generation: "bridge-1", query: "visited", limit: 5 })
      const result = socket.outgoing.find((message) => message.callID === "h1")
      expect(result).toMatchObject({ type: "history_result" })
      expect(result.entries).toEqual([{ url: "https://example.test/visited", title: "Visited", lastVisitTime: 10, visitCount: 2 }])
      harness.page.historyGranted = false
      await socket.receive({ type: "history", callID: "h2", generation: "bridge-1", query: "visited" })
      expect(socket.outgoing.find((message) => message.callID === "h2")).toMatchObject({ type: "history_error" })
    } finally {
      await stopBridge()
    }
  })

  test("reads and writes the clipboard only on capture-safe pages", async () => {
    const { socket, shared, observation } = await connect()
    try {
      await socket.receive(action("clip-read", shared.tabID, observation, { type: "clipboard_read" }))
      expect(socket.outgoing.find((message) => message.callID === "clip-read")).toMatchObject({
        type: "result",
        status: "completed",
        text: "clipboard-fixture",
      })
      await socket.receive(action("clip-write", shared.tabID, observation, { type: "clipboard_write", text: "synthetic-write" }))
      expect(socket.outgoing.find((message) => message.callID === "clip-write")).toMatchObject({ type: "result", status: "completed" })
      expect(
        harness.commands.some((item) => item.method === "Runtime.evaluate" && item.params.expression.includes("synthetic-write")),
      ).toBe(true)
      harness.page.documentRoot = node("#document", { children: [password()] })
      await socket.receive(action("clip-read-password", shared.tabID, observation, { type: "clipboard_read" }))
      expect(socket.outgoing.find((message) => message.callID === "clip-read-password")).toMatchObject({
        type: "error",
        dispatched: false,
      })
    } finally {
      await stopBridge()
    }
  })

  test("sets files on a file input and rejects other inputs", async () => {
    const { socket, shared, observation } = await connect()
    try {
      harness.page.fileInput = true
      await socket.receive(action("upload-1", shared.tabID, observation, { type: "upload", ref: "b1", paths: ["/tmp/fixture.txt"] }))
      expect(socket.outgoing.find((message) => message.callID === "upload-1")).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands).toContainEqual(
        expect.objectContaining({ method: "DOM.setFileInputFiles", params: { backendNodeId: 91, files: ["/tmp/fixture.txt"] } }),
      )
      harness.page.fileInput = false
      await socket.receive(action("upload-2", shared.tabID, observation, { type: "upload", ref: "b1", paths: ["/tmp/fixture.txt"] }))
      expect(socket.outgoing.find((message) => message.callID === "upload-2")).toMatchObject({ type: "error", dispatched: false })
    } finally {
      await stopBridge()
    }
  })

  test("waits for a completed download and returns bounded dev logs", async () => {
    const { socket, shared, observation } = await connect()
    try {
      harness.page.downloadItems = [{ id: 5, filename: "report.csv", state: "complete", bytesReceived: 3, totalBytes: 3 }]
      await socket.receive(action("download-1", shared.tabID, observation, { type: "download", timeoutMs: 1000 }))
      expect(socket.outgoing.find((message) => message.callID === "download-1")).toMatchObject({
        type: "result",
        status: "completed",
        download: { filename: "report.csv", state: "complete" },
      })
      harness.page.downloadItems = []
      await socket.receive(action("download-2", shared.tabID, observation, { type: "download", timeoutMs: 250 }))
      expect(socket.outgoing.find((message) => message.callID === "download-2")).toMatchObject({ type: "error", dispatched: false })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "hello-log" }],
      })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Runtime.exceptionThrown", {
        exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } },
      })
      await socket.receive(action("logs-1", shared.tabID, observation, { type: "logs" }))
      const logs = socket.outgoing.find((message) => message.callID === "logs-1")
      expect(logs).toMatchObject({ type: "result", status: "completed" })
      expect(logs.logs).toContainEqual(expect.objectContaining({ level: "log", text: "hello-log" }))
      expect(logs.logs).toContainEqual(expect.objectContaining({ level: "error", text: expect.stringContaining("boom") }))
    } finally {
      await stopBridge()
    }
  })

  test("reports a JavaScript dialog, answers it, and errors when none is open", async () => {
    const { socket, shared, observation } = await connect()
    try {
      expect(observation.elements[0].locator).toBe('role=textbox[name="Name"]')
      await socket.receive(action("dialog-none", shared.tabID, observation, { type: "dialog" }))
      expect(socket.outgoing.find((message) => message.callID === "dialog-none")).toMatchObject({ type: "error", dispatched: false })
      await harness.debuggerEvents.emit({ tabId: 17 }, "Page.javascriptDialogOpening", {
        type: "confirm",
        message: "Proceed?",
        hasBrowserHandler: false,
      })
      await socket.receive(action("dialog-read", shared.tabID, observation, { type: "dialog" }))
      expect(socket.outgoing.find((message) => message.callID === "dialog-read")).toMatchObject({
        type: "result",
        status: "completed",
        dialog: { kind: "confirm", message: "Proceed?" },
      })
      await socket.receive(action("dialog-accept", shared.tabID, observation, { type: "dialog", accept: true }))
      expect(socket.outgoing.find((message) => message.callID === "dialog-accept")).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands).toContainEqual(
        expect.objectContaining({ method: "Page.handleJavaScriptDialog", params: { accept: true } }),
      )
    } finally {
      await stopBridge()
    }
  })

  test("captures a clip rectangle and the full page on request", async () => {
    const { socket, shared, observation } = await connect()
    try {
      await socket.receive(action("capture-clip", shared.tabID, observation, { type: "capture", clip: { x: 1, y: 2, width: 30, height: 40 } }))
      expect(socket.outgoing.find((message) => message.callID === "capture-clip")).toMatchObject({ type: "result", status: "completed" })
      expect(harness.commands).toContainEqual(
        expect.objectContaining({
          method: "Page.captureScreenshot",
          params: expect.objectContaining({ clip: { x: 1, y: 2, width: 30, height: 40, scale: 1 }, captureBeyondViewport: true }),
        }),
      )
      await socket.receive(action("capture-full", shared.tabID, observation, { type: "capture", fullPage: true }))
      expect(socket.outgoing.find((message) => message.callID === "capture-full")).toMatchObject({ type: "result", status: "completed" })
      const screenshots = harness.commands.filter((item) => item.method === "Page.captureScreenshot")
      expect(screenshots.at(-1).params).toMatchObject({ captureBeyondViewport: true })
      expect(screenshots.at(-1).params.clip).toBeUndefined()
    } finally {
      await stopBridge()
    }
  })

  test("exports MHTML data and reports WebMCP unsupported when the page has no model context", async () => {
    const { socket, shared, observation } = await connect()
    try {
      await socket.receive(action("export-1", shared.tabID, observation, { type: "export" }))
      expect(socket.outgoing.find((message) => message.callID === "export-1")).toMatchObject({
        type: "result",
        status: "completed",
        data: "MHTML-FIXTURE",
      })
      await socket.receive(action("webmcp-1", shared.tabID, observation, { type: "webmcp_list" }))
      expect(socket.outgoing.find((message) => message.callID === "webmcp-1")).toMatchObject({
        type: "error",
        dispatched: false,
        message: expect.stringContaining("WebMCP"),
      })
    } finally {
      await stopBridge()
    }
  })
})

describe("Chrome control marker", () => {
  const tabAt = (id, extra = {}) => ({ id, active: false, windowId: 1, groupId: -1, url: "https://example.test/form", title: "Inbox", ...extra })
  const flush = () => Bun.sleep(2)
  const evaluations = (tabId) => harness.timeline.filter(([kind, method, id]) => kind === "command" && method === "Runtime.evaluate" && (tabId === undefined || id === tabId))
  const indexOf = (predicate) => harness.timeline.findIndex(predicate)

  async function connect(secret, tabs = [tabAt(17)]) {
    harness.reset()
    harness.page.profileTabs = tabs
    harness.cursorDOM.setPageTitle("Inbox")
    intervals.clear()
    await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: secret.repeat(32) })
    const socket = harness.FakeWebSocket.instance
    return { socket, shared: socket.outgoing.filter((message) => message.type === "shared") }
  }
  async function observe(socket, tabID, callID = "observe-marker") {
    await socket.receive({ type: "observe", tabID, generation: "bridge-1", callID })
    return socket.outgoing.find((message) => message.callID === callID)
  }
  async function stopBridge() {
    if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
      await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
  }
  const refresh = () => [...intervals.values()].find((interval) => interval.delay === timing.refresh)

  test("marks the tab favicon before observing and relinquish restores the page favicon before detaching", async () => {
    const { socket, shared } = await connect("m")
    try {
      const observation = await observe(socket, shared[0].tabID)
      expect(observation).toMatchObject({ type: "observation" })
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      expect(harness.cursorDOM.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
      expect(harness.cursorDOM.markers()).toHaveLength(1)
      expect(indexOf(([, method]) => method === "Runtime.evaluate")).toBeLessThan(
        indexOf(([, method]) => method === "Accessibility.getFullAXTree"),
      )

      harness.timeline.length = 0
      await socket.receive({ type: "relinquish", callID: "release-1", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(socket.outgoing.at(-1)).toEqual({
        type: "relinquished",
        callID: "release-1",
        tabID: shared[0].tabID,
        generation: "bridge-1",
      })
      expect(indexOf(([kind, method]) => kind === "command" && method === "Runtime.evaluate")).toBeLessThan(
        indexOf(([kind]) => kind === "detach"),
      )
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      expect(harness.cursorDOM.markers()).toHaveLength(0)
      expect(harness.badges.at(-1)).toMatchObject({ tabId: 17, text: "" })
      expect(refresh()).toBeUndefined()

      await observe(socket, shared[0].tabID, "observe-again")
      expect(harness.attached).toHaveLength(2)
    } finally {
      await stopBridge()
    }
  })

  test("reports the page's own title to YCoding because the marker never writes the title", async () => {
    const tab = tabAt(17)
    Object.defineProperty(tab, "title", { get: () => harness.cursorDOM.document.title })
    const { socket, shared } = await connect("q", [tab])
    try {
      expect(shared[0].title).toBe("Inbox")
      expect(await observe(socket, shared[0].tabID)).toMatchObject({ title: "Inbox" })
      await socket.receive({ type: "relinquish", callID: "release-title", tabID: shared[0].tabID, generation: "bridge-1" })
      harness.cursorDOM.setPageTitle("Ⓨ real")
      expect(await observe(socket, shared[0].tabID, "observe-title-again")).toMatchObject({ title: "Ⓨ real" })
    } finally {
      await stopBridge()
    }
  })


  test("preserves dynamic page favicons while the logo stays installed", async () => {
    const { socket, shared } = await connect("d")
    try {
      harness.cursorDOM.setPageIcon("/one.png")
      await observe(socket, shared[0].tabID)
      expect(harness.cursorDOM.iconLinks()).toHaveLength(1)
      expect(harness.cursorDOM.iconLinks()[0].getAttribute("href")).toStartWith("data:image/svg+xml,")
      harness.cursorDOM.setPageIcon("/two.png")
      await flush()
      expect(harness.cursorDOM.iconLinks()).toHaveLength(1)
      expect(harness.cursorDOM.iconLinks()[0].getAttribute("href")).toStartWith("data:image/svg+xml,")
      await socket.receive({ type: "relinquish", callID: "release-dynamic", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/two.png"])
      expect(harness.cursorDOM.document.title).toBe("Inbox")
    } finally {
      await stopBridge()
    }
  })


  test("marks a document without a favicon and leaves none behind, keeping a page title it did not write", async () => {
    const { socket, shared } = await connect("t")
    try {
      await observe(socket, shared[0].tabID)
      expect(harness.cursorDOM.iconLinks()).toHaveLength(1)
      await socket.receive({ type: "relinquish", callID: "release-created", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.iconLinks()).toEqual([])

      await observe(socket, shared[0].tabID, "observe-written")
      harness.cursorDOM.setPageTitle("Changed by page")
      await socket.receive({ type: "relinquish", callID: "release-written", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.document.title).toBe("Changed by page")
    } finally {
      await stopBridge()
    }
  })

  test("fails closed before reading when the marker cannot be confirmed and detaches the tab it attached", async () => {
    for (const { name, arrange } of [
      { name: "evaluation failure", arrange: () => (harness.page.cursorEvaluationFails = true) },
      { name: "document without a head", arrange: () => (harness.cursorDOM.headless = true) },
    ]) {
      const { socket, shared } = await connect("f")
      try {
        arrange()
        await socket.receive({ type: "observe", tabID: shared[0].tabID, generation: "bridge-1", callID: `observe-${name}` })
        expect(socket.outgoing.find((message) => message.callID === `observe-${name}`), name).toMatchObject({
          type: "error",
          dispatched: false,
        })
        expect(harness.commands.some((item) => item.method === "Accessibility.getFullAXTree"), name).toBe(false)
        expect(harness.detached, name).toContainEqual({ tabId: 17 })
        expect(harness.cursorDOM.markers(), name).toHaveLength(0)
      } finally {
        await stopBridge()
      }
    }
  })

  test("refuses a pinned tab before attaching because the tab strip shows only its icon", async () => {
    const { socket, shared } = await connect("p", [tabAt(17, { pinned: true })])
    try {
      await socket.receive({ type: "observe", tabID: shared[0].tabID, generation: "bridge-1", callID: "observe-pinned" })
      expect(socket.outgoing.find((message) => message.callID === "observe-pinned")).toMatchObject({
        type: "error",
        dispatched: false,
        message: expect.stringContaining("Pinned"),
      })
      expect(harness.attached).toEqual([])
      expect(harness.commands).toEqual([])
    } finally {
      await stopBridge()
    }
  })

  test("labels the cursor with the action type only and never puts typed text in the page", async () => {
    const { socket, shared } = await connect("l")
    try {
      const observation = await observe(socket, shared[0].tabID)
      await socket.receive(action("label-click", shared[0].tabID, observation, { type: "click", ref: "b1" }))
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Click"])
      expect(harness.cursorDOM.moves.at(-1)).toBe("translate(5px,5px)")
      expect(harness.cursorDOM.animations).toHaveLength(1)

      await socket.receive(action("label-type", shared[0].tabID, observation, { type: "type", ref: "b1", text: "hunter2 secret" }))
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Type"])
      await socket.receive(action("label-scroll", shared[0].tabID, observation, { type: "scroll", deltaY: 120 }))
      expect(harness.cursorDOM.chipText()).toEqual(["YCoding · Scroll"])
      expect(harness.cursorDOM.moves.at(-1)).toBe("translate(50px,40px)")
      expect(harness.cursorDOM.domText()).not.toContain("hunter2")
      expect(harness.cursorDOM.domText()).not.toContain("Session")
      expect(harness.cursorDOM.domText()).not.toContain("example.test")
    } finally {
      await stopBridge()
    }
  })

  test("reduced motion moves the cursor instantly and skips the ripple animation", async () => {
    const { socket, shared } = await connect("r")
    try {
      const observation = await observe(socket, shared[0].tabID)
      harness.cursorDOM.reducedMotion = true
      const before = harness.cursorDOM.frameRequests
      await socket.receive(action("reduced-click", shared[0].tabID, observation, { type: "click", ref: "b1" }))
      expect(harness.cursorDOM.frameRequests).toBe(before)
      expect(harness.cursorDOM.animations).toHaveLength(0)
      expect(harness.cursorDOM.moves.slice(-2)).toEqual(["translate(50px,40px)", "translate(5px,5px)"])
    } finally {
      await stopBridge()
    }
  })

  test("an explicit stop clears the marker before the debugger detaches", async () => {
    const { socket, shared } = await connect("s")
    await observe(socket, shared[0].tabID)
    harness.timeline.length = 0
    await socket.receive({ type: "control", action: "stop" })
    expect(indexOf(([kind, method]) => kind === "command" && method === "Runtime.evaluate")).toBeLessThan(
      indexOf(([kind]) => kind === "detach"),
    )
    expect(harness.cursorDOM.document.title).toBe("Inbox")
    expect(harness.cursorDOM.markers()).toHaveLength(0)
    expect(refresh()).toBeUndefined()
  })

  test("re-marks a new document after a top-level navigation and rebuilds its isolated world once", async () => {
    const { socket, shared } = await connect("n")
    try {
      await observe(socket, shared[0].tabID)
      expect(harness.commands.filter((item) => item.method === "Page.createIsolatedWorld")).toHaveLength(1)
      harness.cursorDOM.navigate()
      harness.cursorDOM.setPageTitle("Next")
      await harness.debuggerEvents.emit({ tabId: 17 }, "Page.frameNavigated", { frame: { url: "https://example.test/next" } })
      await flush()
      expect(harness.cursorDOM.document.title).toBe("Next")
      expect(harness.cursorDOM.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
      expect(harness.commands.filter((item) => item.method === "Page.createIsolatedWorld")).toHaveLength(2)
    } finally {
      await stopBridge()
    }
  })

  test("reuses one isolated world per document and recreates it once when Chrome reports it gone", async () => {
    const { socket, shared } = await connect("w")
    try {
      const observation = await observe(socket, shared[0].tabID)
      await socket.receive(action("world-scroll-1", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      await socket.receive(action("world-scroll-2", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      expect(harness.commands.filter((item) => item.method === "Page.createIsolatedWorld")).toHaveLength(1)
      harness.page.staleContext = 1
      await refresh().callback()
      expect(harness.commands.filter((item) => item.method === "Page.createIsolatedWorld")).toHaveLength(2)
      expect(harness.cursorDOM.markers()).toHaveLength(1)
    } finally {
      await stopBridge()
    }
  })

  test("refreshes the page deadline on the documented cadence and the page removes the marker when refresh stops", async () => {
    const { socket, shared } = await connect("e")
    try {
      await observe(socket, shared[0].tabID)
      expect(refresh()).toBeDefined()
      for (let index = 0; index < 6; index++) {
        harness.cursorDOM.clock.advance(timing.refresh)
        await refresh().callback()
      }
      expect(harness.cursorDOM.markers()).toHaveLength(1)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      expect(harness.cursorDOM.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
      expect(harness.commands.filter((item) => item.method === "Page.createIsolatedWorld")).toHaveLength(1)

      harness.cursorDOM.clock.advance(timing.expiry - 1)
      expect(harness.cursorDOM.markers()).toHaveLength(1)
      harness.cursorDOM.clock.advance(1 + timing.check)
      expect(harness.cursorDOM.markers()).toHaveLength(0)
      expect(harness.cursorDOM.hosts()).toHaveLength(0)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
    } finally {
      await stopBridge()
    }
  })

  test("a thawed or shown page checks the deadline immediately instead of waiting for its timer", async () => {
    const { socket, shared } = await connect("z")
    try {
      await observe(socket, shared[0].tabID)
      harness.cursorDOM.clock.now += timing.expiry + 60_000
      await harness.cursorDOM.dispatch("resume")
      expect(harness.cursorDOM.markers()).toHaveLength(0)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
    } finally {
      await stopBridge()
    }
  })

  test("native Cancel sends no cleanup after detach, stops refreshing, and leaves the page expiry to remove the marker", async () => {
    const { socket, shared } = await connect("c")
    try {
      await observe(socket, shared[0].tabID)
      harness.timeline.length = 0
      await harness.debuggerDetach.emit({ tabId: 17 }, "canceled_by_user")
      expect(evaluations()).toEqual([])
      expect(refresh()).toBeUndefined()
      expect(harness.cursorDOM.markers()).toHaveLength(1)
      harness.cursorDOM.clock.advance(timing.expiry + timing.check)
      expect(harness.cursorDOM.markers()).toHaveLength(0)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
    } finally {
      await stopBridge()
    }
  })

  test("a released tab stays available and its own detach is not treated as native Cancel", async () => {
    const { socket, shared } = await connect("k")
    try {
      await observe(socket, shared[0].tabID)
      await socket.receive({ type: "relinquish", callID: "release-keep", tabID: shared[0].tabID, generation: "bridge-1" })
      await harness.debuggerDetach.emit({ tabId: 17 }, "target_closed")
      expect(await observe(socket, shared[0].tabID, "observe-after-release")).toMatchObject({ type: "observation" })
    } finally {
      await stopBridge()
    }
  })

  test("acknowledges relinquish of an unknown tab and rejects a stale generation without detaching", async () => {
    const { socket, shared } = await connect("u")
    try {
      await observe(socket, shared[0].tabID)
      await socket.receive({ type: "relinquish", callID: "release-unknown", tabID: "btab_unknown", generation: "bridge-1" })
      expect(socket.outgoing.at(-1)).toMatchObject({ type: "relinquished", callID: "release-unknown" })
      harness.detached.length = 0
      await socket.receive({ type: "relinquish", callID: "release-stale", tabID: shared[0].tabID, generation: "bridge-0" })
      expect(socket.outgoing.at(-1)).toMatchObject({ type: "error", callID: "release-stale", dispatched: false })
      expect(harness.detached).toEqual([])
    } finally {
      await stopBridge()
    }
  })

  test("marks every group member before grouping and groups nothing when one member cannot be marked", async () => {
    const tabs = [tabAt(17), tabAt(18, { url: "https://example.test/second" }), tabAt(19, { url: "https://example.test/third" })]
    const { socket, shared } = await connect("g", tabs)
    try {
      const anchor = shared.find((item) => item.url.endsWith("/form"))
      const second = shared.find((item) => item.url.endsWith("/second"))
      const observation = await observe(socket, anchor.tabID)
      harness.timeline.length = 0
      await socket.receive(
        action("group-marked", anchor.tabID, observation, { type: "group", tabIDs: [anchor.tabID, second.tabID], title: "Task" }),
      )
      expect(socket.outgoing.find((message) => message.callID === "group-marked")).toMatchObject({ type: "result" })
      const group = indexOf(([kind]) => kind === "group")
      expect(group).toBeGreaterThan(-1)
      for (const id of [17, 18])
        expect(indexOf(([kind, method, tab]) => kind === "command" && method === "Runtime.evaluate" && tab === id)).toBeLessThan(group)

      await socket.receive({ type: "control", action: "stop" })
    } finally {
      await stopBridge()
    }
    const failing = await connect("h", [tabAt(17), tabAt(18, { url: "https://example.test/second" })])
    try {
      const [first, other] = failing.shared
      const observation = await observe(failing.socket, first.tabID)
      harness.page.evaluationFailsFor = 18
      harness.timeline.length = 0
      await failing.socket.receive(
        action("group-unmarked", first.tabID, observation, { type: "group", tabIDs: [first.tabID, other.tabID], title: "Task" }),
      )
      expect(failing.socket.outgoing.find((message) => message.callID === "group-unmarked")).toMatchObject({
        type: "error",
        dispatched: false,
      })
      expect(indexOf(([kind]) => kind === "group")).toBe(-1)
      expect(harness.detached).toContainEqual({ tabId: 18 })
      expect(harness.detached).not.toContainEqual({ tabId: 17 })
    } finally {
      await stopBridge()
    }
  })

  test("a failed first observe or capture releases the tab that command attached and marked", async () => {
    const cases = [
      {
        name: "accessibility failure",
        arrange: () => (harness.page.axFails = true),
        run: (socket, tab) => socket.receive({ type: "observe", tabID: tab.tabID, generation: "bridge-1", callID: "fresh-failure" }),
      },
      {
        name: "navigation during the observation",
        arrange: () => (harness.page.axNavigates = "https://example.test/moved"),
        run: (socket, tab) => socket.receive({ type: "observe", tabID: tab.tabID, generation: "bridge-1", callID: "fresh-failure" }),
      },
      {
        name: "password capture",
        arrange: () => (harness.page.documentRoot = node("#document", { children: [password()] })),
        run: (socket, tab) =>
          socket.receive(action("fresh-failure", tab.tabID, { documentGeneration: 1, revision: 0 }, { type: "capture" })),
      },
    ]
    for (const { name, arrange, run } of cases) {
      const { socket, shared } = await connect("a")
      try {
        arrange()
        await run(socket, shared[0])
        await flush()
        expect(socket.outgoing.find((message) => message.callID === "fresh-failure"), name).toMatchObject({
          type: "error",
          dispatched: false,
        })
        expect(harness.detached, name).toContainEqual({ tabId: 17 })
        expect(harness.cursorDOM.markers(), name).toHaveLength(0)
        expect(harness.cursorDOM.document.title, name).toBe("Inbox")
        expect(refresh(), name).toBeUndefined()
        expect(harness.badges.at(-1), name).toMatchObject({ tabId: 17, text: "" })
      } finally {
        await stopBridge()
      }
    }
  })

  test("a failed command on a tab that was already controlled keeps the holder's attachment and marker", async () => {
    const { socket, shared } = await connect("b")
    try {
      await observe(socket, shared[0].tabID)
      harness.page.documentRoot = node("#document", { children: [password()] })
      await socket.receive(action("held-failure", shared[0].tabID, { documentGeneration: 1, revision: 1 }, { type: "capture" }))
      expect(socket.outgoing.find((message) => message.callID === "held-failure")).toMatchObject({ type: "error", dispatched: false })
      expect(harness.detached).toEqual([])
      expect(harness.cursorDOM.markers()).toHaveLength(1)
      expect(refresh()).toBeDefined()
    } finally {
      await stopBridge()
    }
  })


  test("restores the favicon when the page removes the marker and never installs a second logo", async () => {
    const { socket, shared } = await connect("e")
    try {
      harness.cursorDOM.setPageIcon("/mine.png")
      await observe(socket, shared[0].tabID)
      harness.cursorDOM.markers()[0].remove()
      await flush()
      expect(harness.cursorDOM.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/mine.png"])
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      await observe(socket, shared[0].tabID, "observe-after-removal")
      expect(harness.cursorDOM.iconLinks()).toHaveLength(1)
      expect(harness.cursorDOM.iconLinks()[0].getAttribute("href")).toStartWith("data:image/svg+xml,")
    } finally {
      await stopBridge()
    }
  })


  test("never alters a page title, whatever it contains, across mark and removal", async () => {
    const { socket, shared } = await connect("i")
    try {
      harness.cursorDOM.setPageTitle("Ⓨ real")
      harness.cursorDOM.setPageIcon("/real.png")
      await observe(socket, shared[0].tabID)
      expect(harness.cursorDOM.document.title).toBe("Ⓨ real")
      expect(harness.cursorDOM.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
      harness.cursorDOM.markers()[0].remove()
      await flush()
      expect(harness.cursorDOM.document.title).toBe("Ⓨ real")
      expect(harness.cursorDOM.iconLinks().map((node) => node.getAttribute("href"))).toEqual(["/real.png"])
      await observe(socket, shared[0].tabID, "observe-website-prefix")
      await socket.receive({ type: "relinquish", callID: "release-website-prefix", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.document.title).toBe("Ⓨ real")
    } finally {
      await stopBridge()
    }
  })

  test("a title the page changed after removing the marker is left alone and its timers stay stopped", async () => {
    const { socket, shared } = await connect("j")
    try {
      await observe(socket, shared[0].tabID)
      harness.cursorDOM.setPageTitle("Changed first")
      harness.cursorDOM.markers()[0].remove()
      await flush()
      expect(harness.cursorDOM.document.title).toBe("Changed first")
      harness.cursorDOM.clock.advance(timing.expiry * 2)
      harness.cursorDOM.setPageTitle("Later")
      await flush()
      expect(harness.cursorDOM.document.title).toBe("Later")
    } finally {
      await stopBridge()
    }
  })

  test("group and ungroup report the page's own title while the logo marker is installed", async () => {
    const tabs = [tabAt(17), tabAt(18, { url: "https://example.test/second" })]
    for (const tab of tabs) Object.defineProperty(tab, "title", { get: () => harness.cursorDOM.document.title })
    const { socket, shared } = await connect("t", tabs)
    try {
      const anchor = shared.find((item) => item.url.endsWith("/form"))
      const second = shared.find((item) => item.url.endsWith("/second"))
      const observation = await observe(socket, anchor.tabID)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      expect(harness.cursorDOM.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
      await socket.receive(action("group-title", anchor.tabID, observation, { type: "group", tabIDs: [anchor.tabID, second.tabID], title: "Task" }))
      expect(socket.outgoing.find((message) => message.callID === "group-title")).toMatchObject({ type: "result", title: "Inbox" })
      await socket.receive(action("ungroup-title", anchor.tabID, observation, { type: "ungroup", tabIDs: [anchor.tabID, second.tabID], groupID: 7 }))
      expect(socket.outgoing.find((message) => message.callID === "ungroup-title")).toMatchObject({ type: "result", title: "Inbox" })
    } finally {
      await stopBridge()
    }
  })

  test("a refresh still in flight when control is released cannot repaint the marker or revive the timer", async () => {
    const { socket, shared } = await connect("r")
    try {
      await observe(socket, shared[0].tabID)
      const gate = Promise.withResolvers()
      harness.page.holdMark = gate
      const refreshing = refresh().callback()
      await flush()
      const releasing = socket.receive({ type: "relinquish", callID: "release-race", tabID: shared[0].tabID, generation: "bridge-1" })
      await Bun.sleep(50)
      gate.resolve()
      await Promise.all([refreshing, releasing])
      expect(socket.outgoing.at(-1)).toMatchObject({ type: "relinquished", callID: "release-race" })
      expect(harness.cursorDOM.markers()).toHaveLength(0)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      expect(harness.detached).toContainEqual({ tabId: 17 })
      expect(refresh()).toBeUndefined()
      const lastEvaluation = harness.timeline.findLastIndex(([kind, method]) => kind === "command" && method === "Runtime.evaluate")
      expect(lastEvaluation).toBeLessThan(harness.timeline.findLastIndex(([kind]) => kind === "detach"))
    } finally {
      await stopBridge()
    }
  })

  test("a refresh that outlasts the cleanup bound leaves no timer and the page expiry removes what it painted", async () => {
    const { socket, shared } = await connect("q")
    try {
      await observe(socket, shared[0].tabID)
      const gate = Promise.withResolvers()
      harness.page.holdMark = gate
      const refreshing = refresh().callback()
      await flush()
      await socket.receive({ type: "relinquish", callID: "release-stuck", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(socket.outgoing.at(-1)).toMatchObject({ type: "relinquished", callID: "release-stuck" })
      expect(harness.detached).toContainEqual({ tabId: 17 })
      gate.resolve()
      await refreshing
      await flush()
      expect(refresh()).toBeUndefined()
      harness.cursorDOM.clock.advance(timing.expiry + timing.check)
      expect(harness.cursorDOM.markers()).toHaveLength(0)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
    } finally {
      await stopBridge()
    }
  })

  const cursorEvaluations = () =>
    harness.commands.filter((item) => item.method === "Runtime.evaluate" && item.params.expression.includes('"cursor":{'))
  const withFont = (item) => /"fontData":"[A-Za-z0-9+/=]{1000,}"/.test(item.params.expression)

  test("sends the label font once per document and never with a refresh", async () => {
    const { socket, shared } = await connect("F")
    try {
      const observation = await observe(socket, shared[0].tabID)
      await socket.receive(action("font-scroll-1", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      await socket.receive(action("font-scroll-2", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      expect(cursorEvaluations().map(withFont)).toEqual([true, false])
      await refresh().callback()
      expect(harness.commands.filter((item) => item.method === "Runtime.evaluate" && withFont(item))).toHaveLength(1)
      expect(harness.cursorDOM.fontFaces().map((face) => face.family)).toEqual(["YCodingGeist"])
    } finally {
      await stopBridge()
    }
  })

  test("sends the font again for a new document but not when only the isolated world is recreated", async () => {
    const { socket, shared } = await connect("G")
    try {
      const observation = await observe(socket, shared[0].tabID)
      await socket.receive(action("font-again-1", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      harness.cursorDOM.navigate()
      harness.cursorDOM.setPageTitle("Next")
      await harness.debuggerEvents.emit({ tabId: 17 }, "Page.frameNavigated", { frame: { url: "https://example.test/next" } })
      await flush()
      const next = await observe(socket, shared[0].tabID, "observe-font-next")
      await socket.receive(action("font-again-2", shared[0].tabID, next, { type: "scroll", deltaY: 10 }))
      expect(cursorEvaluations().map(withFont)).toEqual([true, true])
      const settled = await observe(socket, shared[0].tabID, "observe-font-settled")
      harness.page.staleContext = 1
      await socket.receive(action("font-again-3", shared[0].tabID, settled, { type: "scroll", deltaY: 10 }))
      expect(cursorEvaluations().map(withFont)).toEqual([true, true, false])
      expect(harness.cursorDOM.fontFaces()).toHaveLength(1)
    } finally {
      await stopBridge()
    }
  })

  test("keeps sending the font until the page confirms it and never blocks the action when it cannot install", async () => {
    const { socket, shared } = await connect("H")
    try {
      harness.cursorDOM.fontLoadFails = true
      const observation = await observe(socket, shared[0].tabID)
      await socket.receive(action("font-fail-1", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      await socket.receive(action("font-fail-2", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      expect(socket.outgoing.filter((message) => message.callID?.startsWith("font-fail")).map((message) => message.type)).toEqual(["result", "result"])
      expect(cursorEvaluations().map(withFont)).toEqual([true, true])
      harness.cursorDOM.fontLoadFails = false
      await socket.receive(action("font-fail-3", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      await socket.receive(action("font-fail-4", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      expect(cursorEvaluations().map(withFont)).toEqual([true, true, true, false])
    } finally {
      await stopBridge()
    }
  })

  test("release and stop remove the page face along with the marker", async () => {
    const { socket, shared } = await connect("I")
    try {
      const observation = await observe(socket, shared[0].tabID)
      await socket.receive(action("font-release", shared[0].tabID, observation, { type: "scroll", deltaY: 10 }))
      expect(harness.cursorDOM.fontFaces()).toHaveLength(1)
      await socket.receive({ type: "relinquish", callID: "release-font", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.fontFaces()).toEqual([])
    } finally {
      await stopBridge()
    }
  })

  test("marks an owned tab before reporting it open and closes it when the marker cannot be shown", async () => {
    const { socket } = await connect("o")
    try {
      await socket.receive({ type: "open", callID: "open-marked", tabID: "btab_owned_marked", generation: "bridge-1", url: "https://example.test/owned" })
      await waitFor(() => socket.outgoing.some((message) => message.callID === "open-marked"))
      expect(socket.outgoing.find((message) => message.callID === "open-marked")).toMatchObject({ type: "opened" })
      expect(evaluations(24).length).toBeGreaterThan(0)
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      expect(harness.cursorDOM.iconLinks()[0]?.getAttribute("href")).toStartWith("data:image/svg+xml,")
      await socket.receive({ type: "release", tabID: "btab_owned_marked", generation: "bridge-1" })
      expect(harness.cursorDOM.markers()).toHaveLength(0)

      harness.removed.length = 0
      harness.page.evaluationFailsFor = 24
      await socket.receive({ type: "open", callID: "open-unmarked", tabID: "btab_owned_unmarked", generation: "bridge-1", url: "https://example.test/owned" })
      await waitFor(() => socket.outgoing.some((message) => message.callID === "open-unmarked"))
      expect(socket.outgoing.find((message) => message.callID === "open-unmarked")).toMatchObject({ type: "error" })
      expect(harness.removed).toContain(24)
    } finally {
      await stopBridge()
    }
  })
})

function createHarness() {
  const runtimeMessages = listeners()
  const runtimeStartup = listeners()
  const tabActivations = listeners()
  const tabCreated = listeners()
  const tabUpdated = listeners()
  const tabRemoved = listeners()
  const tabAttached = listeners()
  const debuggerEvents = listeners()
  const debuggerDetach = listeners()
  const commands = []
  const attached = []
  const detached = []
  const created = []
  const removed = []
  const grouped = []
  const groupUpdates = []
  const ungrouped = []
  const badges = []
  const cursorDOM = createFakePage()
  const timeline = []
  const attachedNow = new Set()
  const contexts = new Map()
  let createdURL = "about:blank"
  const storage = {
    browserPairing: {
      serverURL: "http://127.0.0.1:4096",
      serverID: "server-restored-1",
      credential: "r".repeat(43),
      enabled: true,
    },
  }
  const alarms = alarmHarness()
  const page = {
    active: true,
    ownedActive: false,
    profileTabs: undefined,
    historyUnavailable: 0,
    holdCreate: Promise.resolve(),
    href: undefined,
    typeRedirect: undefined,
    cursorEvaluationFails: false,
    cursorEvaluationHangs: false,
    cursorPlacementFails: false,
    cursorPlacementHangs: false,
    focusEmulationFails: false,
    axFails: false,
    axNavigates: undefined,
    holdMark: undefined,
    evaluationFailsFor: undefined,
    staleContext: 0,
    documentRoot: node("#document"),
    child: undefined,
    childDocumentRoot: node("#document"),
    historyEntries: undefined,
    historyIndex: 0,
    historyGranted: true,
    downloadsGranted: true,
    historyResults: undefined,
    downloadItems: undefined,
    clipboardText: "clipboard-fixture",
    fileInput: false,
    controls: undefined,
    clickEffect: undefined,
    keyEffect: undefined,
    documents: fakeDocuments(),
  }

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    static failConnections = false
    static instance
    static instances = []

    readyState = 0
    outgoing = []
    events = new Map()

    constructor() {
      FakeWebSocket.instance = this
      FakeWebSocket.instances.push(this)
      queueMicrotask(() => {
        if (FakeWebSocket.failConnections) {
          this.readyState = FakeWebSocket.CLOSED
          void this.emit("error", {})
          return
        }
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
              version: 6,
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
              version: 6,
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
    runtimeStartup,
    tabActivations,
    debuggerEvents,
    commands,
    attached,
    detached,
    created,
    removed,
    grouped,
    groupUpdates,
    ungrouped,
    badges,
    debuggerDetach,
    tabCreated,
    tabUpdated,
    tabRemoved,
    storage,
    alarms,
    page,
    cursorDOM,
    timeline,
    FakeWebSocket,
    chrome: {
      runtime: {
        id: "extension-test",
        onMessage: runtimeMessages,
        onStartup: runtimeStartup,
      },
      action: {
        setBadgeText: async (input) => {
          badges.push(input)
        },
        setBadgeBackgroundColor: async () => {},
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
        onCreated: tabCreated,
        onUpdated: tabUpdated,
        onRemoved: tabRemoved,
        onAttached: tabAttached,
        create: async (options) => {
          created.push(options)
          if (page.holdCreate) await page.holdCreate
          return { id: 24, active: false }
        },
        remove: async (id) => {
          removed.push(id)
        },
        query: async (options = {}) => {
          const results = page.profileTabs ?? [{ id: 17, active: page.active, windowId: 1, title: "Example" }]
          return options.groupId === undefined ? results : results.filter((tab) => tab.groupId === options.groupId)
        },
        group: async (options) => {
          timeline.push(["group"])
          grouped.push(options)
          for (const tab of page.profileTabs ?? []) if (options.tabIds.includes(tab.id)) tab.groupId = 7
          return 7
        },
        ungroup: async (ids) => {
          ungrouped.push(ids)
          for (const tab of page.profileTabs ?? []) if (ids.includes(tab.id)) tab.groupId = -1
        },
        get: async (id) =>
          id === 24
            ? { id, active: page.ownedActive }
            : (page.profileTabs?.find((tab) => tab.id === id) ?? {
                id: 17,
                active: page.active,
                windowId: 1,
                title: "Example",
                url: "https://example.test/form",
              }),
      },
      tabGroups: {
        update: async (groupId, updateProperties) => {
          groupUpdates.push({ groupId, updateProperties })
        },
      },
      permissions: {
        contains: async ({ permissions }) =>
          permissions.every((name) => (name === "history" ? page.historyGranted : name === "downloads" ? page.downloadsGranted : true)),
        request: async () => false,
      },
      history: {
        search: async () =>
          page.historyResults ?? [
            { url: "https://example.test/visited", title: "Visited", lastVisitTime: 10, visitCount: 2 },
            { url: "https://user:secret@example.test/private", title: "Credential", lastVisitTime: 9, visitCount: 1 },
          ],
      },
      downloads: {
        onCreated: listeners(),
        onChanged: listeners(),
        search: async () => page.downloadItems ?? [],
      },
      debugger: {
        onDetach: debuggerDetach,
        onEvent: debuggerEvents,
        attach: async (source) => {
          attachedNow.add(source.tabId)
          attached.push(source)
        },
        detach: async (source) => {
          timeline.push(["detach", source.tabId])
          attachedNow.delete(source.tabId)
          detached.push(source)
        },
        sendCommand: async (source, method, params = {}) => {
          commands.push({ source, method, params })
          timeline.push(["command", method, source.tabId])
          if (!attachedNow.has(source.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${source.tabId}`)
          if (method === "Emulation.setFocusEmulationEnabled" && page.focusEmulationFails)
            throw new Error("Focus emulation unavailable")
          if (method === "Page.navigate" && source.tabId === 24) createdURL = params.url
          if (method === "Page.getNavigationHistory") {
            if (source.tabId === 24 && page.historyUnavailable-- > 0)
              throw new Error('{"code":-32000,"message":"Not attached to an active page"}')
            if (page.historyEntries) return { currentIndex: page.historyIndex, entries: page.historyEntries }
            return {
              currentIndex: 0,
              entries: [{ id: 1, title: "Example", url: source.tabId === 24 ? createdURL : "https://example.test/form" }],
            }
          }
          if (method === "Page.getFrameTree" && source.sessionId)
            return { frameTree: { frame: { id: "child-frame", url: page.child?.url ?? "https://child.example.test/tempo" } } }
          if (method === "Page.getFrameTree")
            return {
              frameTree: {
                frame: { id: "main-frame", url: "https://example.test/form" },
                ...(page.sameOriginFrame ? { childFrames: [{ frame: { id: "same-frame", url: "https://example.test/inner" } }] } : {}),
              },
            }
          if (method === "DOM.getFrameOwner") return { backendNodeId: 999 }
          if (method === "Page.createIsolatedWorld") {
            if (params.worldName !== "ycoding-control") return { executionContextId: 1 }
            const executionContextId = 100 + contexts.size
            contexts.set(executionContextId, params.frameId === "same-frame" ? "same-frame" : (source.sessionId ?? "main"))
            return { executionContextId }
          }
          const controlId =
            params.backendNodeId ??
            (typeof params.objectId === "string" && params.objectId.startsWith("node-")
              ? Number(params.objectId.slice(5))
              : typeof params.nodeId === "number" && params.nodeId >= 1000
                ? params.nodeId - 1000
                : undefined)
          const control = page.controls?.[controlId]
          if (control?.detached && method.startsWith("DOM.")) throw new Error("No node with given id found")
          if (control?.detached && method.startsWith("Accessibility.")) throw new Error("No node with given id found")
          if (method === "Page.getLayoutMetrics" && source.sessionId)
            return { layoutViewport: { clientWidth: 400, clientHeight: 300 } }
          if (method === "Page.getLayoutMetrics")
            return { layoutViewport: { clientWidth: 100, clientHeight: 80 } }
          if (method === "Runtime.evaluate" && page.cursorEvaluationFails)
            throw new Error("isolated world unavailable")
          if (method === "Runtime.evaluate" && page.evaluationFailsFor === source.tabId)
            throw new Error("isolated world unavailable")
          if (method === "Runtime.evaluate" && page.staleContext > 0) {
            page.staleContext--
            throw new Error('{"code":-32000,"message":"Cannot find context with specified id"}')
          }
          if (method === "Runtime.evaluate" && page.cursorEvaluationHangs) return new Promise(() => {})
          if (method === "Runtime.evaluate" && params.expression.includes('"cursor":{')) {
            if (page.cursorPlacementFails) throw new Error("isolated world unavailable")
            if (page.cursorPlacementHangs) return new Promise(() => {})
          }
          if (method === "Input.dispatchMouseEvent" && page.inputHangs) return new Promise(() => {})
          if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") page.clickEffect?.(params)
          if (method === "Input.dispatchKeyEvent") {
            page.keyEffect?.(params)
            const focused = deepActive(page.documents.main)
            if (params.type === "keyDown" && params.text && focused) focused.value = `${focused.value}${params.text}`
          }
          if (method === "DOM.resolveNode") return { object: { objectId: `node-${params.backendNodeId}` } }
          if (method === "Runtime.callFunctionOn") {
            const element = params.objectId
              ? (page.controls?.[Number(params.objectId.slice(5))]?.element ?? { isConnected: true })
              : undefined
            const document = params.executionContextId ? page.documents[contexts.get(params.executionContextId)] : undefined
            if (!element && !document) return { result: { type: "undefined" } }
            const declared = runInNewContext(`(${params.functionDeclaration})`, { Event: FakeEvent, document })
            const value = declared.apply(element, (params.arguments ?? []).map((argument) => argument.value))
            if (params.returnByValue === false) {
              const id = Object.entries(page.controls ?? {}).find(([, item]) => item.element && item.element === value)?.[0]
              const documentKey = Object.entries(page.documents).find(([, item]) => item === value)?.[0]
              if (documentKey) return { result: { type: "object", objectId: `document-${documentKey}` } }
              return { result: id ? { type: "object", objectId: `node-${id}` } : { type: "object", subtype: "null", value: null } }
            }
            return {
              result: value === undefined ? { type: "undefined" } : { type: typeof value, value: JSON.parse(JSON.stringify(value)) },
            }
          }
          if (page.controls && method === "Input.insertText") {
            const element = Object.values(page.controls).find((item) => item.element?.focused)?.element
            if (element) {
              element.value = element.selectedAll ? params.text : `${element.value}${params.text}`
              element.selectedAll = false
            }
          }
          if (page.controls && method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Delete") {
            const element = Object.values(page.controls).find((item) => item.element?.focused)?.element
            if (element?.selectedAll) {
              element.value = ""
              element.selectedAll = false
            }
          }
          if (page.controls && method === "Accessibility.getFullAXTree")
            return {
              nodes: Object.entries(page.controls)
                .filter(([, item]) => item.session === source.sessionId && !item.detached)
                .filter(([, item]) => item.frame === (params.frameId === "same-frame" ? "same-frame" : undefined))
                .map(([id, item]) => axNode(Number(id), item)),
            }
          if (control && method === "Accessibility.getPartialAXTree") return { nodes: [axNode(controlId, control)] }
          if (method === "DOM.requestNode" && params.objectId === "document-same-frame") return { nodeId: 5000 }
          if (page.controls && method === "DOM.querySelectorAll")
            return {
              nodeIds: Object.entries(page.controls)
                .filter(([, item]) => item.session === source.sessionId && item.element?.localName === "input")
                .filter(([, item]) => item.frame === (params.nodeId === 5000 ? "same-frame" : undefined))
                .filter(([, item]) => ["date", "time", "datetime-local", "month", "week", "color", "range"].includes(item.element.type))
                .map(([id]) => 1000 + Number(id)),
            }
          if (control && method === "Accessibility.queryAXTree")
            return {
              nodes: (control.options ?? [])
                .map((id) => axNode(id, page.controls[id]))
                .filter((item) => !params.role || item.role.value === params.role),
            }
          if (control && method === "DOM.describeNode")
            return {
              node: {
                nodeType: 1,
                backendNodeId: controlId,
                nodeName: control.element?.nodeName ?? control.nodeName ?? "DIV",
                attributes: control.element?.attributeList() ?? control.attributes ?? [],
                ...(control.frameId ? { frameId: control.frameId } : {}),
                ...(control.shadowRoots ? { shadowRoots: control.shadowRoots } : {}),
              },
            }
          if (control && method === "DOM.getContentQuads") return { quads: control.quad ? [control.quad] : [] }
          if (method === "Runtime.evaluate" && params.expression.includes("navigator.clipboard.readText"))
            return { result: { value: page.clipboardText } }
          if (method === "Runtime.evaluate" && params.expression.includes("navigator.clipboard.writeText"))
            return { result: {} }
          if (method === "Runtime.evaluate") {
            if (page.holdMark && params.expression.includes('"op":"mark"') && !params.expression.includes('"cursor":{')) {
              const gate = page.holdMark
              page.holdMark = undefined
              await gate.promise
            }
            const value = await cursorDOM.evaluate(params.expression)
            return { result: { type: typeof value, value } }
          }
          if (method === "Accessibility.getFullAXTree" && page.axFails) throw new Error("Accessibility tree unavailable")
          if (method === "Accessibility.getFullAXTree" && page.axNavigates)
            await debuggerEvents.emit(source, "Page.frameNavigated", { frame: { url: page.axNavigates } })
          if (method === "Accessibility.getFullAXTree" && source.sessionId)
            return {
              nodes: [
                { ignored: false, role: { value: "button" }, name: { value: "Child button" }, backendDOMNodeId: 201 },
                { ignored: false, role: { value: "textbox" }, name: { value: "Child input" }, backendDOMNodeId: 202 },
                { ignored: false, role: { value: "StaticText" }, name: { value: "Tempo rows" }, backendDOMNodeId: 203 },
              ],
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
                ...(page.child
                  ? [
                      { ignored: false, role: { value: "heading" }, name: { value: "Shell heading" }, backendDOMNodeId: 92 },
                      { ignored: false, role: { value: "StaticText" }, name: { value: "Shell static" }, backendDOMNodeId: 93 },
                    ]
                  : []),
              ],
            }
          if (method === "DOM.describeNode" && source.sessionId)
            return {
              node:
                params.backendNodeId === 201
                  ? { nodeName: "BUTTON", attributes: [] }
                  : { nodeName: "INPUT", attributes: ["type", "text"] },
            }
          if (method === "DOM.describeNode")
            return {
              node: page.href
                ? { nodeName: "A", attributes: ["href", page.href] }
                : { nodeName: "INPUT", attributes: ["type", page.fileInput ? "file" : "text"] },
            }
          if (method === "DOM.getContentQuads" && params.backendNodeId === 999)
            return { quads: [[100, 50, 500, 50, 500, 350, 100, 350]] }
          if (method === "DOM.getContentQuads") return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }
          if (method === "Input.insertText" && page.typeRedirect)
            await debuggerEvents.emit({ tabId: 17 }, "Page.frameNavigated", { frame: { url: page.typeRedirect } })
          if (method === "Page.captureSnapshot") return { data: "MHTML-FIXTURE" }
          if (method === "DOM.getDocument" && source.sessionId) return { root: page.childDocumentRoot }
          if (method === "DOM.getDocument") return { root: page.documentRoot }
          if (method === "Page.captureScreenshot") return { data: "AAAA" }
          return {}
        },
      },
    },
    reset() {
      commands.length = 0
      attached.length = 0
      detached.length = 0
      created.length = 0
      removed.length = 0
      grouped.length = 0
      groupUpdates.length = 0
      ungrouped.length = 0
      badges.length = 0
      page.profileTabs = undefined
      page.active = true
      page.ownedActive = false
      page.historyUnavailable = 0
      page.holdCreate = undefined
      page.href = undefined
      page.typeRedirect = undefined
      page.cursorEvaluationFails = false
      page.cursorEvaluationHangs = false
      page.cursorPlacementFails = false
      page.cursorPlacementHangs = false
      page.focusEmulationFails = false
      page.axFails = false
      page.axNavigates = undefined
      page.holdMark = undefined
      attachedNow.clear()
      page.evaluationFailsFor = undefined
      page.staleContext = 0
      page.inputHangs = false
      page.documentRoot = node("#document")
      page.child = undefined
      page.childDocumentRoot = node("#document")
      page.historyEntries = undefined
      page.historyIndex = 0
      page.historyGranted = true
      page.downloadsGranted = true
      page.historyResults = undefined
      page.downloadItems = undefined
      page.clipboardText = "clipboard-fixture"
      page.fileInput = false
      page.controls = undefined
      page.clickEffect = undefined
      page.keyEffect = undefined
      page.sameOriginFrame = false
      page.documents = fakeDocuments()
      contexts.clear()
      cursorDOM.reset()
      timeline.length = 0
      FakeWebSocket.failConnections = false
      FakeWebSocket.instance = undefined
    },
  }
}

function FakeEvent(type, init = {}) {
  this.type = type
  this.bubbles = !!init.bubbles
  this.composed = !!init.composed
}

function deepActive(document) {
  let element = document?.activeElement
  for (;;) {
    if (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
    else if (element?.contentDocument?.activeElement) element = element.contentDocument.activeElement
    else return element
  }
}

function fakeDocuments() {
  return {
    main: { readyState: "complete", body: { innerText: "" } },
    "child-1": { readyState: "complete", body: { innerText: "" } },
    "same-frame": { readyState: "complete", body: { innerText: "" } },
  }
}

function axNode(id, item) {
  return {
    nodeId: `ax-${id}`,
    ignored: !!item.ignored,
    role: { value: item.role },
    name: { value: item.name ?? "" },
    backendDOMNodeId: id,
    properties: item.properties ?? [],
    ...(item.value === undefined ? {} : { value: { type: typeof item.value, value: item.value } }),
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
      get: async (name) => created.find((alarm) => alarm.name === name),
      clear: async (name) => {
        const index = created.findIndex((alarm) => alarm.name === name)
        if (index >= 0) created.splice(index, 1)
        return index >= 0
      },
    },
    async fire(name) {
      const index = created.findIndex((alarm) => alarm.name === name)
      if (index >= 0 && !created[index].periodInMinutes) created.splice(index, 1)
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
