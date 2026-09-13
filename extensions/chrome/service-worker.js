import {
  MAX_CAPTURE_BYTES,
  MAX_ELEMENTS,
  MAX_SHARED_TABS,
  VERSION,
  actionGuardFailure,
  connectURL,
  reconnectDelay,
  safePage,
  tabID,
} from "./protocol.js"

const PROTOCOL_VERSION = "1.3"
const STORAGE_KEY = "browserPairing"
const RECONNECT_ALARM = "browser-reconnect"
const MAX_CAPTURE_INSPECTION_DEPTH = 32
const MAX_CAPTURE_INSPECTION_NODES = 10_000
const interactiveRoles = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
])

let socket
let generation
let pairing
let requestedPause = false
let heartbeatTimer
let reconnectAttempt = 0
let reconnectScheduled = false
const tabs = new Map()
const chromeTabs = new Map()

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  handlePopup(message).then(respond, async (error) =>
    respond(await currentState(error instanceof Error ? error.message : String(error))),
  )
  return true
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    reconnectScheduled = false
    void reconnect()
  }
})

chrome.tabs.onActivated.addListener(({ tabId: activeTabID }) => {
  for (const tab of tabs.values()) {
    const active = tab.chromeTabID === activeTabID
    if (tab.active === active) continue
    tab.active = active
    send({
      type: "takeover",
      tabID: tab.id,
      documentGeneration: tab.documentGeneration,
      active,
    })
  }
})

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return
  const id = chromeTabs.get(source.tabId)
  if (!id) return
  chromeTabs.delete(source.tabId)
  tabs.delete(id)
  send({ type: "revoked", tabID: id })
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  const id = chromeTabs.get(source.tabId)
  const tab = id ? tabs.get(id) : undefined
  if (!tab) return
  if (method !== "Page.frameNavigated" || params.frame?.parentId) return
  tab.documentGeneration++
  tab.revision = 0
  tab.refs.clear()
  tab.url = params.frame.url
  chrome.tabs.get(tab.chromeTabID).then(
    (info) =>
      send({
        type: "updated",
        tabID: tab.id,
        title: info.title ?? "",
        url: tab.url,
        documentGeneration: tab.documentGeneration,
      }),
    () => {},
  )
})

async function handlePopup(message) {
  if (message?.type === "status") return currentState()
  if (message?.type === "pair") {
    await pair(message)
    return currentState("Paired. Sharing is limited to the tab you explicitly select.")
  }
  if (message?.type === "connect") {
    await connectSelected(message)
    return currentState("Connected to the explicitly selected Session.")
  }
  if (message?.type === "share-current") {
    await shareCurrent()
    return currentState("Current tab shared and paused while you are viewing it.")
  }
  if (message?.type === "revoke-current") {
    await revokeCurrent()
    return currentState("Current tab access revoked.")
  }
  if (message?.type === "forget") {
    await forget()
    return currentState(
      pairing
        ? "Forget is pending until the paired YCoding server reconnects."
        : "Pairing forgotten and durable trust revoked.",
    )
  }
  return currentState("Unsupported extension request")
}

async function pair(input) {
  if (typeof input.secret !== "string" || input.secret.length < 32)
    throw new Error("Enter a valid one-time pairing secret")
  const url = connectURL(input.serverURL, input.sessionID)
  await disablePairing()
  const response = await open(url, {
    type: "pair",
    version: VERSION,
    extensionID: chrome.runtime.id,
    secret: input.secret,
  }).catch(async (error) => {
    await stop(false)
    throw error
  })
  if (!response.credential || !response.serverID) throw new Error("YCoding did not issue a durable pairing credential")
  pairing = {
    serverURL: input.serverURL,
    sessionID: input.sessionID,
    serverID: response.serverID,
    credential: response.credential,
    enabled: true,
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
}

async function connectSelected(input) {
  connectURL(input.serverURL, input.sessionID)
  if (!pairing || pairing.serverURL !== input.serverURL || pairing.sessionID !== input.sessionID)
    throw new Error("Create a one-time pairing for the selected Session first")
  pairing = { ...pairing, enabled: true }
  await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
  await stop(false)
  await reconnect()
}

async function open(url, handshake) {
  const current = new WebSocket(url)
  socket = current
  await new Promise((resolve, reject) => {
    const failed = () => reject(new Error("Unable to connect to the local YCoding service"))
    current.addEventListener("open", resolve, { once: true })
    current.addEventListener("error", failed, { once: true })
  })
  current.addEventListener("message", (event) => receive(event.data, current))
  current.addEventListener("close", (event) => disconnected(current, event))
  const paired = waitForPairing(current)
  current.send(JSON.stringify(handshake))
  const response = await paired
  clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => send({ type: "pong" }), 20_000)
  reconnectAttempt = 0
  reconnectScheduled = false
  await chrome.alarms.clear(RECONNECT_ALARM)
  return response
}

function waitForPairing(current) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(deadline)
      current.removeEventListener("message", check)
      current.removeEventListener("close", closed)
    }
    const deadline = setTimeout(() => {
      cleanup()
      reject(new Error("Pairing timed out"))
    }, 10_000)
    const closed = () => {
      cleanup()
      reject(new Error("Pairing rejected"))
    }
    const check = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === "paired" && message.version === VERSION) {
        cleanup()
        generation = message.generation
        resolve(message)
      }
      if (message.type === "error") {
        cleanup()
        reject(new Error(message.message))
      }
    }
    current.addEventListener("message", check)
    current.addEventListener("close", closed, { once: true })
  })
}

async function reconnect() {
  if (!pairing?.enabled || (socket && socket.readyState === WebSocket.OPEN)) return
  try {
    const response = await open(connectURL(pairing.serverURL, pairing.sessionID), {
      type: "authenticate",
      version: VERSION,
      extensionID: chrome.runtime.id,
      serverID: pairing.serverID,
      credential: pairing.credential,
    })
    if (response.serverID !== pairing.serverID) throw new Error("YCoding server identity changed")
    if (pairing.forgetPending) await revokeConnectedPairing()
  } catch {
    await stop(true)
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (!pairing?.enabled || reconnectScheduled) return
  reconnectScheduled = true
  const delayInMinutes = reconnectDelay(reconnectAttempt++) / 60_000
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes })
}

async function shareCurrent() {
  requireConnection()
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (active?.id === undefined) throw new Error("No active tab is available")
  if (chromeTabs.has(active.id)) return
  if (tabs.size >= MAX_SHARED_TABS) throw new Error(`At most ${MAX_SHARED_TABS} tabs can be shared`)
  await chrome.debugger.attach({ tabId: active.id }, PROTOCOL_VERSION)
  try {
    await Promise.all([
      command(active.id, "Page.enable"),
      command(active.id, "DOM.enable"),
      command(active.id, "Accessibility.enable"),
    ])
    const history = await command(active.id, "Page.getNavigationHistory")
    const entry = history.entries[history.currentIndex] ?? history.entries.at(-1)
    safePage(entry?.url ?? "")
    const id = tabID()
    const tab = {
      id,
      chromeTabID: active.id,
      documentGeneration: 1,
      revision: 0,
      refs: new Map(),
      allowedOrigins: new Set([new URL(entry.url).origin]),
      active: true,
      url: entry.url,
    }
    tabs.set(id, tab)
    chromeTabs.set(active.id, id)
    send({
      type: "shared",
      tabID: id,
      title: entry.title ?? active.title ?? "",
      url: entry.url,
      documentGeneration: tab.documentGeneration,
      active: true,
    })
  } catch (error) {
    await chrome.debugger.detach({ tabId: active.id }).catch(() => {})
    throw error
  }
}

async function revokeCurrent() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (active?.id === undefined) throw new Error("No active tab is available")
  const id = chromeTabs.get(active.id)
  if (!id) return
  chromeTabs.delete(active.id)
  tabs.delete(id)
  await chrome.debugger.detach({ tabId: active.id }).catch(() => {})
  send({ type: "revoked", tabID: id })
}

async function receive(raw, current = socket) {
  if (current !== socket) return
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  if (message.type === "paired") {
    generation = message.generation
    return
  }
  if (message.type === "ping") {
    send({ type: "pong" })
    return
  }
  if (message.type === "control") {
    if (message.action === "forget") {
      pairing = undefined
      await chrome.storage.local.remove(STORAGE_KEY)
      await stop(false)
      return
    }
    if (message.action === "stop") {
      if (pairing) {
        pairing = { ...pairing, enabled: false }
        await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
      }
      await stop(false)
      return
    }
    requestedPause = message.action === "pause"
    return
  }
  if (message.type === "observe") await observe(message)
  if (message.type === "action") await act(message)
}

async function observe(message) {
  try {
    const tab = requireTab(message)
    if (await isActive(tab)) return fail(message, "The shared tab is active and controlled by the user")
    const tree = await command(tab.chromeTabID, "Accessibility.getFullAXTree", { depth: 12 })
    const candidates = tree.nodes.filter(
      (node) => !node.ignored && interactiveRoles.has(node.role?.value) && node.backendDOMNodeId,
    )
    const selected = candidates.slice(0, MAX_ELEMENTS)
    tab.revision++
    tab.refs.clear()
    const elements = []
    for (const [index, node] of selected.entries()) {
      const ref = `b${index + 1}`
      tab.refs.set(ref, node.backendDOMNodeId)
      const described = await command(tab.chromeTabID, "DOM.describeNode", {
        backendNodeId: node.backendDOMNodeId,
        depth: 0,
      })
      const attributes = attrs(described.node.attributes)
      const href = attributes.get("href")
      const destination = href ? new URL(href, tab.url).toString() : undefined
      elements.push({
        ref,
        role: String(node.role?.value ?? ""),
        name: String(node.name?.value ?? ""),
        description: node.description?.value ? String(node.description.value) : undefined,
        disabled: node.properties?.some((item) => item.name === "disabled" && item.value?.value === true) || undefined,
        destination,
      })
    }
    const info = await chrome.tabs.get(tab.chromeTabID)
    send({
      type: "observation",
      callID: message.callID,
      tabID: tab.id,
      generation,
      documentGeneration: tab.documentGeneration,
      revision: tab.revision,
      title: info.title ?? "",
      url: tab.url,
      elements,
      truncated: candidates.length > MAX_ELEMENTS,
    })
  } catch (error) {
    fail(message, safeError(error))
  }
}

async function act(message) {
  let dispatched = false
  try {
    const tab = requireTab(message)
    if (requestedPause || (await isActive(tab))) return paused(message, tab)
    if (tab.documentGeneration !== message.documentGeneration || tab.revision !== message.observationRevision)
      return fail(message, "The shared tab observation is stale")
    const guardFailure = actionGuardFailure(message.action.type)
    if (guardFailure) return fail(message, guardFailure, false)
    tab.allowedOrigins = new Set(message.allowedOrigins)
    if (message.action.type === "navigate") await navigate(tab, message.action.url, () => (dispatched = true))
    if (message.action.type === "click") await click(tab, message.action.ref, () => (dispatched = true))
    if (message.action.type === "type")
      await typeText(tab, message.action.ref, message.action.text, () => (dispatched = true))
    if (message.action.type === "scroll")
      await command(tab.chromeTabID, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: message.action.deltaY,
      })
    const captured = message.action.type === "capture" ? await capture(tab) : undefined
    if (await isActive(tab)) return paused(message, tab)
    const info = await chrome.tabs.get(tab.chromeTabID)
    if (info.url && info.url !== tab.url) {
      const page = safePage(info.url)
      if (!tab.allowedOrigins.has(page.origin)) throw new Error("A disallowed top-level navigation was blocked")
      tab.url = info.url
      tab.documentGeneration++
      tab.revision = 0
      tab.refs.clear()
    }
    send({
      type: "result",
      callID: message.callID,
      tabID: tab.id,
      generation,
      documentGeneration: tab.documentGeneration,
      observationRevision: tab.revision,
      status: "completed",
      title: info.title ?? "",
      url: tab.url,
      capture: captured,
    })
  } catch (error) {
    fail(message, safeError(error), dispatched)
  }
}

async function navigate(tab, value, markDispatched) {
  const url = new URL(value)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !tab.allowedOrigins.has(url.origin)
  )
    throw new Error("Navigation target is not allowed")
  markDispatched()
  await command(tab.chromeTabID, "Page.navigate", { url: url.toString() })
}

async function click(tab, ref, markDispatched) {
  const backendNodeId = requireRef(tab, ref)
  const described = await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId, depth: 0 })
  const attributes = attrs(described.node.attributes)
  if (attributes.has("download")) throw new Error("Downloads are unsupported")
  if (attributes.get("target") && attributes.get("target") !== "_self")
    throw new Error("New tabs and popups are unsupported")
  const href = attributes.get("href")
  if (href) {
    const url = new URL(href, tab.url)
    if (!["http:", "https:"].includes(url.protocol) || !tab.allowedOrigins.has(url.origin))
      throw new Error("Link destination is not allowed")
  }
  rejectProtectedInput(described.node)
  await command(tab.chromeTabID, "DOM.scrollIntoViewIfNeeded", { backendNodeId })
  const { quads } = await command(tab.chromeTabID, "DOM.getContentQuads", { backendNodeId })
  const quad = quads?.[0]
  if (!quad) throw new Error("Element is not visible")
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  markDispatched()
  await command(tab.chromeTabID, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  })
  await command(tab.chromeTabID, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  })
}

async function typeText(tab, ref, text, markDispatched) {
  const backendNodeId = requireRef(tab, ref)
  const described = await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId, depth: 0 })
  rejectProtectedInput(described.node)
  markDispatched()
  await command(tab.chromeTabID, "DOM.focus", { backendNodeId })
  await command(tab.chromeTabID, "Input.insertText", { text })
}

async function capture(tab) {
  const { root } = await command(tab.chromeTabID, "DOM.getDocument", {
    depth: MAX_CAPTURE_INSPECTION_DEPTH,
    pierce: true,
  })
  assertCaptureSafe(root)
  const { data } = await command(tab.chromeTabID, "Page.captureScreenshot", { format: "png", fromSurface: true })
  const bytes = Math.floor((data.length * 3) / 4)
  if (bytes > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds the 1 MiB limit")
  return { mediaType: "image/png", data, bytes }
}

function assertCaptureSafe(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) throw incompleteCaptureInspection()
  const pending = [{ node: root, depth: 0 }]
  let inspected = 0
  while (pending.length) {
    const current = pending.pop()
    inspected++
    if (inspected > MAX_CAPTURE_INSPECTION_NODES) throw incompleteCaptureInspection()
    if (
      String(current.node.nodeName).toLowerCase() === "input" &&
      (attrs(current.node.attributes).get("type") ?? "text").toLowerCase() === "password"
    )
      throw new Error("Capture is disabled while password fields are present")

    const children = captureNodes(current.node.children)
    const shadowRoots = captureNodes(current.node.shadowRoots)
    const contentDocument =
      current.node.contentDocument === undefined ? [] : captureNodes([current.node.contentDocument])
    if (typeof current.node.childNodeCount === "number" && current.node.childNodeCount > children.length)
      throw incompleteCaptureInspection()
    if (String(current.node.nodeName).toLowerCase() === "iframe" && !contentDocument.length)
      throw incompleteCaptureInspection()
    const nested = [...children, ...shadowRoots, ...contentDocument]
    if (current.depth >= MAX_CAPTURE_INSPECTION_DEPTH && nested.length) throw incompleteCaptureInspection()
    pending.push(...nested.map((node) => ({ node, depth: current.depth + 1 })))
  }
}

function captureNodes(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((node) => !node || typeof node !== "object" || Array.isArray(node)))
    throw incompleteCaptureInspection()
  return value
}

function incompleteCaptureInspection() {
  return new Error("Capture is disabled because the page could not be completely inspected")
}

function requireConnection() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !generation) throw new Error("Pair the extension first")
}

function requireTab(message) {
  requireConnection()
  if (message.generation !== generation) throw new Error("Stale bridge generation")
  const tab = tabs.get(message.tabID)
  if (!tab) throw new Error("Tab is not shared")
  return tab
}

function requireRef(tab, ref) {
  const backendNodeId = tab.refs.get(ref)
  if (!backendNodeId) throw new Error("Semantic element reference is stale")
  return backendNodeId
}

function rejectProtectedInput(node) {
  if (String(node.nodeName).toLowerCase() !== "input") return
  const type = (attrs(node.attributes).get("type") ?? "text").toLowerCase()
  if (["password", "file"].includes(type)) throw new Error(`${type} inputs are unsupported`)
}

async function isActive(tab) {
  const info = await chrome.tabs.get(tab.chromeTabID)
  tab.active = info.active
  return tab.active
}

function command(chromeTabID, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId: chromeTabID }, method, params)
}

function attrs(values = []) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) result.set(values[index], values[index + 1])
  return result
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

function fail(message, text, dispatched = false) {
  send({
    type: "error",
    callID: message.callID,
    tabID: message.tabID,
    generation,
    dispatched,
    message: text.slice(0, 1024),
  })
}

function paused(message, tab) {
  send({
    type: "result",
    callID: message.callID,
    tabID: tab.id,
    generation,
    documentGeneration: tab.documentGeneration,
    observationRevision: tab.revision,
    status: "paused",
    title: "",
    url: tab.url,
    message: "The shared tab is active and controlled by the user",
  })
}

async function stop(disconnected) {
  clearInterval(heartbeatTimer)
  const attached = [...tabs.values()]
  tabs.clear()
  chromeTabs.clear()
  for (const tab of attached) await chrome.debugger.detach({ tabId: tab.chromeTabID }).catch(() => {})
  const current = socket
  socket = undefined
  generation = undefined
  requestedPause = false
  if (!disconnected && current?.readyState === WebSocket.OPEN) current.close(1000, "stopped")
}

async function disconnected(current, event) {
  if (socket !== current) return
  await stop(true)
  if (event?.code === 4403) {
    pairing = undefined
    await chrome.storage.local.remove(STORAGE_KEY)
    return
  }
  scheduleReconnect()
}

async function disablePairing() {
  if (pairing) {
    pairing = { ...pairing, enabled: true }
    await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
    await reconnect()
    if (pairing && (!socket || socket.readyState !== WebSocket.OPEN))
      throw new Error("Reconnect to the previously paired server before switching pairing")
    if (pairing) await revokeConnectedPairing()
  }
  await chrome.alarms.clear(RECONNECT_ALARM)
  reconnectScheduled = false
  pairing = undefined
  await chrome.storage.local.remove(STORAGE_KEY)
  await stop(false)
}

async function forget() {
  if (!pairing) {
    await stop(false)
    return
  }
  pairing = { ...pairing, enabled: true, forgetPending: true }
  await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
  await reconnect()
  if (pairing && socket?.readyState === WebSocket.OPEN) await revokeConnectedPairing()
}

async function revokeConnectedPairing() {
  await chrome.alarms.clear(RECONNECT_ALARM)
  reconnectScheduled = false
  send({ type: "forget" })
  pairing = undefined
  await chrome.storage.local.remove(STORAGE_KEY)
  await stop(false)
}

async function restore() {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
  if (!validPairing(stored)) {
    await chrome.storage.local.remove(STORAGE_KEY)
    return
  }
  pairing = stored
  if (pairing.enabled) await reconnect()
}

function validPairing(input) {
  if (!input || typeof input !== "object") return false
  try {
    connectURL(input.serverURL, input.sessionID)
  } catch {
    return false
  }
  return (
    typeof input.serverID === "string" &&
    input.serverID.length >= 16 &&
    typeof input.credential === "string" &&
    input.credential.length >= 32 &&
    typeof input.enabled === "boolean" &&
    (input.forgetPending === undefined || typeof input.forgetPending === "boolean")
  )
}

async function currentState(message) {
  const connected = !!socket && socket.readyState === WebSocket.OPEN && !!generation
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  return {
    paired: !!pairing,
    connected,
    currentShared: active?.id !== undefined && chromeTabs.has(active.id),
    serverURL: pairing?.serverURL,
    sessionID: pairing?.sessionID,
    message:
      message ??
      (connected
        ? `${tabs.size} tab${tabs.size === 1 ? "" : "s"} shared`
        : pairing?.enabled
          ? `Reconnecting to ${pairing.sessionID}`
          : pairing
            ? `Paired with ${pairing.sessionID}; connect explicitly to resume`
            : "Not paired"),
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Cannot access|not allowed|restricted|chrome:\/\//i.test(message))
    return "Chrome does not allow this restricted or enterprise-managed tab to be shared"
  return message.slice(0, 1024)
}

void restore()
