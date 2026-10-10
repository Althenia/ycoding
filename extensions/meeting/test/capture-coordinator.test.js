import { expect, test } from "bun:test"
import { createCoordinator } from "../companion/coordinator.js"

function fixture(saved = {}, { failStop = false } = {}) {
  const data = { ...saved }
  const calls = []
  const api = {
    runtime: {
      id: "a".repeat(32),
      getURL: (path) => `chrome-extension://${"a".repeat(32)}/${path}`,
      getContexts: async () => [],
    },
    storage: {
      session: {
        setAccessLevel: async () => {},
        get: async () => ({ ...data }),
        set: async (value) => Object.assign(data, value),
        remove: async (keys) => keys.forEach((key) => delete data[key]),
      },
    },
    action: {
      setBadgeText: async (value) => calls.push(["badge", value]),
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    tabs: {
      query: async () => [{ id: 7, url: "https://meet.google.com/abc-defg-hij" }],
      sendMessage: async (_, value) => calls.push(["content", value]),
    },
    scripting: {
      executeScript: async (value) => {
        calls.push(["inject", value.world])
        return []
      },
    },
    offscreen: {
      createDocument: async (value) => calls.push(["offscreen-create", value]),
      closeDocument: async () => calls.push(["offscreen-close"]),
    },
  }
  const fetches = []
  const coordinator = createCoordinator({
    chrome: api,
    fetch: async (url, options) => {
      fetches.push([url, JSON.parse(options.body)])
      return Response.json(url.endsWith("/pair") ? { token: "t".repeat(43) } : { ok: true }, {
        status: failStop ? 429 : 200,
      })
    },
    sendOffscreen: async (message) => {
      calls.push(["offscreen", message.type])
      if (message.type === "stop" && failStop) throw new Error("offscreen unavailable")
      return { ok: true }
    },
  })
  const popup = { id: api.runtime.id, url: api.runtime.getURL("popup.html") }
  return { coordinator, data, calls, api, fetches, popup }
}

test("coordinator authorizes only popup user-start, selects one Meet tab, and keeps capture credential in session storage", async () => {
  const f = fixture()
  await f.coordinator.initialize()
  await expect(
    f.coordinator.handle({ type: "start", consent: true, microphone: false }, { id: f.api.runtime.id, tab: { id: 7 } }),
  ).rejects.toThrow("untrusted_sender")
  await f.coordinator.handle(
    { type: "pair", url: "http://127.0.0.1:1234", code: "test-pairing-code-with-entropy" },
    f.popup,
  )
  expect(f.data.pair.token).toBe("t".repeat(43))
  expect(JSON.stringify(await f.coordinator.handle({ type: "status" }, f.popup))).not.toContain("t".repeat(43))
  await expect(f.coordinator.handle({ type: "start", consent: false, microphone: false }, f.popup)).rejects.toThrow(
    "consent_required",
  )
  f.api.tabCapture = {
    getMediaStreamId: async (options) => {
      f.calls.push(["stream", options])
      return "stream"
    },
  }
  await f.coordinator.handle({ type: "start", consent: true, microphone: false }, f.popup)
  expect(f.calls).toContainEqual(["stream", { targetTabId: 7 }])
  expect(f.data.capture.tabID).toBe(7)
  expect(f.calls).toContainEqual(["offscreen", "start"])
  await f.coordinator.tabRemoved(7)
  expect(f.calls).toContainEqual(["offscreen", "stop"])
  expect(f.calls).toContainEqual(["offscreen-close"])
  expect(f.data.capture).toBeUndefined()
})

test("restart tears down persisted capture without resuming; navigation, revocation and tab capture failure stop", async () => {
  const stale = fixture({
    pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) },
    capture: { captureID: "stale", tabID: 7 },
  })
  await stale.coordinator.initialize()
  expect(stale.calls).toContainEqual(["offscreen-close"])
  expect(stale.fetches[0][1]).toMatchObject({ type: "stop", captureID: "stale", reason: "service_restarted" })
  expect((await stale.coordinator.handle({ type: "status" }, stale.popup)).phase).toBe("error")
  expect(stale.calls.filter((call) => call[0] === "stream")).toHaveLength(0)
  for (const stop of [
    async (c) => c.tabUpdated(7, { status: "loading" }),
    async (c) => c.permissionsRemoved(),
    async (c) => c.captureChanged({ tabId: 7, status: "error" }),
  ]) {
    const f = fixture({ pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) } })
    f.api.tabCapture = { getMediaStreamId: async () => "stream" }
    await f.coordinator.initialize()
    await f.coordinator.handle({ type: "start", consent: true, microphone: false }, f.popup)
    await stop(f.coordinator)
    expect(f.data.capture).toBeUndefined()
    expect(f.calls).toContainEqual(["offscreen-close"])
  }
})

test("non-Meet tabs are refused, startup failure cleans offscreen and forged page stop cannot affect another tab", async () => {
  const f = fixture({ pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) } })
  await f.coordinator.initialize()
  f.api.tabs.query = async () => [{ id: 7, url: "https://example.com" }]
  await expect(f.coordinator.handle({ type: "start", consent: true, microphone: false }, f.popup)).rejects.toThrow(
    "select_meet_tab",
  )
  f.api.tabs.query = async () => [{ id: 7, url: "https://meet.google.com/abc-defg-hij" }]
  f.api.tabCapture = {
    getMediaStreamId: async () => {
      throw new Error("denied")
    },
  }
  await expect(f.coordinator.handle({ type: "start", consent: true, microphone: false }, f.popup)).rejects.toThrow(
    "capture_start_failed",
  )
  expect(f.calls).toContainEqual(["offscreen-close"])
  expect(f.data.capture).toBeUndefined()
  await expect(f.coordinator.handle({ type: "call-ended" }, { id: f.api.runtime.id, tab: { id: 8 } })).rejects.toThrow(
    "untrusted_sender",
  )
})

test("Stop cancels an in-progress selected-tab lookup before capture can start", async () => {
  const f = fixture({ pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) } })
  await f.coordinator.initialize()
  const selected = {}
  f.api.tabs.query = () =>
    new Promise((resolve) => {
      selected.resolve = resolve
    })
  const starting = f.coordinator
    .handle({ type: "start", consent: true, microphone: false }, f.popup)
    .catch((error) => error.message)
  await f.coordinator.handle({ type: "stop" }, f.popup)
  selected.resolve([{ id: 7, url: "https://meet.google.com/abc-defg-hij" }])
  expect(await starting).toBe("capture_cancelled")
  expect(f.data.capture).toBeUndefined()
  expect(f.calls.filter((call) => call[0] === "offscreen-create")).toEqual([])
})

test("uncertain offscreen and bridge Stop outcomes release local resources and remain visibly unacknowledged", async () => {
  const f = fixture({ pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) } }, { failStop: true })
  f.api.tabCapture = { getMediaStreamId: async () => "stream" }
  await f.coordinator.initialize()
  await f.coordinator.handle({ type: "start", consent: true, microphone: false }, f.popup)
  const result = await f.coordinator.handle({ type: "stop" }, f.popup)
  expect(result).toMatchObject({ phase: "error", reason: "stop_unacknowledged" })
  expect(f.data.capture).toBeUndefined()
  expect(f.calls).toContainEqual(["offscreen-close"])
})

test("Stop during offscreen document creation closes the late document before another capture may start", async () => {
  const f = fixture({ pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) } })
  await f.coordinator.initialize()
  const creation = {}
  let open = false
  const entered = new Promise((resolve) => {
    f.api.offscreen.createDocument = () => {
      resolve()
      return new Promise((done) => {
        creation.resolve = () => {
          open = true
          done()
        }
      })
    }
  })
  f.api.offscreen.closeDocument = async () => {
    open = false
  }
  const starting = f.coordinator
    .handle({ type: "start", consent: true, microphone: false }, f.popup)
    .catch((error) => error.message)
  await entered
  const stopping = f.coordinator.handle({ type: "stop" }, f.popup)
  await stopping
  creation.resolve()
  expect(await starting).toBe("capture_cancelled")
  expect(open).toBe(false)
  expect(f.data.capture).toBeUndefined()
  expect(f.calls.filter((call) => call[0] === "inject")).toEqual([])
})

test("a runtime-initiated stop while Start is settling cannot become capture_cancelled", async () => {
  const data = { pair: { url: "http://127.0.0.1:1234", token: "t".repeat(43) } }
  const f = fixture(data)
  f.api.tabCapture = { getMediaStreamId: async () => "stream" }
  const entered = Promise.withResolvers()
  const response = Promise.withResolvers()
  const setup = { ...f.api }
  const coordinator = createCoordinator({
    chrome: setup,
    fetch: async () => Response.json({}),
    sendOffscreen: async (message) => {
      if (message.type === "stop") return { ok: true }
      entered.resolve(message)
      return response.promise
    },
  })
  await coordinator.initialize()
  const starting = coordinator
    .handle({ type: "start", consent: true, microphone: false }, f.popup)
    .catch((error) => error.message)
  const message = await entered.promise
  await coordinator.handle(
    {
      type: "capture-state",
      epoch: message.epoch,
      state: { phase: "error", reason: "inference_failed", captureID: message.options.captureID },
    },
    { id: setup.runtime.id, url: setup.runtime.getURL("offscreen.html") },
  )
  await coordinator.stop("inference_failed")
  response.resolve({ ok: false, error: "inference_failed" })
  expect(await starting).toBe("inference_failed")
  expect(await coordinator.handle({ type: "status" }, f.popup)).toMatchObject({
    phase: "error",
    reason: "inference_failed",
  })
})
