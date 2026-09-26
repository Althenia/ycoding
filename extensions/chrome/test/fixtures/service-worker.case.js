import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

const harness = createHarness()
harness.storage.browserProfileGrant = { serverID: "server-restored-1" }
harness.storage.browserProfileDeniedTabs = { serverID: "server-restored-1", tabIDs: [18] }
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
  test("restores only authenticated backend connectivity and backs off without replaying tabs or actions", async () => {
    await waitFor(() => harness.FakeWebSocket.instances.length === 1)
    const restored = harness.FakeWebSocket.instances[0]
    expect(restored.outgoing).toContainEqual({
      type: "authenticate",
      version: 3,
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
      const animation = harness.commands.findIndex((item) => item.method === "Runtime.evaluate")
      const mouse = harness.commands.findIndex((item) => item.method === "Input.dispatchMouseEvent")
      expect(world).toBeGreaterThan(-1)
      expect(animation).toBeGreaterThan(world)
      expect(mouse).toBeGreaterThan(animation)
      expect(harness.commands.some((item) => item.method === "Runtime.enable")).toBe(false)
      expect(harness.commands[animation].params.expression).toContain("YCoding")
      expect(harness.commands[animation].params.expression).toContain("pointer-events:none")
      expect(harness.commands[animation].params.expression).toContain("attachShadow({mode:'closed'})")
      expect(harness.commands[animation].params.contextId).toBe(1)
      expect(harness.commands[animation].params.expression).toContain('"x":5,"y":5')
      expect(harness.commands[mouse].params).toMatchObject({ type: "mousePressed", x: 5, y: 5 })
      expect(harness.cursorDOM.hosts()).toHaveLength(1)
      expect(harness.cursorDOM.moves.at(-1)).toBe("translate(5px,5px)")

      harness.commands.length = 0
      await socket.receive(action("cursor-type", shared.tabID, observation, { type: "type", ref: "b1", text: "hello" }))
      const typingAnimation = harness.commands.findIndex((item) => item.method === "Runtime.evaluate")
      expect(typingAnimation).toBeGreaterThan(-1)
      expect(typingAnimation).toBeLessThan(harness.commands.findIndex((item) => item.method === "DOM.focus"))
      expect(typingAnimation).toBeLessThan(harness.commands.findIndex((item) => item.method === "Input.insertText"))
      expect(harness.commands[typingAnimation].params.expression).toContain('"x":5,"y":5')

      harness.commands.length = 0
      const movesBeforeScroll = harness.cursorDOM.moves.length
      await socket.receive(action("cursor-scroll", shared.tabID, observation, { type: "scroll", deltaY: 120 }))
      const scrollAnimation = harness.commands.findIndex((item) => item.method === "Runtime.evaluate")
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
    harness.page.cursorEvaluationHangs = true
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
      harness.page.cursorEvaluationHangs = false
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  }, 1500)

  test("cursor injection failure does not block input and detach cleanup is best effort", async () => {
    harness.reset()
    harness.page.profileTabs = [{ id: 17, active: true, url: "https://example.test/form", title: "Active" }]
    harness.page.cursorEvaluationFails = true
    try {
      await popup(harness.runtimeMessages, { type: "pair", serverURL: "http://127.0.0.1:4096", secret: "d".repeat(32) })
      const socket = harness.FakeWebSocket.instance
      const shared = socket.outgoing.find((message) => message.type === "shared")
      await socket.receive({ type: "observe", tabID: shared.tabID, generation: "bridge-1", callID: "observe-cursor-fail" })
      const observation = socket.outgoing.find((message) => message.callID === "observe-cursor-fail")
      await socket.receive(action("cursor-click-fail", shared.tabID, observation, { type: "click", ref: "b1" }))
      expect(socket.outgoing.find((item) => item.callID === "cursor-click-fail")).toMatchObject({ type: "result" })
      expect(harness.commands.some((item) => item.method === "Input.dispatchMouseEvent")).toBe(true)
      harness.page.cursorEvaluationFails = false
      harness.commands.length = 0
      await harness.debuggerDetach.emit({ tabId: 17 })
      expect(harness.commands.some((item) => item.method === "Runtime.evaluate" && item.params.expression.includes("remove"))).toBe(true)
    } finally {
      if (harness.FakeWebSocket.instance?.readyState === harness.FakeWebSocket.OPEN)
        await harness.FakeWebSocket.instance.receive({ type: "control", action: "stop" })
    }
  })

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
  const cursorDOM = createCursorDOM()
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
              version: 3,
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
              version: 3,
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
          attached.push(source)
        },
        detach: async (source) => {
          detached.push(source)
        },
        sendCommand: async (source, method, params = {}) => {
          commands.push({ source, method, params })
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
          if (method === "Runtime.evaluate" && page.cursorEvaluationHangs) return new Promise(() => {})
          if (method === "Input.dispatchMouseEvent" && page.inputHangs) return new Promise(() => {})
          if (method === "DOM.resolveNode") return { object: { objectId: `node-${params.backendNodeId}` } }
          if (method === "Runtime.callFunctionOn") {
            if (params.functionDeclaration.includes("click()")) page.scriptedClicks.push(params.objectId)
            return { result: { type: "undefined" } }
          }
          if (method === "Runtime.evaluate") {
            let frame = 0
            const value = await runInNewContext(params.expression, {
              scrollBy: (x, y) => cursorDOM.scrolls.push([x, y]),
              document: cursorDOM.document,
              innerWidth: 100,
              innerHeight: 80,
              performance: { now: () => 0 },
              requestAnimationFrame: (callback) => {
                cursorDOM.frameRequests++
                if (cursorDOM.document.visibilityState === "visible" && !cursorDOM.suppressFrames)
                  callback(frame++ === 0 ? 0 : 320)
                return cursorDOM.frameRequests
              },
              setTimeout,
              clearTimeout,
            })
            return { result: { type: typeof value, value } }
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
      page.inputHangs = false
      page.scriptedClicks = []
      page.documentRoot = node("#document")
      cursorDOM.reset()
      FakeWebSocket.failConnections = false
      FakeWebSocket.instance = undefined
    },
  }
}

function password() {
  return node("INPUT", { attributes: ["type", "password"] })
}

function createCursorDOM() {
  const hosts = []
  const moves = []
  const document = {
    visibilityState: "visible",
    documentElement: {
      append: (host) => hosts.push(host),
    },
    createElement: () => {
      const element = {
        dataset: {},
        style: { cssText: "" },
        remove() {
          const index = hosts.indexOf(element)
          if (index >= 0) hosts.splice(index, 1)
        },
        attachShadow: () => {
          const cursor = {
            style: {
              _transform: "",
              set transform(value) {
                this._transform = value
                moves.push(value)
              },
              get transform() {
                return this._transform
              },
            },
          }
          return {
            querySelector: () => cursor,
            append: () => {},
          }
        },
      }
      return element
    },
    querySelectorAll: () => hosts.filter((host) => host.dataset.ycodingAgentCursor !== undefined),
  }
  const scrolls = []
  return {
    document,
    moves,
    scrolls,
    frameRequests: 0,
    suppressFrames: false,
    hosts: () => hosts.filter((host) => host.dataset.ycodingAgentCursor !== undefined),
    setVisibility: (value) => (document.visibilityState = value),
    reset() {
      hosts.length = 0
      moves.length = 0
      scrolls.length = 0
      this.frameRequests = 0
      this.suppressFrames = false
      document.visibilityState = "visible"
    },
  }
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
