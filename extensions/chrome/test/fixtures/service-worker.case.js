import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createFakePage } from "./fake-page.js"
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
      version: 4,
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
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: shared.tabID })
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
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: "btab_foreground" })
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
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: "btab_inactive" })
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
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: shared.tabID })
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
      expect(harness.commands.some((item) => item.method === "Runtime.enable")).toBe(false)
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

  test("hidden tabs click and scroll with page scripts because Chrome drops CDP input there", async () => {
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
      expect(socket.outgoing.find((item) => item.callID === "hidden-click")).toMatchObject({
        type: "result",
        status: "completed",
        input: "scripted",
      })
      expect(harness.page.scriptedClicks).toEqual(["node-91"])
      await socket.receive(action("hidden-scroll", shared.tabID, observation, { type: "scroll", deltaY: 120 }))
      expect(socket.outgoing.find((item) => item.callID === "hidden-scroll")).toMatchObject({
        type: "result",
        status: "completed",
        input: "scripted",
      })
      expect(harness.cursorDOM.scrolls).toEqual([[0, 120]])
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(false)

      harness.cursorDOM.setVisibility("visible")
      await socket.receive(action("visible-click", shared.tabID, observation, { type: "click", ref: "b1" }))
      expect(socket.outgoing.find((item) => item.callID === "visible-click")).toMatchObject({
        type: "result",
        input: "trusted",
      })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(true)
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 3000)

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
      expect(socket.outgoing).toContainEqual({ type: "revoked", tabID: shared.tabID })
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

  test("marks the tab title before observing and relinquish restores the page title before detaching", async () => {
    const { socket, shared } = await connect("m")
    try {
      const observation = await observe(socket, shared[0].tabID)
      expect(observation).toMatchObject({ type: "observation" })
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Inbox")
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

  test("reports the page's own title to YCoding by stripping only the installed marker", async () => {
    const tab = tabAt(17)
    Object.defineProperty(tab, "title", { get: () => harness.cursorDOM.document.title })
    const { socket, shared } = await connect("q", [tab])
    try {
      expect(shared[0].title).toBe("Inbox")
      expect(await observe(socket, shared[0].tabID)).toMatchObject({ title: "Inbox" })
      await socket.receive({ type: "relinquish", callID: "release-title", tabID: shared[0].tabID, generation: "bridge-1" })
      harness.cursorDOM.setPageTitle("[YCoding] real")
      expect(await observe(socket, shared[0].tabID, "observe-title-again")).toMatchObject({ title: "[YCoding] real" })
    } finally {
      await stopBridge()
    }
  })

  test("preserves dynamic page titles, including one that starts with the marker text", async () => {
    const { socket, shared } = await connect("d")
    try {
      await observe(socket, shared[0].tabID)
      harness.cursorDOM.setPageTitle("Inbox (3)")
      await flush()
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Inbox (3)")
      harness.cursorDOM.setPageTitle("[YCoding] My notes")
      await flush()
      expect(harness.cursorDOM.document.title).toBe("[YCoding] [YCoding] My notes")
      await socket.receive({ type: "relinquish", callID: "release-dynamic", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.document.title).toBe("[YCoding] My notes")
    } finally {
      await stopBridge()
    }
  })

  test("removes only a title element the marker created and keeps a page title it did not write", async () => {
    const { socket, shared } = await connect("t")
    try {
      harness.cursorDOM.removeTitle()
      await observe(socket, shared[0].tabID)
      expect(harness.cursorDOM.document.title).toBe("[YCoding]")
      await socket.receive({ type: "relinquish", callID: "release-created", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.document.querySelector("title")).toBeNull()

      await observe(socket, shared[0].tabID, "observe-written")
      harness.cursorDOM.setPageTitle("Changed by page")
      harness.cursorDOM.document.title = "Changed by page"
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
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Next")
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
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Inbox")
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

  test("restores the title when the page removes the marker and never stacks a second prefix", async () => {
    const { socket, shared } = await connect("e")
    try {
      await observe(socket, shared[0].tabID)
      harness.cursorDOM.markers()[0].remove()
      await flush()
      expect(harness.cursorDOM.document.title).toBe("Inbox")
      harness.cursorDOM.setPageTitle("Inbox (2)")
      await flush()
      expect(harness.cursorDOM.document.title).toBe("Inbox (2)")
      await observe(socket, shared[0].tabID, "observe-after-removal")
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Inbox (2)")
    } finally {
      await stopBridge()
    }
  })

  test("keeps a title the website itself starts with the marker text when the page removes the marker", async () => {
    const { socket, shared } = await connect("i")
    try {
      harness.cursorDOM.setPageTitle("[YCoding] real")
      await observe(socket, shared[0].tabID)
      expect(harness.cursorDOM.document.title).toBe("[YCoding] [YCoding] real")
      harness.cursorDOM.markers()[0].remove()
      await flush()
      expect(harness.cursorDOM.document.title).toBe("[YCoding] real")
      await observe(socket, shared[0].tabID, "observe-website-prefix")
      expect(harness.cursorDOM.document.title).toBe("[YCoding] [YCoding] real")
      await socket.receive({ type: "relinquish", callID: "release-website-prefix", tabID: shared[0].tabID, generation: "bridge-1" })
      expect(harness.cursorDOM.document.title).toBe("[YCoding] real")
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

  test("group and ungroup report the page's own title, not the marked one", async () => {
    const tabs = [tabAt(17), tabAt(18, { url: "https://example.test/second" })]
    for (const tab of tabs) Object.defineProperty(tab, "title", { get: () => harness.cursorDOM.document.title })
    const { socket, shared } = await connect("t", tabs)
    try {
      const anchor = shared.find((item) => item.url.endsWith("/form"))
      const second = shared.find((item) => item.url.endsWith("/second"))
      const observation = await observe(socket, anchor.tabID)
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Inbox")
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

  test("marks an owned tab before reporting it open and closes it when the marker cannot be shown", async () => {
    const { socket } = await connect("o")
    try {
      await socket.receive({ type: "open", callID: "open-marked", tabID: "btab_owned_marked", generation: "bridge-1", url: "https://example.test/owned" })
      await waitFor(() => socket.outgoing.some((message) => message.callID === "open-marked"))
      expect(socket.outgoing.find((message) => message.callID === "open-marked")).toMatchObject({ type: "opened" })
      expect(evaluations(24).length).toBeGreaterThan(0)
      expect(harness.cursorDOM.document.title).toBe("[YCoding] Inbox")
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
    axFails: false,
    axNavigates: undefined,
    holdMark: undefined,
    evaluationFailsFor: undefined,
    staleContext: 0,
    documentRoot: node("#document"),
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
              version: 4,
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
              version: 4,
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
          if (method === "Page.navigate" && source.tabId === 24) createdURL = params.url
          if (method === "Page.getNavigationHistory") {
            if (source.tabId === 24 && page.historyUnavailable-- > 0)
              throw new Error('{"code":-32000,"message":"Not attached to an active page"}')
            return {
              currentIndex: 0,
              entries: [{ title: "Example", url: source.tabId === 24 ? createdURL : "https://example.test/form" }],
            }
          }
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 }
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
          if (method === "DOM.resolveNode") return { object: { objectId: `node-${params.backendNodeId}` } }
          if (method === "Runtime.callFunctionOn") {
            if (params.functionDeclaration.includes("click()")) page.scriptedClicks.push(params.objectId)
            return { result: { type: "undefined" } }
          }
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
          if (method === "DOM.describeNode")
            return {
              node: page.href
                ? { nodeName: "A", attributes: ["href", page.href] }
                : { nodeName: "INPUT", attributes: ["type", "text"] },
            }
          if (method === "DOM.getContentQuads") return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }
          if (method === "Input.insertText" && page.typeRedirect)
            await debuggerEvents.emit({ tabId: 17 }, "Page.frameNavigated", { frame: { url: page.typeRedirect } })
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
      page.axFails = false
      page.axNavigates = undefined
      page.holdMark = undefined
      attachedNow.clear()
      page.evaluationFailsFor = undefined
      page.staleContext = 0
      page.inputHangs = false
      page.scriptedClicks = []
      page.documentRoot = node("#document")
      cursorDOM.reset()
      timeline.length = 0
      FakeWebSocket.failConnections = false
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
