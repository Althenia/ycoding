import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { createChromeController, storedLink } from "../controller.js"
import { createChromeKernel, scriptMethods } from "../kernel.js"
import { pageOperation, previewFrame } from "../page.js"

const page = { id: 1, windowId: 2, groupId: -1, index: 0, url: "https://example.test/form", title: "Form", active: true }
const ref = "ac0e287a-4b67-4c4f-88a2-8504a3f1c2de"
const selection = { tabId: 1, windowId: 2 }

function jpegFixture(width, height, size = 32) {
  const data = new Uint8Array(size)
  data.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3])
  data.set([0xff, 0xd9], size - 2)
  return Buffer.from(data).toString("base64")
}

async function rejectsWith(promise, code) {
  expect(await promise.catch((error) => error)).toMatchObject({ code })
}

function observationPage(rows) {
  const location = new URL(page.url)
  const clicked = []
  const document = { querySelector: () => null, querySelectorAll: (selector) => selector.startsWith("button,") ? buttons : [] }
  class HTMLButtonElement {
    isConnected = true
    tagName = "BUTTON"
    ownerDocument = document
    type = "button"
    constructor(row) { this.row = row }
    getAttribute(name) { return name === "aria-label" ? this.row.label : name === "role" ? this.row.role : null }
    closest() { return null }
    matches(selector) { return selector.startsWith("button,") }
    checkVisibility() { return true }
    getBoundingClientRect() { return { width: 1, height: 1 } }
    click() { clicked.push(this.row) }
  }
  const buttons = rows.map((row) => new HTMLButtonElement(row))
  let nextID = 0
  const operate = runInNewContext(`(${pageOperation.toString()})`, {
    location, document, window: { frames: [] }, HTMLElement: HTMLButtonElement, HTMLButtonElement, TextEncoder,
    HTMLInputElement: class { type = "text" },
    crypto: { getRandomValues(bytes) { bytes[15] = ++nextID; return bytes } },
  })
  return { clicked, operate: (input) => operate({ ...input, isolated: true, origin: location.origin, pathname: location.pathname }) }
}

test("shared Chrome observations fit UTF-8 wire frames and only published rows can be clicked", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ role: "button", label: `Open item ${index}` }))
  const normal = observationPage(rows).operate({ operation: "observe" }).elements
  expect(normal.map(({ role, label }) => ({ role, label }))).toEqual(rows)

  const wide = observationPage(rows.map(() => ({ role: "界".repeat(256), label: "例".repeat(256) })))
  const elements = wide.operate({ operation: "observe" }).elements
  const frame = { type: "result", id: ref, result: { elements, pathname: `/${"a".repeat(2047)}`, revision: Number.MAX_SAFE_INTEGER } }
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(262_144)
  expect(elements.length).toBeGreaterThan(0)
  expect(elements.length).toBeLessThan(rows.length)
  expect(elements.map((entry) => entry.id)).toEqual(normal.slice(0, elements.length).map((entry) => entry.id))
  expect(wide.operate({ operation: "click", elementID: normal[elements.length].id })).toEqual({ refusal: "stale" })
  expect(wide.clicked).toEqual([])
  expect(wide.operate({ operation: "click", elementID: elements[0].id })).toEqual({ applied: true })
  expect(wide.clicked).toHaveLength(1)
})

function fixture(overrides = {}) {
  const tabs = new Map([[1, { ...page }], [2, { ...page, id: 2, active: false }]])
  const effects = []
  const revoked = []
  let clock = 500
  const controller = createChromeController({
    list: async () => [...tabs.values()],
    tab: async (id) => tabs.get(id),
    attach: async (tab, scope, fence) => {
      fence()
      effects.push(["attach", tab.id, scope])
      return { tabId: tab.id, windowId: tab.windowId, document: "document-a", origin: "https://example.test" }
    },
    verify: async () => true,
    observe: async (target, fence) => {
      fence()
      return { pathname: "/form", elements: [{ id: ref, role: "button", label: "Next", editable: false }] }
    },
    perform: async (target, action, fence, dispatched) => {
      fence()
      dispatched()
      effects.push(["perform", target.tabId, action])
      return {}
    },
    preview: async () => ({ status: "withheld" }),
    detach: async (target) => { effects.push(["detach", target.tabId]) },
    ...overrides,
  }, { now: () => clock, revoked: (event) => revoked.push(event) })
  return { controller, tabs, effects, revoked, setTime: (time) => { clock = time } }
}

async function pending(f, sessionID = "session-a") {
  const request = { candidateID: crypto.randomUUID(), sessionID, purpose: "attach", expiresAt: 600 }
  f.controller.offer(request)
  const [target] = await f.controller.inventory(request)
  return { request: { ...request, targetID: target.id }, target }
}

async function lease(f) {
  const challenge = await pending(f)
  return f.controller.attach({ target: challenge.target, proof: f.controller.approve({ ...challenge.request, grouping: "move" }, selection) })
}

test("a matching local approval attaches once to the exact selected tab and cannot transfer to another Session", async () => {
  const f = fixture()
  const challenge = await pending(f)
  expect(f.effects).toEqual([])
  expect(challenge.target).toEqual({ kind: "chrome-tab", label: "Selected Chrome tab", origin: "https://example.test", pathname: "/form", id: challenge.target.id })
  const request = { ...challenge.request, grouping: "move" }
  expect(() => f.controller.approve(request, { tabId: 2, windowId: 2 })).toThrow("consent")
  expect(() => f.controller.approve({ ...request, sessionID: "session-b" }, selection)).toThrow("consent")
  const proof = f.controller.approve(request, selection)
  expect(f.effects).toEqual([])
  await rejectsWith(f.controller.attach({ target: challenge.target, proof: { ...proof, authorization: "forged" } }), "consent")
  const attached = await f.controller.attach({ target: challenge.target, proof })
  expect(attached).toMatchObject({ sessionID: "session-a", targetID: challenge.target.id, revision: 1 })
  await rejectsWith(f.controller.attach({ target: challenge.target, proof }), "consent")
  await rejectsWith(f.controller.observe({ ...attached, sessionID: "session-b" }), "ownership")
  expect(f.effects.map(([action, tabId]) => [action, tabId])).toEqual([["attach", 1]])
})

test("expired, replaced, pinned, restricted, and differently grouped targets cannot attach", async () => {
  for (const changed of [{ pinned: true }, { url: "chrome://settings" }, { groupId: 9 }, { windowId: 4 }]) {
    const f = fixture()
    const challenge = await pending(f)
    Object.assign(f.tabs.get(1), changed)
    const proof = f.controller.approve({ ...challenge.request, grouping: "move" }, selection)
    await rejectsWith(f.controller.attach({ target: challenge.target, proof }), "stale")
    expect(f.effects).toEqual([])
  }
  const f = fixture()
  const challenge = await pending(f)
  f.setTime(600)
  expect(() => f.controller.approve({ ...challenge.request, grouping: "move" }, selection)).toThrow("consent")
  expect(f.effects).toEqual([])
})

test("profile control asks separately to move the exact tab before allowing Chrome attachment", async () => {
  const f = fixture()
  const challenge = await pending(f)
  expect(f.controller.localState(selection).pending).toEqual([
    expect.objectContaining({ targetID: challenge.target.id, grouping: "move" }),
  ])
  expect(() => f.controller.approve(challenge.request, selection)).toThrow("consent")
  expect(() => f.controller.approve({ ...challenge.request, grouping: "already" }, selection)).toThrow("consent")
  expect(f.effects).toEqual([])
  const proof = f.controller.approve({ ...challenge.request, grouping: "move" }, selection)
  await f.controller.attach({ target: challenge.target, proof })
  expect(f.effects).toEqual([["attach", 1, { windowId: 2, grouping: "move", group: undefined, url: undefined }]])
})

test("a fresh observation is required for a ref and a repeated call never dispatches again", async () => {
  const f = fixture()
  const attached = await lease(f)
  const observed = await f.controller.observe(attached)
  expect(observed.pathname).toBe("/form")
  const call = { ...attached, revision: observed.revision, callID: crypto.randomUUID(), action: { platform: "chrome", type: "click", elementID: ref } }
  await rejectsWith(f.controller.perform({ ...call, action: { ...call.action, elementID: crypto.randomUUID() } }), "stale")
  expect(await f.controller.perform(call)).toMatchObject({ outcome: "applied" })
  await rejectsWith(f.controller.perform(call), "stale")
  expect(f.effects.filter(([action]) => action === "perform")).toHaveLength(1)
})

test("paired Chrome drops an observation from a different pathname and revokes its lease", async () => {
  const f = fixture({ observe: async () => ({ pathname: "/redirected", elements: [] }) })
  const attached = await lease(f)
  await rejectsWith(f.controller.observe(attached), "target_lost")
  await rejectsWith(f.controller.observe(attached), "ownership")
  expect(f.revoked).toHaveLength(1)
})

test("paired Chrome does not dispatch an old observation after navigation replaces its document", async () => {
  const f = fixture()
  const attached = await lease(f)
  const observed = await f.controller.observe(attached)
  const call = { ...attached, revision: observed.revision }
  const scroll = { platform: "chrome", type: "scroll", deltaY: 100 }
  expect(await f.controller.perform({ ...call, callID: crypto.randomUUID(),
    action: { platform: "chrome", type: "navigate", url: page.url } })).toMatchObject({ outcome: "applied" })
  await rejectsWith(f.controller.perform({ ...call, callID: crypto.randomUUID(), action: scroll }), "stale")
  expect(f.effects.filter(([action]) => action === "perform")).toHaveLength(1)
  const fresh = await f.controller.observe(call)
  expect(fresh.revision).toBeGreaterThan(observed.revision)
  expect(await f.controller.perform({ ...call, revision: fresh.revision, callID: crypto.randomUUID(), action: scroll })).toMatchObject({ outcome: "applied" })
})

test("Stop revokes admission before a blocked action can dispatch or a pending cleanup can finish", async () => {
  const check = Promise.withResolvers()
  const checking = Promise.withResolvers()
  const cleanup = Promise.withResolvers()
  const f = fixture({ verify: () => { checking.resolve(); return check.promise }, detach: () => cleanup.promise })
  const attached = await lease(f)
  const result = f.controller.perform({ ...attached, callID: crypto.randomUUID(), action: { platform: "chrome", type: "scroll", deltaY: 100 } })
  void result.catch(() => {})
  await checking.promise
  const stopped = f.controller.detach(attached)
  expect(f.revoked).toHaveLength(1)
  await rejectsWith(f.controller.observe(attached), "ownership")
  check.resolve(true)
  await rejectsWith(result, "stopped")
  expect(f.effects.some(([action]) => action === "perform")).toBe(false)
  cleanup.resolve()
  await stopped
})

test("missing visible mark fails the challenge without minting authority", async () => {
  const f = fixture({ attach: async () => { throw Object.assign(new Error("marker"), { code: "marker" }) } })
  const challenge = await pending(f)
  const proof = f.controller.approve({ ...challenge.request, grouping: "move" }, selection)
  await rejectsWith(f.controller.attach({ target: challenge.target, proof }), "marker")
  expect(f.revoked).toEqual([])
})

test("a withheld preview has no image and native cancellation revokes only its target", async () => {
  const f = fixture()
  const attached = await lease(f)
  expect(await f.controller.preview(attached)).toEqual({ status: "withheld" })
  f.controller.invalidate(2, "cancelled")
  expect(f.revoked).toEqual([])
  f.controller.invalidate(1, "cancelled")
  expect(f.revoked).toEqual([{ leaseID: attached.leaseID, epoch: attached.epoch, reason: "cancelled" }])
  await rejectsWith(f.controller.preview(attached), "ownership")
})

test("Stop after one dispatched action makes the result uncertain and never replays it", async () => {
  const dispatched = Promise.withResolvers()
  const settle = Promise.withResolvers()
  let count = 0
  const f = fixture({ perform: async (_target, _action, fence, started) => {
    fence()
    started()
    count++
    dispatched.resolve()
    return settle.promise
  } })
  const attached = await lease(f)
  const input = { ...attached, callID: crypto.randomUUID(), action: { platform: "chrome", type: "scroll", deltaY: 20 } }
  const action = f.controller.perform(input)
  await dispatched.promise
  await f.controller.detach(attached)
  settle.resolve({})
  expect(await action).toMatchObject({ outcome: "uncertain" })
  await rejectsWith(f.controller.perform(input), "ownership")
  expect(count).toBe(1)
})

test("owned Chrome creation stays inactive and groups only the new tab; Stop preserves a user-edited group", async () => {
  const existing = { ...page, groupId: 6, index: 0 }
  let newTab
  let group = { id: 7, windowId: 2, title: "", color: "grey", collapsed: false }
  let badge = ""
  let loaderId = "blank"
  let securityOrigin = "https://example.test"
  let captures = 0
  let viewportWidth = 961
  let screenshot = jpegFixture(961, 720)
  let childFrames
  let domRoot = { nodeType: 9, nodeName: "#document", childNodeCount: 1, children: [{ nodeType: 1, nodeName: "HTML", childNodeCount: 0 }] }
  let duringLayout
  let duringCapture
  const effects = []
  const methods = []
  const captured = { mimeType: "image/jpeg", base64: jpegFixture(960, 720), width: 960, height: 720 }
  const kernel = createChromeKernel({
    tabs: {
      create: async (params) => {
        effects.push(["create", params])
        newTab = { ...params, id: 2, groupId: -1, index: 1 }
        return { ...newTab }
      },
      group: async (params) => {
        effects.push(["group", params])
        newTab.groupId = 7
        return 7
      },
      get: async (id) => id === 2 ? { ...newTab } : { ...existing },
      query: async (filter) => [existing, newTab].filter((tab) => tab && (filter.windowId === undefined ? tab.groupId === filter.groupId : tab.windowId === filter.windowId)),
      remove: async (id) => { effects.push(["remove", id]) },
    },
    tabGroups: {
      get: async (id) => id === 6 ? { id, windowId: 2, title: "YCoding control", color: "green", collapsed: false } : { ...group },
      update: async (id, params) => { effects.push(["mark group", id, params]); group = { ...group, ...params } },
    },
    action: {
      getBadgeText: async () => badge,
      setBadgeText: async ({ text }) => { badge = text },
      setBadgeBackgroundColor: async () => {},
      setIcon: async () => {},
    },
    debugger: {
      attach: async ({ tabId }) => { effects.push(["debugger attach", tabId]) },
      detach: async ({ tabId }) => { effects.push(["debugger detach", tabId]) },
      sendCommand: async ({ tabId }, method, params) => {
        expect(tabId).toBe(2)
        methods.push(method)
        if (method === "Page.navigate") {
          loaderId = "owned-document"
          newTab.url = params.url
          kernel.nativeEvent({ tabId: tabId }, "Page.lifecycleEvent", { name: "DOMContentLoaded", loaderId })
          return { loaderId }
        }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top", loaderId, url: newTab.url, securityOrigin }, childFrames } }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 }
        if (method === "DOM.getDocument") return { root: domRoot }
        if (method === "Page.getLayoutMetrics") {
          duringLayout?.()
          return { cssVisualViewport: { clientWidth: viewportWidth, clientHeight: 720, pageX: 0, pageY: 0 } }
        }
        if (method === "Page.captureScreenshot") { captures++; duringCapture?.(); return { data: screenshot } }
        if (method === "Runtime.callFunctionOn" && params.arguments[0].value.operation === "observe") return { result: { value: { elements: [] } } }
        if (method === "Runtime.callFunctionOn" && params.arguments[0].value.operation === "preview")
          return { result: { value: { safe: true, ticket: "preview-fixture" } } }
        if (method === "Runtime.callFunctionOn" && params.arguments[0].value.operation === "sensitiveBoxes")
          return { result: { value: { boxes: [], width: 960, height: 720 } } }
        if (method === "Runtime.callFunctionOn") return { result: { value: { marked: true, available: true, cleared: true } } }
        return {}
      },
    },
  }, { compose: async () => captured })
  await rejectsWith(kernel.snapshot(existing, () => {}), "permission")
  const owner = await kernel.attach(undefined, { windowId: 2, url: "https://example.test/form?q=synthetic#details", grouping: "create" }, () => {})
  expect(effects).toEqual([
    ["create", { active: false, windowId: 2, url: "about:blank" }],
    ["group", { tabIds: [2], createProperties: { windowId: 2 } }],
    ["mark group", 7, { title: "YCoding control", color: "green", collapsed: false }],
    ["debugger attach", 2],
  ])
  expect(badge).toBe("ON")
  expect(await kernel.observe(owner, () => {})).toEqual({ pathname: "/form", elements: [] })
  securityOrigin = "null"
  await rejectsWith(kernel.observe(owner, () => {}), "target_lost")
  securityOrigin = "https://example.test"
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(0)
  viewportWidth = 960
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(1)
  screenshot = jpegFixture(960, 720)
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "ready", frame: { mimeType: "image/jpeg", base64: screenshot, width: 960, height: 720 } })
  expect(captures).toBe(2)
  duringLayout = () => { badge = "" }
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(2)
  badge = "ON"
  duringLayout = undefined
  childFrames = { unknown: true }
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(2)
  childFrames = undefined
  const complete = domRoot
  domRoot = { nodeType: 9, nodeName: "#document", childNodeCount: 1, children: [{}] }
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(2)
  domRoot = complete
  duringCapture = () => kernel.nativeEvent({ tabId: 2 }, "Page.frameAttached", { frameId: "child", parentFrameId: "top" })
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(3)
  duringCapture = () => kernel.nativeEvent({ tabId: 2 }, "Page.javascriptDialogOpening", { type: "prompt" })
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(4)
  expect(await kernel.snapshot(newTab, () => {})).toEqual({ id: 7 })
  expect(await kernel.perform(owner, { type: "navigate", url: "https://example.test/admin" }, () => {}, () => {
    throw new Error("Dispatched an unapproved destination")
  })).toEqual({ refusal: "policy" })
  newTab.url = "https://example.test/admin"
  expect(await kernel.verify(owner, () => {})).toBe(false)
  newTab.url = "https://example.test/form"
  expect(await kernel.verify(owner, () => {})).toBe(true)
  kernel.nativeEvent({ tabId: 2 }, "Page.javascriptDialogClosed", {})
  expect((await kernel.capture(owner, () => {})).frame).toEqual(captured)
  kernel.nativeEvent({ tabId: 2 }, "Page.navigatedWithinDocument", { frameId: "top", url: "https://example.test/form?q=changed" })
  expect(await kernel.verify(owner, () => {})).toBe(false)
  group.title = "User keeps this group"
  expect(await kernel.verify(owner, () => {})).toBe(false)
  await kernel.detach(owner, "stopped")
  expect(effects.at(-1)).toEqual(["debugger detach", 2])
  expect(methods).toContain("Page.captureScreenshot")
  expect(methods.filter((method) => method.startsWith("Target."))).toEqual([])
  expect(existing.groupId).toBe(6)
  expect(group.title).toBe("User keeps this group")
  expect(badge).toBe("")
})

test("preview uses decoded bytes and encoded image geometry, not base64 length alone", () => {
  const exact = jpegFixture(960, 720, 163_840)
  const oneOver = jpegFixture(960, 720, 163_841)
  expect(exact.length).toBe(oneOver.length)
  expect(previewFrame("image/jpeg", exact)).toMatchObject({ width: 960, height: 720 })
  expect(previewFrame("image/jpeg", oneOver)).toBeUndefined()
  expect(previewFrame("image/jpeg", jpegFixture(960, 721))).toBeUndefined()
  expect(previewFrame("image/png", jpegFixture(960, 720))).toBeUndefined()
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2X8AAAAASUVORK5CYII="
  expect(previewFrame("image/png", png)).toMatchObject({ width: 1, height: 1 })
})

function profileKernel(url = page.url) {
  const tab = { ...page, url }
  const peer = { ...page, id: 2, active: false, groupId: 11, index: 1 }
  let group = { id: 7, windowId: 2, title: "", color: "grey", collapsed: false }
  let badge = ""
  let loaderID = "document"
  const effects = []
  const commands = []
  const navigations = []
  const kernel = createChromeKernel({
    tabs: {
      get: async () => ({ ...tab }),
      query: async (filter) => filter.groupId === undefined ? [tab, peer] : [tab, peer].filter((entry) => entry.groupId === filter.groupId),
      group: async (options) => {
        effects.push(["group", options])
        tab.groupId = 7
        return 7
      },
      ungroup: async (id) => { effects.push(["ungroup", id]); tab.groupId = -1 },
    },
    tabGroups: {
      get: async () => ({ ...group }),
      update: async (id, state) => { effects.push(["mark", id]); group = { ...group, ...state } },
    },
    debugger: {
      attach: async ({ tabId }) => { effects.push(["attach", tabId]) },
      detach: async ({ tabId }) => { effects.push(["detach", tabId]) },
      sendCommand: async ({ tabId }, method, params) => {
        expect(tabId).toBe(1)
        commands.push(method)
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top", loaderId: loaderID, url: tab.url, securityOrigin: "https://example.test" } } }
        if (method === "Page.navigate") {
          navigations.push(params.url)
          loaderID = `document-${navigations.length}`
          tab.url = params.url
          kernel.nativeEvent({ tabId: tabId }, "Page.lifecycleEvent", { name: "DOMContentLoaded", loaderId: loaderID })
          return { loaderId: loaderID }
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 }
        if (method === "Runtime.callFunctionOn" && params.arguments[0].value.operation === "observe")
          return { result: { value: { elements: [] } } }
        return { result: { value: { marked: true, available: true, cleared: true } } }
      },
    },
    action: {
      getBadgeText: async () => badge,
      setBadgeText: async ({ text }) => { badge = text },
      setBadgeBackgroundColor: async () => {},
      setIcon: async () => {},
    },
  })
  return { kernel, tab, peer, effects, commands, navigations, badge: () => badge }
}

test("approved profile grouping touches one tab and restores its unchanged singleton on Stop", async () => {
  const { kernel, tab, peer, effects, badge } = profileKernel()
  await rejectsWith(kernel.attach({ ...tab }, { windowId: 2, grouping: "already" }, () => {}), "stale")
  expect(effects).toEqual([])
  const authorized = await kernel.attach({ ...tab }, { windowId: 2, grouping: "move" }, () => {})
  expect(tab).toMatchObject({ active: true, groupId: 7 })
  expect(peer).toMatchObject({ active: false, groupId: 11, index: 1 })
  expect(badge()).toBe("ON")
  await kernel.detach(authorized, "stopped")
  expect(effects).toEqual([
    ["group", { tabIds: [1], createProperties: { windowId: 2 } }], ["mark", 7], ["attach", 1], ["detach", 1], ["ungroup", 1],
  ])
  expect(tab).toMatchObject({ active: true, groupId: -1 })
  expect(peer).toMatchObject({ active: false, groupId: 11, index: 1 })
  expect(badge()).toBe("")
})

const approvedProfileURL = "https://example.test/form?scope=one#start"

test.each([
  ["query", "https://example.test/form?scope=two#start"],
  ["fragment", "https://example.test/form?scope=one#other"],
  ["pathname", "https://example.test/other?scope=one#start"],
])("paired profile rejects an unapproved %s without dispatching a browser command", async (_part, url) => {
  const { kernel, tab, commands } = profileKernel(approvedProfileURL)
  const target = await kernel.attach({ ...tab }, { windowId: 2, grouping: "move" }, () => {})
  try {
    const count = commands.length
    let dispatched = false
    expect(await kernel.perform(target, { platform: "chrome", type: "navigate", url }, () => {}, () => { dispatched = true }))
      .toEqual({ refusal: "policy" })
    expect(dispatched).toBe(false)
    expect(commands).toHaveLength(count)
  } finally {
    await kernel.detach(target, "stopped")
  }
})

test("paired profile reloads only its exact approved URL and invalidates the previous observation", async () => {
  const f = profileKernel(approvedProfileURL)
  const controller = createChromeController(f.kernel, { now: () => 500, revoked: () => {} })
  const challenge = await pending({ controller })
  expect(challenge.target).not.toHaveProperty("url")
  const attached = await controller.attach({ target: challenge.target,
    proof: controller.approve({ ...challenge.request, grouping: "move" }, selection) })
  try {
    const observed = await controller.observe(attached)
    expect(observed).toEqual({ revision: 2, pathname: "/form", elements: [] })
    const call = { ...attached, revision: observed.revision }
    const navigate = () => controller.perform({ ...call, callID: crypto.randomUUID(),
      action: { platform: "chrome", type: "navigate", url: approvedProfileURL } })
    expect(await navigate()).toMatchObject({ outcome: "applied" })
    expect(f.navigations).toEqual([approvedProfileURL])
    await rejectsWith(navigate(), "stale")
    expect(f.navigations).toEqual([approvedProfileURL])
    expect(await controller.observe(call)).toEqual({ revision: 3, pathname: "/form", elements: [] })
  } finally {
    await controller.detach(attached)
  }
})

function windowKernel(options = {}) {
  const tabs = new Map([
    [1, { ...page, id: 1, index: 0, active: true }],
    [2, { ...page, id: 2, index: 1, active: false, url: "https://example.test/form" }],
    [3, { ...page, id: 3, index: 2, active: false, groupId: 11 }],
  ])
  const groups = new Map([[11, { id: 11, windowId: 2, title: "Mine", color: "blue", collapsed: false }]])
  const effects = []
  const commands = []
  const icons = new Map()
  const kernel = createChromeKernel({
    windows: { update: async (...args) => { effects.push(["windows.update", ...args]) } },
    tabs: {
      update: async (...args) => { effects.push(["tabs.update", ...args]) },
      highlight: async (...args) => { effects.push(["tabs.highlight", ...args]) },
      get: async (id) => ({ ...tabs.get(id) }),
      query: async (filter) => [...tabs.values()].filter((tab) => filter.groupId !== undefined ? tab.groupId === filter.groupId :
        filter.windowId === undefined || tab.windowId === filter.windowId),
      group: async (options) => {
        effects.push(["group", options])
        const id = options.groupId ?? 7
        if (!groups.has(id)) groups.set(id, { id, windowId: 2, title: "", color: "grey", collapsed: false })
        for (const tabId of options.tabIds) tabs.get(tabId).groupId = id
        return id
      },
      ungroup: async (id) => {
        effects.push(["ungroup", id])
        if (options.ungroupFails) throw new Error("Tabs cannot be edited right now")
        const group = tabs.get(id).groupId
        tabs.get(id).groupId = -1
        if (![...tabs.values()].some((tab) => tab.groupId === group)) groups.delete(group)
      },
      remove: async (id) => { effects.push(["remove", id]) },
    },
    tabGroups: {
      get: async (id) => {
        if (!groups.has(id)) throw new Error("No group")
        return { ...groups.get(id) }
      },
      update: async (id, state) => { effects.push(["name group", id]); groups.set(id, { ...groups.get(id), ...state }) },
    },
    debugger: {
      attach: async () => {},
      detach: async () => { commands.push("debugger.detach") },
      sendCommand: async ({ tabId }, method, params) => {
        commands.push(method === "Runtime.callFunctionOn" ? `${method}:${params.arguments?.[0]?.value?.operation}` : method)
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `top-${tabId}`, loaderId: "document", url: tabs.get(tabId).url, securityOrigin: "https://example.test" } } }
        if (method === "Page.createIsolatedWorld") return { executionContextId: tabId }
        if (method === "Runtime.callFunctionOn" && params.arguments[0].value.operation === "click") {
          effects.push(["click", tabId])
          if (options.clickOpens === "dialog") kernel.nativeEvent({ tabId: tabId }, "Page.javascriptDialogOpening", { type: "alert" })
          else kernel.nativeEvent({ tabId: tabId }, "Page.fileChooserOpened", { mode: "selectSingle" })
          return new Promise(() => {})
        }
        return { result: { value: { marked: true, available: true, cleared: true } } }
      },
    },
    action: {
      getBadgeText: async () => "ON",
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setIcon: async ({ tabId, path }) => { icons.set(tabId, path[16]) },
    },
  }, options.kernel)
  return { kernel, tabs, groups, effects, commands, icons }
}

test("controlled tabs share one adapter-owned group per window that is ungrouped, never closed, after the last Stop", async () => {
  const { kernel, tabs, groups, effects, icons } = windowKernel()
  await rejectsWith(kernel.snapshot(tabs.get(3), () => {}), "permission")
  const first = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  const second = await kernel.attach({ ...tabs.get(2) }, { windowId: 2, grouping: "move" }, () => {})
  expect(effects).toEqual([
    ["group", { tabIds: [1], createProperties: { windowId: 2 } }], ["name group", 7],
    ["group", { groupId: 7, tabIds: [2] }],
  ])
  expect(groups.get(7)).toMatchObject({ title: "YCoding control", color: "green", collapsed: false })
  expect(await kernel.snapshot(tabs.get(2), () => {})).toEqual({ id: 7 })
  expect([...icons]).toEqual([[1, "icons/active-16.png"], [2, "icons/active-16.png"]])
  await kernel.detach(first, "stopped")
  expect(tabs.get(1).groupId).toBe(-1)
  expect(tabs.get(2).groupId).toBe(7)
  expect(await kernel.verify(second, () => {})).toBe(true)
  await kernel.detach(second, "stopped")
  expect(groups.has(7)).toBe(false)
  expect(groups.get(11)).toMatchObject({ title: "Mine" })
  expect(tabs.get(3).groupId).toBe(11)
  expect(effects.filter(([kind]) => kind === "remove")).toEqual([])
  expect([...icons]).toEqual([[1, "icons/idle-16.png"], [2, "icons/idle-16.png"]])
  const third = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  expect(effects.at(-2)).toEqual(["group", { tabIds: [1], createProperties: { windowId: 2 } }])
  await kernel.detach(third, "stopped")
})

test("a Chrome refusal to ungroup reports failed cleanup and keeps the control group in use", async () => {
  const { kernel, tabs, effects } = windowKernel({ ungroupFails: true })
  const first = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  await rejectsWith(kernel.detach(first, "stopped"), "cleanup")
  expect(tabs.get(1).groupId).toBe(7)
  const second = await kernel.attach({ ...tabs.get(2) }, { windowId: 2, grouping: "move" }, () => {})
  expect(effects.filter(([kind]) => kind === "group").at(-1)).toEqual(["group", { groupId: 7, tabIds: [2] }])
  await rejectsWith(kernel.detach(second, "stopped"), "cleanup")
})

test("a Stop from the popup settles the service's following detach with the same cleanup outcome", async () => {
  const failed = fixture({ detach: async () => { throw Object.assign(new Error("cleanup"), { code: "cleanup" }) } })
  const failing = await lease(failed)
  const local = failed.controller.detach(failing)
  await rejectsWith(failed.controller.detach(failing), "cleanup")
  await rejectsWith(local, "cleanup")
  expect(failed.revoked).toHaveLength(1)
  const f = fixture()
  const attached = await lease(f)
  await f.controller.detach(attached)
  expect(await f.controller.detach(attached)).toBeUndefined()
  await rejectsWith(f.controller.detach({ ...attached, epoch: attached.epoch + 1 }), "ownership")
  await rejectsWith(f.controller.detach({ ...attached, sessionID: "session-b" }), "ownership")
  expect(f.effects.filter(([kind]) => kind === "detach")).toEqual([["detach", 1]])
})

test("a page file chooser during an action pauses instead of waiting or taking focus", async () => {
  const { kernel, tabs } = windowKernel()
  const target = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  const pauses = []
  target.onPause = (reason) => pauses.push(reason)
  expect(await kernel.perform(target, { platform: "chrome", type: "click", elementID: ref }, () => {}, () => {})).toEqual({ paused: "file_chooser" })
  expect(pauses).toEqual(["file_chooser"])
  kernel.nativeEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "alert" })
  expect(pauses).toEqual(["file_chooser", "dialog"])
  await rejectsWith(kernel.resume(target, () => {}), "busy")
  kernel.nativeEvent({ tabId: 1 }, "Page.javascriptDialogClosed", {})
  await kernel.resume(target, () => {})
  await kernel.detach(target, "stopped")
})

test.each(["file_chooser", "dialog"])("an action that needs the user's focus for a %s pauses on its first attempt with no retry or focus command", async (reason) => {
  const { kernel, tabs, effects, commands } = windowKernel({ clickOpens: reason })
  const target = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  const pauses = []
  target.onPause = (pause) => pauses.push(pause)
  const before = commands.length
  const dispatched = []
  expect(await kernel.perform(target, { platform: "chrome", type: "click", elementID: ref }, () => {}, () => dispatched.push(true))).toEqual({ paused: reason })
  const during = commands.slice(before)
  expect(dispatched).toEqual([true])
  expect(pauses).toEqual([reason])
  expect(during.filter((method) => method === "Runtime.callFunctionOn:click")).toHaveLength(1)
  expect(during.filter((method) => /^(?:Emulation|Input)\.|bringToFront|activateTarget/.test(method))).toEqual([])
  expect(effects.filter(([kind]) => ["tabs.update", "windows.update", "tabs.highlight"].includes(kind))).toEqual([])
  expect(effects.filter(([kind]) => kind === "click")).toEqual([["click", 1]])
  if (reason === "dialog") kernel.nativeEvent({ tabId: 1 }, "Page.javascriptDialogClosed", {})
  await kernel.detach(target, "stopped")
  expect(commands.some((method) => method.startsWith("Emulation."))).toBe(false)
})

test("a paused lease refuses actions until resumed, and Stop still works while paused", async () => {
  const events = []
  let dispatches = 0
  const controller = createChromeController({
    list: async () => [{ ...page }], tab: async () => ({ ...page }),
    attach: async (tab) => ({ tabId: tab.id, windowId: tab.windowId }), verify: async () => true,
    observe: async () => ({ pathname: "/form", elements: [{ id: ref, role: "button", label: "Next", editable: false }] }),
    perform: async (_target, _action, fence, dispatched) => { fence(); dispatched(); dispatches++; return { paused: "dialog" } },
    preview: async () => ({ status: "withheld" }), resume: async () => {}, detach: async () => {},
    capture: async () => ({ frame: { mimeType: "image/png", base64: "x", width: 1, height: 1 },
      title: "Reset for alice@example.test", url: "https://user:pw@example.test/reset?token=abc123&step=2#private" }),
  }, { now: () => 500, revoked: (event) => events.push(["revoked", event.reason]),
    paused: (event) => events.push(["paused", event.reason]), resumed: () => events.push(["resumed"]) })
  const challenge = await pending({ controller })
  const attached = await controller.attach({ target: challenge.target, proof: controller.approve({ ...challenge.request, grouping: "move" }, selection) })
  const observed = await controller.observe(attached)
  const call = { ...attached, revision: observed.revision, action: { platform: "chrome", type: "click", elementID: ref } }
  expect(await controller.perform({ ...call, callID: crypto.randomUUID() })).toEqual({ outcome: "paused", reason: "dialog", revision: observed.revision })
  expect(await controller.perform({ ...call, callID: crypto.randomUUID() })).toEqual({ outcome: "paused", reason: "dialog", revision: observed.revision })
  await rejectsWith(controller.observe(call), "paused")
  expect(dispatches).toBe(1)
  expect(controller.lease(attached.leaseID)).toMatchObject({ paused: "dialog" })
  expect(await controller.capture(attached)).toEqual({ frame: { mimeType: "image/png", base64: "x", width: 1, height: 1 },
    title: "Reset for [redacted]", url: "https://example.test/reset?token=[redacted]&step=2" })
  expect(await controller.resume(attached, true)).toBe(true)
  await rejectsWith(controller.perform({ ...call, callID: crypto.randomUUID() }), "stale")
  expect(controller.takeover(attached)).toBe(true)
  await controller.detach(attached)
  expect(events).toEqual([["paused", "dialog"], ["resumed"], ["paused", "user_takeover"], ["revoked", "stopped"]])
  await rejectsWith(controller.resume(attached), "ownership")
})

test("a script run needs the current revision, consumes it, and Stop or cancelRun aborts only that lease's run", async () => {
  const runs = []
  const f = fixture({ run: (target, request, fence) => {
    fence()
    const settled = Promise.withResolvers()
    runs.push({ target, request, settled })
    request.signal.addEventListener("abort", () => settled.resolve({ result: { outcome: "stopped", logs: [] }, verified: true }))
    return settled.promise
  } })
  const attached = await lease(f)
  const runID = crypto.randomUUID()
  const script = { mode: "code", source: "1 + 1", timeoutMs: 1000 }
  await rejectsWith(f.controller.run({ ...attached, ...script, runID, revision: 2 }), "stale")
  await rejectsWith(f.controller.run({ ...attached, mode: "eval", source: "1", timeoutMs: 1000, runID, revision: 1 }), "invalid")
  await rejectsWith(f.controller.run({ ...attached, ...script, timeoutMs: 60_001, runID, revision: 1 }), "invalid")
  const first = f.controller.run({ ...attached, ...script, runID, revision: 1 })
  await Bun.sleep(0)
  expect(runs.map(({ target, request }) => [target.tabId, request.leaseID, request.mode, request.source, request.timeoutMs]))
    .toEqual([[1, attached.leaseID, "code", "1 + 1", 1000]])
  await rejectsWith(f.controller.run({ ...attached, ...script, runID: crypto.randomUUID(), revision: 1 }), "busy")
  expect(f.controller.cancelRun({ ...attached, runID: crypto.randomUUID() })).toBe(false)
  expect(f.controller.cancelRun({ ...attached, runID })).toBe(true)
  expect(await first).toEqual({ outcome: "stopped", logs: [] })
  await rejectsWith(f.controller.run({ ...attached, ...script, runID: crypto.randomUUID(), revision: 1 }), "stale")
  await rejectsWith(f.controller.perform({ ...attached, callID: crypto.randomUUID(), action: { platform: "chrome", type: "scroll", deltaY: 10 } }), "stale")
  const observed = await f.controller.observe(attached)
  const second = f.controller.run({ ...attached, ...script, runID: crypto.randomUUID(), revision: observed.revision })
  await Bun.sleep(0)
  await f.controller.detach(attached)
  expect(runs[1].request.signal.aborted).toBe(true)
  expect(await second).toEqual({ outcome: "stopped", logs: [] })
  expect(f.revoked).toEqual([{ leaseID: attached.leaseID, epoch: attached.epoch, reason: "stopped" }])
})

test("a run that leaves the approved page returns its result and revokes the lease; a paused lease never dispatches", async () => {
  let verified = false
  let dispatched = 0
  const f = fixture({ run: async () => {
    dispatched++
    return { result: { outcome: "completed", value: 2, logs: [] }, verified }
  } })
  const attached = await lease(f)
  expect(await f.controller.run({ ...attached, mode: "script", source: "return 2", timeoutMs: 1000, runID: crypto.randomUUID(), revision: 1 }))
    .toEqual({ outcome: "completed", value: 2, logs: [] })
  expect(f.revoked).toEqual([{ leaseID: attached.leaseID, epoch: attached.epoch, reason: "target_lost" }])
  expect(f.controller.lease(attached.leaseID)).toBeUndefined()
  verified = true
  const paused = await lease(f)
  f.controller.takeover(paused)
  expect(await f.controller.run({ ...paused, mode: "script", source: "return 2", timeoutMs: 1000, runID: crypto.randomUUID(), revision: 1 }))
    .toEqual({ outcome: "paused", reason: "user_takeover" })
  expect(dispatched).toBe(1)
  await f.controller.detach(paused)
})

test("the kernel runs a script only through the granted tab's debugger session and reports a page dialog pause once", async () => {
  const seen = []
  const gate = Promise.withResolvers()
  const { kernel, tabs } = windowKernel({ kernel: { runScript: async (input, cdp, worlds) => {
    seen.push(["input", input.tabId, input.leaseID, input.mode, input.source, input.timeoutMs, worlds instanceof Map])
    await rejectsWith(cdp.send(2, "Runtime.evaluate", { expression: "1" }), "ownership")
    seen.push(["frame", (await cdp.send(1, "Page.getFrameTree")).frameTree.frame.id])
    const unsubscribe = cdp.onEvent(1, (method) => seen.push(["event", method]))
    cdp.onEvent(2, (method) => seen.push(["other", method]))
    input.signal.addEventListener("abort", () => seen.push(["aborted"]))
    await gate.promise
    unsubscribe()
    return { outcome: "completed", value: 1, logs: [] }
  } } })
  const target = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  const pauses = []
  target.onPause = (reason) => pauses.push(reason)
  const signal = new AbortController().signal
  const request = { leaseID: "lease-1", mode: "code", source: "1", timeoutMs: 500, signal }
  const completed = kernel.run(target, request, () => {})
  while (seen.length < 2) await Bun.sleep(1)
  kernel.nativeEvent({ tabId: 1 }, "Runtime.consoleAPICalled", { executionContextId: 1 })
  kernel.nativeEvent({ tabId: 2 }, "Runtime.consoleAPICalled", { executionContextId: 2 })
  gate.resolve()
  expect(await completed).toEqual({ result: { outcome: "completed", value: 1, logs: [] }, verified: true })
  expect(seen).toEqual([["input", 1, "lease-1", "code", "1", 500, true], ["frame", "top-1"], ["event", "Runtime.consoleAPICalled"]])
  tabs.get(1).url = "https://example.test/elsewhere"
  gate.resolve()
  expect(await kernel.run(target, request, () => {})).toMatchObject({ verified: false })
  const paused = Promise.withResolvers()
  const aborted = []
  const second = windowKernel({ kernel: { runScript: async (input, cdp) => {
    const dialog = Promise.withResolvers()
    cdp.onEvent(input.tabId, (method) => { if (method === "Page.javascriptDialogOpening") dialog.resolve() })
    input.signal.addEventListener("abort", () => aborted.push(true))
    paused.resolve()
    await dialog.promise
    return { outcome: "paused", reason: "dialog" }
  } } })
  const other = await second.kernel.attach({ ...second.tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  other.onPause = (reason) => pauses.push(reason)
  const running = second.kernel.run(other, request, () => {})
  await paused.promise
  second.kernel.nativeEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "alert" })
  expect(await running).toEqual({ outcome: "paused", reason: "dialog" })
  expect(pauses).toEqual(["dialog"])
  expect(aborted).toEqual([])
  second.kernel.nativeEvent({ tabId: 1 }, "Page.javascriptDialogClosed", {})
  await kernel.detach(target, "stopped")
  await second.kernel.detach(other, "stopped")
})

async function grant(controller, sessionID, tabId) {
  const request = { candidateID: crypto.randomUUID(), sessionID, purpose: "attach", expiresAt: Date.now() + 60_000 }
  controller.offer(request)
  for (const target of await controller.inventory(request)) {
    const proof = (() => {
      try {
        return controller.approve({ ...request, targetID: target.id, grouping: "move" }, { tabId, windowId: 2 })
      } catch {
        return undefined
      }
    })()
    if (proof) return controller.attach({ target, proof })
  }
  throw new Error(`No candidate for tab ${tabId}`)
}

const script = { mode: "script", source: "return 1", timeoutMs: 60_000 }
const scriptSends = async () => [...(await Bun.file(new URL("../script.js", import.meta.url)).text()).matchAll(/send\("([A-Za-z]+\.[A-Za-z]+)"/g)]
  .map((match) => match[1])

test("a script run forwards only the CDP methods script.js sends and refuses every other command", async () => {
  expect([...scriptMethods].toSorted()).toEqual(["Page.addScriptToEvaluateOnNewDocument", "Page.createIsolatedWorld", "Page.getFrameTree",
    "Page.removeScriptToEvaluateOnNewDocument", "Runtime.callFunctionOn", "Runtime.disable", "Runtime.enable", "Runtime.evaluate",
    "Runtime.releaseObjectGroup", "Runtime.terminateExecution"])
  const sent = await scriptSends()
  expect(sent.length).toBeGreaterThan(0)
  for (const method of sent) expect(scriptMethods.has(method)).toBe(true)
  const refused = ["Target.setAutoAttach", "Target.setDiscoverTargets", "Target.attachToTarget", "Target.createTarget", "Browser.close",
    "Browser.grantPermissions", "Storage.getCookies", "Storage.clearDataForOrigin", "Network.getCookies", "Network.getAllCookies",
    "Network.enable", "Page.navigate", "Page.captureScreenshot", "Fetch.enable", "DOM.getDocument", "Input.dispatchMouseEvent"]
  const outcomes = []
  const { kernel, tabs, commands } = windowKernel({ kernel: { runScript: async (input, cdp) => {
    for (const method of refused) outcomes.push([method, await cdp.send(input.tabId, method, {}).then(() => "sent", (error) => error.code)])
    for (const method of scriptMethods)
      outcomes.push([method, await cdp.send(input.tabId, method, { arguments: [{ value: {} }] }).then(() => "sent", (error) => error.code)])
    return { outcome: "completed", value: 1, logs: [] }
  } } })
  const target = await kernel.attach({ ...tabs.get(1) }, { windowId: 2, grouping: "move" }, () => {})
  const before = commands.length
  expect(await kernel.run(target, { leaseID: "lease-1", ...script, signal: new AbortController().signal }, () => {}))
    .toEqual({ result: { outcome: "completed", value: 1, logs: [] }, verified: true })
  expect(outcomes).toEqual([...refused.map((method) => [method, "policy"]), ...[...scriptMethods].map((method) => [method, "sent"])])
  const during = commands.slice(before)
  for (const method of refused) expect(during.some((sentMethod) => sentMethod.startsWith(method))).toBe(false)
  await kernel.detach(target, "stopped")
  expect(commands.filter((method) => /^(?:Target|Browser|Storage|Network)\./.test(method))).toEqual([])
})

test("two Sessions' runs receive only their own tab's root-target events and results, and cannot name each other's lease", async () => {
  const gates = new Map()
  const ready = Promise.withResolvers()
  const crossed = []
  const { kernel, commands } = windowKernel({ kernel: { runScript: async (input, cdp) => {
    const seen = []
    const unsubscribe = cdp.onEvent(input.tabId, (method, params) => seen.push(`${method}:${params.executionContextId}`))
    cdp.onEvent(input.tabId === 1 ? 2 : 1, () => crossed.push(input.leaseID))
    crossed.push(...await cdp.send(input.tabId === 1 ? 2 : 1, "Runtime.evaluate", { expression: "1" }).then(() => ["sent"], (error) =>
      error.code === "ownership" ? [] : [error.code]))
    const gate = Promise.withResolvers()
    gates.set(input.tabId, gate)
    if (gates.size === 2) ready.resolve()
    await gate.promise
    unsubscribe()
    return { outcome: "completed", value: { tab: input.tabId, seen }, logs: [] }
  } } })
  const revoked = []
  const controller = createChromeController(kernel, { revoked: (event) => revoked.push(event) })
  const first = await grant(controller, "session-a", 1)
  const second = await grant(controller, "session-b", 2)
  await rejectsWith(controller.run({ ...first, sessionID: "session-b", ...script, runID: crypto.randomUUID(), revision: 1 }), "ownership")
  await rejectsWith(controller.run({ ...second, leaseID: first.leaseID, ...script, runID: crypto.randomUUID(), revision: 1 }), "ownership")
  expect(() => controller.cancelRun({ ...second, leaseID: first.leaseID, runID: crypto.randomUUID() })).toThrow("ownership")
  const running = [first, second].map((grant) => controller.run({ ...grant, ...script, runID: crypto.randomUUID(), revision: grant.revision }))
  await ready.promise
  kernel.nativeEvent({ tabId: 1 }, "Runtime.consoleAPICalled", { executionContextId: 1 })
  kernel.nativeEvent({ tabId: 2 }, "Runtime.consoleAPICalled", { executionContextId: 2 })
  kernel.nativeEvent({ tabId: 1, sessionId: "child-session" }, "Runtime.consoleAPICalled", { executionContextId: 3 })
  kernel.nativeEvent({ tabId: 2, targetId: "popup-target" }, "Runtime.exceptionThrown", { executionContextId: 4 })
  for (const gate of gates.values()) gate.resolve()
  expect(await Promise.all(running)).toEqual([
    { outcome: "completed", value: { tab: 1, seen: ["Runtime.consoleAPICalled:1"] }, logs: [] },
    { outcome: "completed", value: { tab: 2, seen: ["Runtime.consoleAPICalled:2"] }, logs: [] },
  ])
  expect(crossed).toEqual([])
  expect(revoked).toEqual([])
  await controller.detach(first)
  await controller.detach(second)
  expect(commands.filter((method) => /^(?:Target|Browser|Storage|Network)\./.test(method))).toEqual([])
})

test("a script run is refused while its tab has an opener or has opened another tab, without ending control", async () => {
  let started = 0
  const { kernel, tabs } = windowKernel({ kernel: { runScript: async () => {
    started++
    return { outcome: "completed", value: 1, logs: [] }
  } } })
  const controller = createChromeController(kernel, { revoked: () => {} })
  for (const related of [() => { tabs.get(2).openerTabId = 1 }, () => { tabs.get(1).openerTabId = 2 }]) {
    const granted = await grant(controller, "session-a", 1)
    related()
    expect(await controller.run({ ...granted, ...script, runID: crypto.randomUUID(), revision: 1 })).toEqual({ outcome: "refused", reason: "policy" })
    expect(controller.lease(granted.leaseID)).toBeDefined()
    await controller.detach(granted)
    delete tabs.get(1).openerTabId
    delete tabs.get(2).openerTabId
  }
  expect(started).toBe(0)
  const granted = await grant(controller, "session-a", 1)
  expect(await controller.run({ ...granted, ...script, runID: crypto.randomUUID(), revision: 1 })).toEqual({ outcome: "completed", value: 1, logs: [] })
  expect(started).toBe(1)
  await controller.detach(granted)
})

test.each(["stop", "revoke", "debugger detach"])("%s settles a never-ending run at once, terminates and discards it before detaching, and refuses the lease afterwards", async (trigger) => {
  let started = 0
  const begun = Promise.withResolvers()
  const fixture = windowKernel({ kernel: { runScript: (input, cdp, worlds) => {
    started++
    begun.resolve()
    worlds.set(input.leaseID, Promise.resolve({ dispose: () => { fixture.commands.push("dispose") } }))
    return new Promise(() => {})
  } } })
  const revoked = []
  const controller = createChromeController(fixture.kernel, { revoked: (event) => revoked.push(event) })
  const granted = await grant(controller, "session-a", 1)
  const running = controller.run({ ...granted, ...script, runID: crypto.randomUUID(), revision: 1 })
  await begun.promise
  const before = fixture.commands.length
  if (trigger === "revoke") controller.invalidate(1, "changed")
  if (trigger === "debugger detach") {
    fixture.kernel.nativeDetached(1)
    controller.invalidate(1, "target_lost")
  }
  await controller.detach(granted)
  expect(await running).toEqual({ outcome: "stopped", logs: [] })
  const order = fixture.commands.slice(before).filter((method) => ["Runtime.terminateExecution", "dispose", "debugger.detach"].includes(method))
  expect(order).toEqual(trigger === "debugger detach" ? ["dispose"] : ["Runtime.terminateExecution", "dispose", "debugger.detach"])
  expect(revoked).toEqual([{ leaseID: granted.leaseID, epoch: granted.epoch,
    reason: { stop: "stopped", revoke: "changed", "debugger detach": "target_lost" }[trigger] }])
  await rejectsWith(controller.run({ ...granted, ...script, runID: crypto.randomUUID(), revision: 1 }), "ownership")
  await rejectsWith(controller.observe(granted), "ownership")
  await rejectsWith(controller.perform({ ...granted, callID: crypto.randomUUID(), action: { platform: "chrome", type: "scroll", deltaY: 10 } }), "ownership")
  expect(started).toBe(1)
})

test("no extension file sends a Target, Browser, Storage or Network command or enables target auto-attach", async () => {
  const directory = new URL("../", import.meta.url).pathname
  const files = await Array.fromAsync(new Bun.Glob("*.js").scan(directory))
  expect(files).toContain("kernel.js")
  for (const file of files) {
    const source = await Bun.file(`${directory}${file}`).text()
    expect(source).not.toMatch(/\b(?:Target|Browser|Storage|Network)\.(?!prototype\b)[a-z]\w*|setAutoAttach|setDiscoverTargets|autoAttach/)
  }
})

test("a stored link keeps only a valid profile credential and discards anything invalid so the popup returns to not connected", () => {
  const address = "http://127.0.0.1:42188"
  const profileID = "P".repeat(43)
  const credential = "c".repeat(43)
  expect(storedLink(undefined)).toEqual({ link: {}, discarded: false })
  expect(storedLink({ address, profileID, credential })).toEqual({ link: { address, profileID, credential }, discarded: false })
  expect(storedLink({ address, profileID })).toEqual({ link: { address, profileID }, discarded: false })
  expect(storedLink({ address, forget: { profileID, credential } })).toEqual({ link: { address, forget: { profileID, credential } }, discarded: false })
  for (const broken of [{ address, profileID, credential: "short" }, { address, profileID, credential: `${"c".repeat(42)}=` },
    { address, profileID, credential: 43 }]) {
    expect(storedLink(broken)).toEqual({ link: { address, profileID }, discarded: true })
  }
  expect(storedLink({ address, profileID, credential, extra: true })).toEqual({ link: { address, profileID, credential }, discarded: true })
  expect(storedLink({ address, profileID: "x", credential })).toEqual({ link: { address }, discarded: true })
  expect(storedLink({ address: "http://localhost:42188", profileID, credential })).toEqual({ link: { profileID, credential }, discarded: true })
  expect(storedLink({ address, forget: { profileID, credential: "" } })).toEqual({ link: { address }, discarded: true })
  expect(storedLink("corrupt")).toEqual({ link: {}, discarded: true })
  expect(storedLink([credential])).toEqual({ link: {}, discarded: true })
})

test("no extension action path activates a tab, focuses a window, or raises Chrome", async () => {
  for (const file of ["controller.js", "kernel.js", "page.js", "service-worker.js", "script.js",
    "../../packages/core/src/interaction/chrome.ts", "../../packages/core/src/interaction/chrome-isolated.ts"]) {
    const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text()
    expect(source).not.toMatch(/tabs\.update|windows\.update|tabs\.highlight|\.focus\(|bringToFront|activateTarget|setFocusEmulationEnabled/)
    expect(source).not.toMatch(/(?:create|update)\([^)]*active:\s*true/)
  }
  const worker = await Bun.file(new URL("../service-worker.js", import.meta.url)).text()
  expect(worker.match(/focused:\s*true/g)).toHaveLength(1)
  expect(worker).toMatch(/async function openPanel[\s\S]*focused: true/)
})
