import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { createChromeController } from "../controller.js"
import { createChromeKernel } from "../kernel.js"
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
    },
    debugger: {
      attach: async ({ tabId }) => { effects.push(["debugger attach", tabId]) },
      detach: async ({ tabId }) => { effects.push(["debugger detach", tabId]) },
      sendCommand: async ({ tabId }, method, params) => {
        expect(tabId).toBe(2)
        if (method === "Page.navigate") {
          loaderId = "owned-document"
          newTab.url = params.url
          kernel.nativeEvent(tabId, "Page.lifecycleEvent", { name: "DOMContentLoaded", loaderId })
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
        if (method === "Runtime.callFunctionOn") return { result: { value: { marked: true, available: true, cleared: true } } }
        return {}
      },
    },
  })
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
  duringCapture = () => kernel.nativeEvent(2, "Page.frameAttached", { frameId: "child", parentFrameId: "top" })
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(3)
  duringCapture = () => kernel.nativeEvent(2, "Page.javascriptDialogOpening", { type: "prompt" })
  expect(await kernel.preview(owner, () => {})).toEqual({ status: "withheld" })
  expect(captures).toBe(4)
  expect(await kernel.snapshot(newTab, () => {})).toMatchObject({ id: 7, title: "YCoding control", members: [[2, 1]] })
  expect(await kernel.perform(owner, { type: "navigate", url: "https://example.test/admin" }, () => {}, () => {
    throw new Error("Dispatched an unapproved destination")
  })).toEqual({ refusal: "policy" })
  newTab.url = "https://example.test/admin"
  expect(await kernel.verify(owner, () => {})).toBe(false)
  newTab.url = "https://example.test/form"
  expect(await kernel.verify(owner, () => {})).toBe(true)
  kernel.nativeEvent(2, "Page.navigatedWithinDocument", { frameId: "top", url: "https://example.test/form?q=changed" })
  expect(await kernel.verify(owner, () => {})).toBe(false)
  group.title = "User keeps this group"
  expect(await kernel.verify(owner, () => {})).toBe(false)
  await kernel.detach(owner, "stopped")
  expect(effects.at(-1)).toEqual(["debugger detach", 2])
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
          kernel.nativeEvent(tabId, "Page.lifecycleEvent", { name: "DOMContentLoaded", loaderId: loaderID })
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
