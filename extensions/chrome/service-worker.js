import {
  MAX_AX_DEPTH,
  MAX_CAPTURE_BYTES,
  MAX_CLIPBOARD_BYTES,
  MAX_DETACH_REASON,
  MAX_ELEMENTS,
  MAX_EXPORT_BYTES,
  MAX_FRAMES,
  MAX_HISTORY_RESULTS,
  MAX_LOG_ENTRIES,
  MAX_SELECT_OPTIONS,
  MAX_SHARED_TABS,
  MAX_TEXTS,
  MAX_UPLOAD_FILES,
  MAX_WAIT_MS,
  VERSION,
  connectURL,
  reconnectDelay,
  safePage,
  tabID,
} from "./protocol.js"
import { geistSans } from "./fonts.js"
import { LABELS, markerScript, timing, tokens } from "./indicator.js"

const PROTOCOL_VERSION = "1.3"
const STORAGE_KEY = "browserPairing"
const PROFILE_DENIED_KEY = "browserProfileDeniedTabs"
const RECONNECT_ALARM = "browser-reconnect"
const RECOVERY_ALARM = "browser-recovery"
const MAX_CAPTURE_INSPECTION_DEPTH = 32
const MAX_CAPTURE_INSPECTION_NODES = 10_000
const CURSOR_WORLD = "ycoding-agent-cursor"
const CURSOR_COMMAND_TIMEOUT_MS = 600
const INPUT_COMMAND_TIMEOUT_MS = 2000
const MARKER_FAILED = "YCoding could not show its control marker on this page"
const CONTROL_WORLD = "ycoding-control"
const NETWORK_IDLE_MS = 500
const CONTROL_SETTLE_MS = 500
const PAGE_SCRIPT_NEWLINE = String.fromCharCode(10)
const LOCATOR = /^role=([^[\]|]{1,64})\[name=("(?:[^"\\]|\\.)*")\](?:\|nth=([1-9][0-9]{0,3}))?$/
const SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"]
const SECRET_NAME = /pass(?:word|code|phrase)|one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|card[\s_-]?(?:number|no)|(?:^|[^a-z0-9])(?:otp|totp|mfa|2fa|pin|cvv|cvc|csc|ccnum)(?:$|[^a-z0-9])/i
const IS_SENSITIVE = [
  `const isSensitive = (el) => {`,
  `  const tag = el.localName`,
  `  if (tag !== "input" && tag !== "textarea" && !el.isContentEditable) return false`,
  `  if (tag === "input" && el.type === "password") return true`,
  `  if ((el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).some((token) => ${JSON.stringify(SECRET_AUTOCOMPLETE)}.includes(token))) return true`,
  `  if (["name", "id", "aria-label", "placeholder"].some((key) => ${SECRET_NAME}.test(el.getAttribute(key) || ""))) return true`,
  `  const labels = [...(el.labels || [])]`,
  `  for (const id of (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)) {`,
  `    const label = el.ownerDocument.getElementById(id)`,
  `    if (label) labels.push(label)`,
  `  }`,
  `  return labels.some((label) => ${SECRET_NAME}.test(String(label.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 256)))`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const F_CONTROL_STATE = [
  `function () { ${IS_SENSITIVE}`,
  `  const el = this`,
  `  if (isSensitive(el)) return { sensitive: true }`,
  `  if (el.localName === "select") return { selected: [...el.selectedOptions].slice(0, 32).map((o) => ({ value: o.value.slice(0, 1024), label: (o.label || o.text).trim().slice(0, 1024), index: o.index })) }`,
  `  if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) return { checked: el.indeterminate ? "mixed" : el.checked }`,
  `  if (el.localName === "input" || el.localName === "textarea") return { value: String(el.value).slice(0, 1024) }`,
  `  if (el.isContentEditable) return { value: String(el.innerText).slice(0, 1024) }`,
  `  return {}`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const F_FILL = [
  `function (text, apply) { ${IS_SENSITIVE}`,
  `  const el = this`,
  `  if (isSensitive(el)) return { error: "Sensitive fields cannot be filled" }`,
  `  const setTypes = ["color", "date", "datetime-local", "month", "range", "time", "week"]`,
  `  const textTypes = ["email", "number", "search", "tel", "text", "url"]`,
  `  const input = el.localName === "input", area = el.localName === "textarea"`,
  `  if ((input || area) && (el.disabled || el.readOnly)) return { error: "Field is not editable" }`,
  `  const kind = input ? (setTypes.includes(el.type) ? "set" : textTypes.includes(el.type) ? "insert" : undefined) : area || el.isContentEditable ? "insert" : undefined`,
  `  if (!kind) return { error: "Element cannot be filled" }`,
  `  if (!apply) return { kind }`,
  `  el.focus()`,
  `  if (kind === "set") {`,
  `    el.value = text`,
  `    if (el.value !== text) return { error: "Field rejected the value" }`,
  `    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))`,
  `    el.dispatchEvent(new Event("change", { bubbles: true }))`,
  `    return { kind }`,
  `  }`,
  `  if (input || area) el.select()`,
  `  else { const range = el.ownerDocument.createRange(); range.selectNodeContents(el); const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range) }`,
  `  return { kind }`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const F_SELECT = [
  `function (criteria, apply) {`,
  `  const el = this`,
  `  if (el.localName !== "select") return { error: "Element is not a select" }`,
  `  if (el.disabled) return { error: "Select is disabled" }`,
  `  const options = [...el.options], picked = []`,
  `  const lists = [["value", criteria.values], ["label", criteria.labels], ["index", criteria.indexes]]`,
  `  for (const [kind, list] of lists) for (const wanted of list || []) {`,
  `    const option = options.find((candidate) => kind === "value" ? candidate.value === wanted : kind === "label" ? (candidate.label || candidate.text).trim() === String(wanted).trim() : candidate.index === wanted)`,
  `    if (!option) return { error: "Option not found" }`,
  `    if (option.disabled) return { error: "Option is disabled" }`,
  `    if (!picked.includes(option)) picked.push(option)`,
  `  }`,
  `  if (picked.length > 1 && !el.multiple) return { error: "Select accepts one option" }`,
  `  if (!apply) return { ok: true }`,
  `  for (const option of options) option.selected = picked.includes(option)`,
  `  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))`,
  `  el.dispatchEvent(new Event("change", { bubbles: true }))`,
  `  return { ok: true }`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const F_READY = `function () { return document.readyState }`
const F_TEXT_PRESENT = [
  `function (needle) {`,
  `  const normalize = (value) => String(value).replace(/\\s+/g, " ").trim()`,
  `  return normalize(document.body ? document.body.innerText : "").includes(normalize(needle))`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const F_CONNECTED = `function () { return this.isConnected }`
const F_FOCUSED = [
  `function () {`,
  `  let el = document.activeElement`,
  `  for (;;) {`,
  `    if (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement`,
  `    else if (el && (el.localName === "iframe" || el.localName === "frame") && el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement`,
  `    else return el`,
  `  }`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const F_DOCUMENT = `function () { return document }`
const F_SENSITIVE_ELEMENT = [
  `function () { ${IS_SENSITIVE}`,
  `  return isSensitive(this)`,
  `}`,
].join(PAGE_SCRIPT_NEWLINE)
const FORM_INPUT_SELECTOR = ["date", "time", "datetime-local", "month", "week", "color", "range"]
  .map((type) => `input[type="${type}" i]`)
  .join(", ")
const WAIT_STATES = new Set(["attached", "visible", "hidden", "detached"])
const LOAD_STATES = new Set(["domcontentloaded", "load", "networkidle"])
const NETWORK_EVENTS = new Set(["Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed"])
const valueRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"])
const interactiveRoles = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
])
const editableRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"])
const textRoles = new Set([
  "StaticText",
  "caption",
  "cell",
  "columnheader",
  "definition",
  "heading",
  "listitem",
  "paragraph",
  "rowheader",
  "term",
])
const namedKeys = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
}
const ACTION_TYPES = new Set([
  "navigate",
  "click",
  "type",
  "scroll",
  "capture",
  "group",
  "ungroup",
  "back",
  "forward",
  "reload",
  "key",
  "wait",
  "clipboard_read",
  "clipboard_write",
  "upload",
  "download",
  "logs",
  "export",
  "webmcp_list",
  "webmcp_invoke",
  "dialog",
  "fill",
  "select",
  "check",
  "hover",
])

let socket
let generation
let pairing
let requestedPause = false
let heartbeatTimer
let refreshTimer
let reconnectAttempt = 0
let reconnectScheduled = false
const tabs = new Map()
const chromeTabs = new Map()
const groups = new Map()
const deniedTabs = new Set()
const navigatedAway = new Map()

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  handlePopup(message).then(respond, async (error) =>
    respond(await currentState(error instanceof Error ? error.message : String(error))),
  )
  return true
})

chrome.runtime.onStartup.addListener(() => {
  if (!pairing?.enabled) return
  void ensureRecoveryAlarm()
    .then(() => reconnect())
    .catch(() => scheduleReconnect())
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    reconnectScheduled = false
    void reconnect()
  }
  if (alarm.name === RECOVERY_ALARM) void reconnect()
})

chrome.tabs.onActivated.addListener(({ tabId: activeTabID, windowId }) => {
  for (const tab of tabs.values()) {
    if (windowId !== undefined && tab.windowID !== undefined && tab.windowID !== windowId) continue
    const active = tab.chromeTabID === activeTabID
    if (tab.active === active) continue
    tab.active = active
    updateBadge(tab)
    send({
      type: "takeover",
      tabID: tab.id,
      documentGeneration: tab.documentGeneration,
      active,
    })
  }
})

chrome.tabs.onAttached.addListener((chromeTabID, info) => {
  const tab = tabs.get(chromeTabs.get(chromeTabID))
  if (!tab) return
  tab.windowID = info.newWindowId
  void isActive(tab).catch(() => {})
})

chrome.tabs.onCreated.addListener((tab) => {
  if (pairing?.enabled) registerProfileTab(tab)
})

chrome.tabs.onUpdated.addListener((chromeTabID, change, info) => {
  if (!pairing?.enabled) return
  const current = tabs.get(chromeTabs.get(chromeTabID))
  if (current && info.windowId !== undefined) current.windowID = info.windowId
  if (current?.profile && change.url && !isAllowedPage(current, change.url)) {
    void revokeTab(current, "navigated").then(() => registerProfileTab(info))
    return
  }
  if (current?.profile && change.url) {
    current.url = change.url
    current.documentGeneration++
    current.revision = 0
    current.refs.clear()
    send({
      type: "updated",
      tabID: current.id,
      title: info.title ?? "",
      url: current.url,
      documentGeneration: current.documentGeneration,
    })
  }
  if (!current) registerProfileTab(info)
})

chrome.tabs.onRemoved.addListener((chromeTabID) => {
  deniedTabs.delete(chromeTabID)
  navigatedAway.delete(chromeTabID)
  void persistDeniedTabs()
  const tab = tabs.get(chromeTabs.get(chromeTabID))
  if (tab) void revokeTab(tab, "closed")
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return
  const id = chromeTabs.get(source.tabId)
  if (!id) return
  const tab = tabs.get(id)
  if (tab?.profile && !tab.attached) return
  if (tab && !tab.owned) {
    deniedTabs.add(tab.chromeTabID)
    void persistDeniedTabs()
  }
  chromeTabs.delete(source.tabId)
  tabs.delete(id)
  syncRefreshTimer()
  clearBadge(source.tabId)
  send({
    type: "revoked",
    tabID: id,
    reason: "detached",
    ...(typeof reason === "string" && reason ? { detachReason: reason.slice(0, MAX_DETACH_REASON) } : {}),
  })
  if (tab?.owned) void removeInactive(tab.chromeTabID)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  const id = chromeTabs.get(source.tabId)
  const tab = id ? tabs.get(id) : undefined
  if (!tab) return
  if (NETWORK_EVENTS.has(method)) {
    trackNetwork(tab, source.sessionId, method, params)
    return
  }
  if (method === "Target.attachedToTarget") {
    registerChildSession(tab, params)
    return
  }
  if (method === "Target.detachedFromTarget") {
    forgetChildSession(tab, params?.sessionId)
    return
  }
  if (method === "Target.targetInfoChanged") {
    const info = params?.targetInfo
    for (const session of tabSessions(tab).values())
      if (session.targetId === info?.targetId && info?.url) session.url = info.url
    return
  }
  if (method === "Page.javascriptDialogOpening") {
    tab.dialog = {
      kind: String(params?.type ?? "alert").slice(0, 32),
      message: String(params?.message ?? "").slice(0, 1024),
      defaultPrompt: params?.defaultPrompt ? String(params.defaultPrompt).slice(0, 1024) : undefined,
      sessionId: source.sessionId,
    }
    return
  }
  if (method === "Page.javascriptDialogClosed") {
    delete tab.dialog
    return
  }
  if (method === "Runtime.consoleAPICalled") {
    recordConsole(tab, source, params)
    return
  }
  if (method === "Runtime.exceptionThrown") {
    recordException(tab, source, params)
    return
  }
  if (method !== "Page.frameNavigated") return
  if (source.sessionId || params.frame?.parentId) {
    for (const [ref, target] of tab.refs)
      if (
        target.sessionId === source.sessionId &&
        (!params.frame?.id || target.frameId === params.frame.id)
      )
        tab.refs.delete(ref)
    forgetControlWorlds(tab, source.sessionId, params.frame?.id)
    const session = source.sessionId ? tabSessions(tab).get(source.sessionId) : undefined
    if (session && !params.frame?.parentId && params.frame?.url) session.url = params.frame.url
    return
  }
  if (!isAllowedPage(tab, params.frame?.url)) {
    void revokeTab(tab, "navigated")
    return
  }
  tab.documentGeneration++
  tab.revision = 0
  tab.refs.clear()
  for (const sessionId of tabSessions(tab).keys()) dropRequests(tab, sessionId)
  tabSessions(tab).clear()
  tab.logs = []
  tab.url = params.frame.url
  forgetDocument(tab)
  if (tab.marked) void mark(tab)
  tabInfo(tab).then(
    (info) => {
      if (tabs.get(tab.id) !== tab || tab.url !== params.frame.url) return
      if (!isAllowedPage(tab, info.url)) {
        void revokeTab(tab, "navigated")
        return
      }
      send({
        type: "updated",
        tabID: tab.id,
        title: info.title ?? "",
        url: tab.url,
        documentGeneration: tab.documentGeneration,
      })
    },
    () => {},
  )
})

async function handlePopup(message) {
  if (message?.type === "status") return currentState()
  if (message?.type === "pair") {
    await pair(message)
    return currentState("Paired. Eligible existing tabs are available for approved actions.")
  }
  if (message?.type === "connect") {
    await retryConnection(message)
    return currentState("Connected to YCoding. Eligible existing tabs are available for approved actions.")
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
  const url = connectURL(input.serverURL)
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
  try {
    if (!response.credential || !response.serverID) throw new Error("YCoding did not issue a durable pairing credential")
    pairing = {
      serverURL: input.serverURL,
      serverID: response.serverID,
      credential: response.credential,
      enabled: true,
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
    await ensureRecoveryAlarm()
    send({ type: "profile_access", enabled: true })
    await enumerateProfileTabs()
  } catch (error) {
    send({ type: "forget" })
    pairing = undefined
    await Promise.allSettled([chrome.storage.local.remove(STORAGE_KEY), clearReconnectAlarms()])
    await stop(false)
    throw error
  }
}

async function retryConnection(input) {
  connectURL(input.serverURL)
  if (!pairing || pairing.serverURL !== input.serverURL)
    throw new Error("Pair this YCoding server with a one-time code first")
  pairing = { ...pairing, enabled: true }
  await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
  await ensureRecoveryAlarm()
  await stop(false)
  await reconnect()
}

async function open(url, handshake) {
  const current = new WebSocket(url)
  socket = current
  await new Promise((resolve, reject) => {
    const failed = (event) => {
      event.preventDefault?.()
      reject(new Error("Unable to connect to the local YCoding service"))
    }
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
  if (!pairing?.enabled || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  if (socket) await stop(true)
  try {
    const response = await open(connectURL(pairing.serverURL), {
      type: "authenticate",
      version: VERSION,
      extensionID: chrome.runtime.id,
      serverID: pairing.serverID,
      credential: pairing.credential,
    })
    if (response.serverID !== pairing.serverID) throw new Error("YCoding server identity changed")
    if (pairing.forgetPending) await revokeConnectedPairing()
    else {
      send({ type: "profile_access", enabled: true })
      await enumerateProfileTabs()
    }
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

async function ensureRecoveryAlarm() {
  if (!pairing?.enabled || (await chrome.alarms.get(RECOVERY_ALARM))) return
  await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 0.5, persistAcrossSessions: true })
}

async function clearReconnectAlarms() {
  await chrome.alarms.clear(RECONNECT_ALARM)
  await chrome.alarms.clear(RECOVERY_ALARM)
  reconnectScheduled = false
}

async function enumerateProfileTabs() {
  for (const tab of await chrome.tabs.query({})) registerProfileTab(tab)
}

function registerProfileTab(info) {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    !pairing?.enabled ||
    info?.id === undefined ||
    chromeTabs.has(info.id) ||
    deniedTabs.has(info.id)
  )
    return
  try {
    safePage(info.url)
  } catch {
    return
  }
  const id = tabID()
  const replaces = navigatedAway.get(info.id)
  navigatedAway.delete(info.id)
  const tab = {
    id,
    chromeTabID: info.id,
    profile: true,
    attached: false,
    documentGeneration: 1,
    windowID: info.windowId,
    revision: 0,
    refs: new Map(),
    sessions: new Map(),
    frameOrigins: new Set(),
    downloadSince: Date.now(),
    allowedOrigins: new Set([new URL(info.url).origin]),
    active: !!info.active,
    url: info.url,
  }
  tabs.set(id, tab)
  chromeTabs.set(info.id, id)
  send({
    type: "shared",
    mode: "profile",
    tabID: id,
    title: info.title ?? "",
    url: info.url,
    documentGeneration: 1,
    active: !!info.active,
    ...(replaces ? { replaces } : {}),
  })
}

async function revokePairedTabs() {
  send({ type: "profile_access", enabled: false })
  for (const tab of [...tabs.values()].filter((item) => item.profile)) await revokeTab(tab, "access_revoked")
  navigatedAway.clear()
  groups.clear()
  deniedTabs.clear()
  await chrome.storage.local.remove(PROFILE_DENIED_KEY)
}

function persistDeniedTabs() {
  if (!pairing?.serverID) return Promise.resolve()
  return chrome.storage.local.set({
    [PROFILE_DENIED_KEY]: {
      serverID: pairing.serverID,
      tabIDs: [...deniedTabs],
    },
  })
}

async function revokeTab(tab, reason) {
  if (!tab || tabs.get(tab.id) !== tab) return
  chromeTabs.delete(tab.chromeTabID)
  tabs.delete(tab.id)
  clearBadge(tab.chromeTabID)
  if (reason === "navigated" && tab.profile) navigatedAway.set(tab.chromeTabID, tab.id)
  send({ type: "revoked", tabID: tab.id, reason })
  await clearMarker(tab)
  if (!tab.profile || tab.attached) await chrome.debugger.detach({ tabId: tab.chromeTabID }).catch(() => {})
  if (tab.owned && !tab.deliverable) await removeInactive(tab.chromeTabID)
}

function isAllowedPage(tab, value) {
  try {
    return tab.allowedOrigins.has(safePage(value).origin)
  } catch {
    return false
  }
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
      await revokePairedTabs()
      pairing = undefined
      await chrome.storage.local.remove(STORAGE_KEY)
      await clearReconnectAlarms()
      await stop(false)
      return
    }
    if (message.action === "stop") {
      if (pairing) {
        pairing = { ...pairing, enabled: false }
        await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
      }
      await clearReconnectAlarms()
      await stop(false)
      return
    }
    requestedPause = message.action === "pause"
    return
  }
  if (message.type === "observe") await observe(message)
  if (message.type === "action") await act(message)
  if (message.type === "history") await searchHistory(message)
  if (message.type === "open") await openTab(message)
  if (message.type === "close") await closeTab(message)
  if (message.type === "relinquish") await relinquish(message)
  if (message.type === "release" && message.generation === generation) {
    const tab = tabs.get(message.tabID)
    if (tab?.owned) await revokeTab(tab, "closed")
  }
  if (message.type === "deliver" && message.generation === generation) {
    const tab = tabs.get(message.tabID)
    if (tab?.owned) tab.deliverable = true
  }
}

function tabSessions(tab) {
  tab.sessions ??= new Map()
  return tab.sessions
}

function tabFrameOrigins(tab) {
  tab.frameOrigins ??= new Set()
  return tab.frameOrigins
}

function tabLogs(tab) {
  tab.logs ??= []
  return tab.logs
}

function logText(value) {
  return String(value ?? "").slice(0, 1024)
}

function frameForSession(tab, sessionId) {
  if (!sessionId) return undefined
  return tabSessions(tab).get(sessionId)?.url || undefined
}

function pushLog(tab, entry) {
  const logs = tabLogs(tab)
  logs.push(entry)
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES)
}

function consoleValue(arg) {
  if (!arg || typeof arg !== "object") return String(arg ?? "")
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : (JSON.stringify(arg.value) ?? String(arg.value))
  return String(arg.description ?? arg.type ?? "")
}

function recordConsole(tab, source, params) {
  const frame = frameForSession(tab, source.sessionId)
  pushLog(tab, {
    level: String(params?.type ?? "log").slice(0, 16),
    text: logText((params?.args ?? []).map(consoleValue).join(" ")),
    ...(frame ? { frame } : {}),
  })
}

function recordException(tab, source, params) {
  const frame = frameForSession(tab, source.sessionId)
  const details = params?.exceptionDetails
  const text = [details?.text, details?.exception?.description].filter(Boolean).join(" ")
  pushLog(tab, {
    level: "error",
    text: logText(text || "Uncaught exception"),
    ...(frame ? { frame } : {}),
  })
}

async function optionalPermission(name) {
  if (!chrome.permissions?.contains) throw new Error(`Chrome optional ${name} permission is unavailable`)
  if (await chrome.permissions.contains({ permissions: [name] })) return
  const granted = await chrome.permissions.request({ permissions: [name] }).catch(() => false)
  if (!granted)
    throw new Error(`Grant the optional ${name} permission by reconnecting from the YCoding extension popup`)
}

async function searchHistory(message) {
  try {
    requireConnection()
    if (message.generation !== generation) throw new Error("Stale bridge generation")
    await optionalPermission("history")
    if (!chrome.history?.search) throw new Error("Chrome history is unavailable")
    const limit = Math.min(Math.max(message.limit ?? 25, 1), MAX_HISTORY_RESULTS)
    const results = await chrome.history.search({
      text: message.query ?? "",
      maxResults: limit,
      ...(message.startTime !== undefined ? { startTime: message.startTime } : {}),
      ...(message.endTime !== undefined ? { endTime: message.endTime } : {}),
    })
    const entries = []
    for (const item of results ?? []) {
      try {
        const url = new URL(item.url)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue
        entries.push({
          url: url.toString().slice(0, 2048),
          title: String(item.title ?? "").slice(0, 512),
          lastVisitTime: Math.max(0, Math.floor(item.lastVisitTime ?? 0)),
          visitCount: item.visitCount,
        })
      } catch {}
      if (entries.length >= limit) break
    }
    send({ type: "history_result", callID: message.callID, generation, entries })
  } catch (error) {
    send({ type: "history_error", callID: message.callID, generation, message: safeError(error) })
  }
}

function applyFrameOrigins(tab, message) {
  if (Array.isArray(message.frameOrigins))
    tab.frameOrigins = new Set(message.frameOrigins.filter((origin) => typeof origin === "string"))
  syncNetworkSessions(tab)
}

function approvedOrigins(tab) {
  return new Set([...tab.allowedOrigins, ...tabFrameOrigins(tab)])
}

function originOf(url) {
  try {
    return safePage(url).origin
  } catch {
    return undefined
  }
}

function syncNetworkSessions(tab) {
  const allowed = approvedOrigins(tab)
  for (const [sessionId, session] of tabSessions(tab))
    if (!session.network && allowed.has(originOf(session.url))) session.network = enableSessionNetwork(tab, sessionId, session)
}

async function enableSessionNetwork(tab, sessionId, session) {
  try {
    await session.ready
    if (session.failed) throw new Error("Frame session is unavailable")
    await command(tab.chromeTabID, "Network.enable", {}, sessionId)
  } catch {
    session.networkFailed = true
  }
}

function tabRequests(tab) {
  tab.requests ??= new Map()
  return tab.requests
}

function pendingRequests(tab) {
  let count = 0
  for (const ids of tabRequests(tab).values()) count += ids.size
  return count
}

function settleRequests(tab) {
  if (!pendingRequests(tab)) tab.networkQuietSince = Date.now()
}

function trackNetwork(tab, sessionId, method, params) {
  if (sessionId && !tabSessions(tab).has(sessionId)) return
  const requestId = params?.requestId
  if (typeof requestId !== "string" || !requestId) return
  const requests = tabRequests(tab)
  const key = sessionId ?? ""
  const ids = requests.get(key) ?? new Set()
  if (method === "Network.requestWillBeSent") ids.add(requestId)
  else ids.delete(requestId)
  if (ids.size) requests.set(key, ids)
  else requests.delete(key)
  settleRequests(tab)
}

function dropRequests(tab, sessionId) {
  if (tabRequests(tab).delete(sessionId)) settleRequests(tab)
}

function clearRequests(tab) {
  tab.requests = new Map()
  tab.networkQuietSince = undefined
}

function networkUntracked(tab) {
  const allowed = approvedOrigins(tab)
  return [...tabSessions(tab).values()].some((session) => session.networkFailed && allowed.has(originOf(session.url)))
}

function autoAttachParams() {
  return {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "iframe", exclude: false }, { type: "page", exclude: false }, { exclude: true }],
  }
}

async function enableTab(tab) {
  await Promise.all([
    command(tab.chromeTabID, "Page.enable"),
    command(tab.chromeTabID, "DOM.enable"),
    command(tab.chromeTabID, "Accessibility.enable"),
    command(tab.chromeTabID, "Runtime.enable"),
    command(tab.chromeTabID, "Network.enable"),
  ])
  await command(tab.chromeTabID, "Target.setAutoAttach", autoAttachParams())
}

function registerChildSession(tab, params) {
  const sessionId = params?.sessionId
  const info = params?.targetInfo
  if (!sessionId || info?.type !== "iframe") return
  const sessions = tabSessions(tab)
  if (sessions.has(sessionId) || sessions.size >= MAX_FRAMES) return
  const session = { targetId: info.targetId, url: info.url ?? "", ready: undefined }
  sessions.set(sessionId, session)
  session.ready = (async () => {
    await command(tab.chromeTabID, "Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId)
    await Promise.all([
      command(tab.chromeTabID, "Page.enable", {}, sessionId),
      command(tab.chromeTabID, "DOM.enable", {}, sessionId),
      command(tab.chromeTabID, "Accessibility.enable", {}, sessionId),
      command(tab.chromeTabID, "Runtime.enable", {}, sessionId),
    ])
    await command(tab.chromeTabID, "Target.setAutoAttach", autoAttachParams(), sessionId).catch(() => {})
  })().catch(() => {
    session.failed = true
  })
  syncNetworkSessions(tab)
}

function forgetChildSession(tab, sessionId) {
  if (!sessionId) return
  tabSessions(tab).delete(sessionId)
  dropRequests(tab, sessionId)
  forgetControlWorlds(tab, sessionId)
  for (const [ref, target] of tab.refs) if (target.sessionId === sessionId) tab.refs.delete(ref)
}

async function openTab(message) {
  let chromeTabID
  const owner = socket
  const bridgeGeneration = generation
  try {
    requireConnection()
    if (requestedPause) throw new Error("Chrome bridge is paused")
    if (message.generation !== generation || tabs.has(message.tabID)) throw new Error("Stale or duplicate tab identity")
    if ([...tabs.values()].filter((tab) => !tab.profile).length >= MAX_SHARED_TABS)
      throw new Error(`At most ${MAX_SHARED_TABS} tabs can be controlled`)
    const page = safePage(message.url)
    const created = await chrome.tabs.create({ url: "about:blank", active: false })
    chromeTabID = created.id
    if (chromeTabID === undefined) throw new Error("Chrome did not create a tab")
    if (socket !== owner || generation !== bridgeGeneration || owner.readyState !== WebSocket.OPEN)
      throw new Error("Chrome bridge changed while opening a tab")
    await chrome.debugger.attach({ tabId: chromeTabID }, PROTOCOL_VERSION)
    await command(chromeTabID, "Emulation.setFocusEmulationEnabled", { enabled: true })
    await enableTab({ chromeTabID })
    if (socket !== owner || generation !== bridgeGeneration || owner.readyState !== WebSocket.OPEN)
      throw new Error("Chrome bridge changed while opening a tab")
    const tab = {
      id: message.tabID,
      chromeTabID,
      windowID: created.windowId,
      owned: true,
      attached: true,
      documentGeneration: 1,
      revision: 0,
      refs: new Map(),
      sessions: new Map(),
      frameOrigins: new Set(),
    downloadSince: Date.now(),
      allowedOrigins: new Set([page.origin]),
      active: created.active,
      url: message.url,
    }
    tabs.set(tab.id, tab)
    chromeTabs.set(chromeTabID, tab.id)
    updateBadge(tab)
    await command(chromeTabID, "Page.navigate", { url: message.url })
    const info = await waitForOwnedPage(tab)
    if (
      socket !== owner ||
      generation !== bridgeGeneration ||
      tabs.get(tab.id) !== tab ||
      !isAllowedPage(tab, info.url)
    )
      throw new Error("Created tab reached an unapproved site or lost its bridge")
    tab.url = info.url
    if (!(await mark(tab))) throw new Error(MARKER_FAILED)
    send({
      type: "opened",
      callID: message.callID,
      tabID: tab.id,
      generation,
      title: info.title,
      url: tab.url,
      documentGeneration: tab.documentGeneration,
      active: info.active,
    })
  } catch (error) {
    if (chromeTabID !== undefined) {
      if (chromeTabs.get(chromeTabID) === message.tabID) chromeTabs.delete(chromeTabID)
      if (tabs.get(message.tabID)?.chromeTabID === chromeTabID) tabs.delete(message.tabID)
      syncRefreshTimer()
      clearBadge(chromeTabID)
      await chrome.debugger.detach({ tabId: chromeTabID }).catch(() => {})
      await removeInactive(chromeTabID)
    }
    if (socket === owner && generation === bridgeGeneration) fail(message, safeError(error), chromeTabID !== undefined)
  }
}

async function closeTab(message) {
  let dispatched = false
  try {
    const tab = requireTab(message)
    if (!tab.owned) throw new Error("Only agent-created tabs can be closed")
    if (await isActive(tab)) throw new Error("The owned tab is active and controlled by the user")
    chromeTabs.delete(tab.chromeTabID)
    tabs.delete(tab.id)
    syncRefreshTimer()
    clearBadge(tab.chromeTabID)
    dispatched = true
    await chrome.tabs.remove(tab.chromeTabID)
    send({ type: "closed", callID: message.callID, tabID: tab.id, generation })
  } catch (error) {
    fail(message, safeError(error), dispatched)
  }
}

async function groupTabs(message) {
  let dispatched = false
  try {
    const request = message.action
    requireConnection()
    if (!pairing?.enabled || requestedPause || message.generation !== generation)
      throw new Error("Profile access is unavailable")
    if (
      !Array.isArray(request.tabIDs) ||
      request.tabIDs.length < 1 ||
      request.tabIDs.length > 8 ||
      !request.tabIDs.includes(message.tabID) ||
      new Set(request.tabIDs).size !== request.tabIDs.length ||
      typeof request.title !== "string" ||
      !request.title.length ||
      request.title.length > 64
    )
      throw new Error("Invalid tab group request")
    const selected = request.tabIDs.map((id) => tabs.get(id))
    if (selected.some((tab) => !tab?.profile)) throw new Error("Only granted profile tabs can be grouped")
    const info = await Promise.all(selected.map((tab) => chrome.tabs.get(tab.chromeTabID)))
    if (info.some((tab) => tab.active || tab.groupId !== -1 || tab.windowId !== info[0].windowId))
      throw new Error("Only inactive ungrouped tabs in one window can be grouped")
    if (
      selected.some(
        (tab, index) =>
          tabs.get(tab.id) !== tab ||
          !isAllowedPage(tab, info[index].url) ||
          !message.allowedOrigins.includes(new URL(info[index].url).origin),
      ) ||
      !pairing?.enabled
    )
      throw new Error("Profile tab grant changed")
    await controlTabs(selected)
    dispatched = true
    const groupID = await chrome.tabs.group({ tabIds: info.map((tab) => tab.id) })
    groups.set(
      groupID,
      selected.map((tab) => tab.chromeTabID),
    )
    await chrome.tabGroups.update(groupID, { title: request.title })
    const anchor = tabs.get(message.tabID)
    send({
      type: "result",
      callID: message.callID,
      tabID: message.tabID,
      generation,
      documentGeneration: anchor.documentGeneration,
      observationRevision: anchor.revision,
      status: "completed",
      title: (await tabInfo(anchor)).title ?? "",
      url: anchor.url,
      groupID,
    })
  } catch (error) {
    fail(message, safeError(error), dispatched)
  }
}

async function ungroupTabs(message) {
  let dispatched = false
  try {
    const request = message.action
    requireConnection()
    const ids = groups.get(request.groupID)
    if (!pairing?.enabled || requestedPause || message.generation !== generation || !ids)
      throw new Error("This group is not owned by the current profile grant")
    if (
      ids.length !== request.tabIDs.length ||
      ids.some((id) => !request.tabIDs.includes(chromeTabs.get(id))) ||
      !request.tabIDs.includes(message.tabID)
    )
      throw new Error("Group membership changed")
    const members = await chrome.tabs.query({ groupId: request.groupID })
    if (members.length !== ids.length || members.some((tab) => !ids.includes(tab.id)))
      throw new Error("Group membership changed")
    const info = await Promise.all(ids.map((id) => chrome.tabs.get(id)))
    if (
      info.some(
        (tab) =>
          tab.active || tab.groupId !== request.groupID || !message.allowedOrigins.includes(new URL(tab.url).origin),
      ) ||
      ids.some((id) => !tabs.get(chromeTabs.get(id))?.profile)
    )
      throw new Error("Group tabs changed or are controlled by the user")
    await controlTabs(ids.map((id) => tabs.get(chromeTabs.get(id))))
    dispatched = true
    await chrome.tabs.ungroup(ids)
    groups.delete(request.groupID)
    const anchor = tabs.get(message.tabID)
    send({
      type: "result",
      callID: message.callID,
      tabID: message.tabID,
      generation,
      documentGeneration: anchor.documentGeneration,
      observationRevision: anchor.revision,
      status: "completed",
      title: (await tabInfo(anchor)).title ?? "",
      url: anchor.url,
      groupID: request.groupID,
    })
  } catch (error) {
    fail(message, safeError(error), dispatched)
  }
}

function hasEditableAncestor(node, byId) {
  const seen = new Set()
  let parentId = node.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) return false
    if (editableRoles.has(String(parent.role?.value ?? ""))) return true
    parentId = parent.parentId
  }
  return false
}

function collectFrames(node, output = []) {
  if (!node?.frame) return output
  output.push({ id: node.frame.id, url: node.frame.url })
  for (const child of node.childFrames ?? []) collectFrames(child, output)
  return output
}

async function frameTargets(tab) {
  const allowed = approvedOrigins(tab)
  const sessions = [{ sessionId: undefined, url: tab.url }, ...[...tabSessions(tab).entries()].map(([sessionId, value]) => ({ sessionId, ...value }))]
  await Promise.all(sessions.map((session) => session.ready).filter(Boolean))
  const targets = []
  for (const session of sessions) {
    let frameList
    try {
      const { frameTree } = await command(tab.chromeTabID, "Page.getFrameTree", {}, session.sessionId)
      frameList = collectFrames(frameTree)
    } catch (error) {
      if (!session.sessionId) throw error
      targets.push({ url: session.url || tab.url, readable: false })
      continue
    }
    const failed = session.sessionId ? tabSessions(tab).get(session.sessionId)?.failed : false
    for (const [index, frame] of frameList.entries()) {
      const top = !session.sessionId && index === 0
      const url = frame.url || (top ? tab.url : session.url || tab.url)
      const origin = originOf(url)
      targets.push({
        sessionId: session.sessionId,
        frameId: frame.id,
        url,
        top,
        root: index === 0,
        readable: top || (!!origin && allowed.has(origin) && !failed),
      })
    }
  }
  return targets
}

function axProperty(node, name) {
  return node?.properties?.find((item) => item.name === name)?.value?.value
}

function tristate(value) {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  if (value === "mixed") return "mixed"
  return undefined
}

function booleanState(value) {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return undefined
}

function elementState(node, role, sensitive) {
  const state = {}
  const checked = tristate(axProperty(node, "checked"))
  const pressed = tristate(axProperty(node, "pressed"))
  const expanded = booleanState(axProperty(node, "expanded"))
  const selected = booleanState(axProperty(node, "selected"))
  if (checked !== undefined) state.checked = checked
  if (pressed !== undefined) state.pressed = pressed
  if (expanded !== undefined) state.expanded = expanded
  if (selected !== undefined) state.selected = selected
  const value = valueRoles.has(role) ? node.value?.value : undefined
  if (sensitive) state.sensitive = true
  else if (value !== undefined && value !== null) state.value = String(value).slice(0, 1024)
  return state
}

async function observe(message) {
  let fresh
  try {
    const tab = requireTab(message)
    await isActive(tab)
    fresh = tab.profile && !tab.attached ? tab : undefined
    await controlTabs([tab])
    applyFrameOrigins(tab, message)
    const documentGeneration = tab.documentGeneration
    const targets = await frameTargets(tab)
    tab.revision++
    tab.refs.clear()
    const elements = []
    const texts = []
    const frames = []
    const seen = new Set()
    let candidateCount = 0
    let textCount = 0
    for (const target of targets) {
      const { sessionId, url, top } = target
      if (!target.readable) {
        frames.push({ url, observed: false })
        continue
      }
      let tree
      try {
        tree = await command(
          tab.chromeTabID,
          "Accessibility.getFullAXTree",
          { depth: MAX_AX_DEPTH, ...(target.frameId ? { frameId: target.frameId } : {}) },
          sessionId,
        )
      } catch (error) {
        if (top) throw error
        frames.push({ url, observed: false })
        continue
      }
      if (!top) frames.push({ url, observed: true })
      const inputs = await formInputNodes(tab, target)
      const byId = new Map(tree.nodes.map((item) => [item.nodeId, item]))
      for (const node of tree.nodes) {
        if (node.ignored) continue
        const role = String(node.role?.value ?? "")
        if (textRoles.has(role) && !hasEditableAncestor(node, byId)) {
          const name = String(node.name?.value ?? "").trim()
          if (name) {
            textCount++
            if (texts.length < MAX_TEXTS) texts.push({ role, name, ...(top ? {} : { frame: url }) })
          }
        }
        if (!node.backendDOMNodeId || (!interactiveRoles.has(role) && !inputs.has(node.backendDOMNodeId))) continue
        const key = `${sessionId ?? ""}\0${node.backendDOMNodeId}`
        if (seen.has(key)) continue
        seen.add(key)
        candidateCount++
        if (elements.length >= MAX_ELEMENTS) continue
        let described
        try {
          described = await command(
            tab.chromeTabID,
            "DOM.describeNode",
            { backendNodeId: node.backendDOMNodeId, depth: 0 },
            sessionId,
          )
        } catch {
          continue
        }
        const ref = `b${elements.length + 1}`
        const elementName = String(node.name?.value ?? "")
        tab.refs.set(ref, {
          sessionId,
          backendNodeId: node.backendDOMNodeId,
          frameId: target.frameId,
          url,
          top,
          name: elementName,
        })
        const attributes = attrs(described.node.attributes)
        const href = attributes.get("href")
        const destination = href ? new URL(href, url).toString() : undefined
        const locatorBase = `role=${role}[name=${JSON.stringify(elementName.slice(0, 128))}]`
        const duplicates = elements.filter((candidate) => candidate.locator?.startsWith(locatorBase)).length
        elements.push({
          ref,
          role,
          name: elementName,
          locator: duplicates ? `${locatorBase}|nth=${duplicates}` : locatorBase,
          description: node.description?.value ? String(node.description.value) : undefined,
          disabled: node.properties?.some((item) => item.name === "disabled" && item.value?.value === true) || undefined,
          destination,
          ...elementState(node, role, isSensitiveAttributes(described.node.nodeName, attributes, elementName)),
          ...(top ? {} : { frame: url }),
        })
      }
    }
    const info = await tabInfo(tab)
    if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
      await revokeTab(tab, "navigated")
      return fail(message, "The shared tab changed to an unapproved site")
    }
    if (tab.documentGeneration !== documentGeneration) throw new Error("The shared tab observation is stale")
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
      texts,
      frames: frames.slice(0, MAX_FRAMES),
      truncated: candidateCount > MAX_ELEMENTS || textCount > MAX_TEXTS || frames.length > MAX_FRAMES,
    })
  } catch (error) {
    await abandonFresh(fresh)
    fail(message, safeError(error))
  }
}

async function frameDocumentNode(tab, target) {
  const { root } = await command(tab.chromeTabID, "DOM.getDocument", { depth: 0 }, target.sessionId)
  if (target.root) return root.nodeId
  const document = await controlEvaluate(tab, target, F_DOCUMENT, [], false)
  try {
    const { nodeId } = await command(tab.chromeTabID, "DOM.requestNode", { objectId: document.objectId }, target.sessionId)
    return nodeId
  } finally {
    await command(tab.chromeTabID, "Runtime.releaseObject", { objectId: document.objectId }, target.sessionId).catch(() => {})
  }
}

async function formInputNodes(tab, target) {
  const { sessionId } = target
  const backendNodeIds = new Set()
  try {
    const { nodeIds } = await command(
      tab.chromeTabID,
      "DOM.querySelectorAll",
      { nodeId: await frameDocumentNode(tab, target), selector: FORM_INPUT_SELECTOR },
      sessionId,
    )
    for (const nodeId of (nodeIds ?? []).slice(0, MAX_ELEMENTS)) {
      const { node } = await command(tab.chromeTabID, "DOM.describeNode", { nodeId, depth: 0 }, sessionId)
      if (node?.backendNodeId) backendNodeIds.add(node.backendNodeId)
    }
  } catch {}
  return backendNodeIds
}

async function abandonFresh(tab) {
  if (tab && tabs.get(tab.id) === tab) await releaseControl(tab)
}

async function act(message) {
  let dispatched = false
  let fresh
  try {
    const tab = requireTab(message)
    if (requestedPause) return paused(message, tab)
    await isActive(tab)
    if (tab.documentGeneration !== message.documentGeneration || tab.revision !== message.observationRevision)
      return fail(message, "The shared tab observation is stale")
    if (message.action.type === "group") return groupTabs(message)
    if (message.action.type === "ungroup") return ungroupTabs(message)
    if (!ACTION_TYPES.has(message.action.type)) throw new Error("Unsupported browser action")
    fresh = tab.profile && !tab.attached ? tab : undefined
    if (message.action.type === "dialog" && message.action.accept !== undefined && tab.dialog) {
      dispatched = true
      await command(tab.chromeTabID, "Page.handleJavaScriptDialog", {
        accept: message.action.accept,
        ...(message.action.text === undefined ? {} : { promptText: message.action.text }),
      }, tab.dialog.sessionId).catch(() => {})
      delete tab.dialog
    }
    await controlTabs([tab])
    tab.allowedOrigins = new Set(message.allowedOrigins)
    applyFrameOrigins(tab, message)
    if (
      ["navigate", "click", "type", "fill", "select", "check", "hover", "back", "forward", "reload", "key", "webmcp_invoke"].includes(
        message.action.type,
      )
    )
      tab.downloadSince = Date.now() - 1000
    const markDispatched = () => (dispatched = true)
    let outcome = {}
    if (message.action.type === "navigate") await navigate(tab, message.action.url, markDispatched)
    if (message.action.type === "click") await click(tab, message.action.ref, markDispatched)
    if (message.action.type === "type") await typeText(tab, message.action.ref, message.action.text, markDispatched)
    if (message.action.type === "fill") outcome = await fill(tab, message.action.ref, message.action.text, markDispatched)
    if (message.action.type === "select") outcome = await selectOptions(tab, message.action, markDispatched)
    if (message.action.type === "check") outcome = await setChecked(tab, message.action, markDispatched)
    if (message.action.type === "hover") await hover(tab, message.action.ref, markDispatched)
    if (message.action.type === "scroll") await scroll(tab, message.action.deltaY, () => (dispatched = true))
    if (message.action.type === "back") await history(tab, -1, () => (dispatched = true))
    if (message.action.type === "forward") await history(tab, 1, () => (dispatched = true))
    if (message.action.type === "reload") {
      dispatched = true
      await command(tab.chromeTabID, "Page.reload", {})
    }
    if (message.action.type === "key") await dispatchKey(tab, message.action, () => (dispatched = true))
    if (message.action.type === "wait") outcome = await waitAction(tab, message.action)
    const peripheral = ["clipboard_read", "clipboard_write", "upload", "download", "logs", "export", "webmcp_list", "webmcp_invoke", "dialog"].includes(message.action.type)
      ? await peripheralAction(tab, message.action, () => (dispatched = true))
      : {}
    const captured = message.action.type === "capture" ? await capture(tab, message.action) : undefined
    await isActive(tab)
    const info = await tabInfo(tab)
    if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
      await revokeTab(tab, "navigated")
      throw new Error("The shared tab changed to an unapproved site")
    }
    if (info.url && info.url !== tab.url) {
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
      text: peripheral.text,
      download: peripheral.download,
      logs: peripheral.logs,
      data: peripheral.data,
      webmcpTools: peripheral.webmcpTools,
      dialog: peripheral.dialog,
      control: outcome.control,
      frame: outcome.frame,
      message: outcome.message,
    })
  } catch (error) {
    if (!dispatched) await abandonFresh(fresh)
    fail(message, safeError(error), dispatched)
  }
}

async function attachProfile(tab) {
  if (!tab.profile || tab.attached) return
  if (!pairing?.enabled || socket?.readyState !== WebSocket.OPEN) throw new Error("Profile access is unavailable")
  await chrome.debugger.attach({ tabId: tab.chromeTabID }, PROTOCOL_VERSION)
  await command(tab.chromeTabID, "Emulation.setFocusEmulationEnabled", { enabled: true })
  tab.attached = true
  updateBadge(tab)
  if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, (await chrome.tabs.get(tab.chromeTabID)).url)) {
    await revokeTab(tab, "navigated")
    throw new Error("The profile tab changed to an unapproved site or was revoked")
  }
  await enableTab(tab)
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

async function history(tab, delta, markDispatched) {
  const entries = await command(tab.chromeTabID, "Page.getNavigationHistory")
  const entry = entries.entries?.[entries.currentIndex + delta]
  if (!entry || entry.id === undefined) throw new Error(delta < 0 ? "No earlier page in history" : "No later page in history")
  const url = new URL(entry.url)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !tab.allowedOrigins.has(url.origin))
    throw new Error("History target is not allowed")
  markDispatched()
  await command(tab.chromeTabID, "Page.navigateToHistoryEntry", { entryId: entry.id })
}

async function dispatchKey(tab, action, markDispatched) {
  const modifiers =
    (action.modifiers?.includes("Alt") ? 1 : 0) |
    (action.modifiers?.includes("Control") ? 2 : 0) |
    (action.modifiers?.includes("Meta") ? 4 : 0) |
    (action.modifiers?.includes("Shift") ? 8 : 0)
  const named = namedKeys[action.key]
  const single = typeof action.key === "string" && action.key.length === 1
  if (!named && !single) throw new Error(`Unsupported key: ${String(action.key).slice(0, 32)}`)
  const base = named ?? { key: action.key, code: "", windowsVirtualKeyCode: 0 }
  const text = single && !named && !modifiers
  const safeNavigation =
    !(modifiers & 7) &&
    (modifiers === 8 ? action.key === "Tab" : ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(action.key))
  if (!safeNavigation) await rejectSensitiveFocus(tab)
  markDispatched()
  await command(tab.chromeTabID, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    modifiers,
    ...(text ? { text: action.key } : {}),
  })
  await command(tab.chromeTabID, "Input.dispatchKeyEvent", { type: "keyUp", ...base, modifiers })
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function isSensitiveAttributes(nodeName, attributes, accessibleName = "") {
  const tag = String(nodeName).toLowerCase()
  const editable = attributes.has("contenteditable") && attributes.get("contenteditable") !== "false"
  if (tag !== "input" && tag !== "textarea" && !editable) return false
  if (tag === "input" && (attributes.get("type") ?? "text").toLowerCase() === "password") return true
  if ((attributes.get("autocomplete") ?? "").toLowerCase().split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.includes(token))) return true
  if (["name", "id", "aria-label", "placeholder"].some((key) => SECRET_NAME.test(attributes.get(key) ?? ""))) return true
  return SECRET_NAME.test(normalizeText(accessibleName).slice(0, 256))
}

function rejectSensitiveField(node, accessibleName) {
  const attributes = attrs(node.attributes)
  if (String(node.nodeName).toLowerCase() === "input" && (attributes.get("type") ?? "").toLowerCase() === "file")
    throw new Error("file inputs are unsupported")
  if (isSensitiveAttributes(node.nodeName, attributes, accessibleName))
    throw new Error("Sensitive fields such as passwords, one-time codes, and payment details cannot be filled or typed into")
}

function globMatch(pattern, value) {
  let p = 0
  let v = 0
  let star = -1
  let mark = 0
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++
      v++
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++
      mark = v
    } else if (star !== -1) {
      p = star + 1
      v = ++mark
    } else return false
  }
  while (p < pattern.length && pattern[p] === "*") p++
  return p === pattern.length
}

function parseLocator(locator) {
  const match = LOCATOR.exec(String(locator))
  if (!match) return undefined
  try {
    const name = JSON.parse(match[2])
    return typeof name === "string" ? { role: match[1], name, nth: match[3] ? Number(match[3]) : 0 } : undefined
  } catch {
    return undefined
  }
}

function controlWorld(tab, sessionId, frameId) {
  tab.controlWorlds ??= new Map()
  const key = `${sessionId ?? ""}|${frameId ?? ""}`
  const cached = tab.controlWorlds.get(key)
  if (cached) return cached
  const worlds = tab.controlWorlds
  const world = command(tab.chromeTabID, "Page.createIsolatedWorld", { frameId, worldName: CONTROL_WORLD }, sessionId).then(
    ({ executionContextId }) => executionContextId,
  )
  worlds.set(key, world)
  world.catch(() => {
    if (worlds.get(key) === world) worlds.delete(key)
  })
  return world
}

function forgetControlWorlds(tab, sessionId, frameId) {
  if (!tab.controlWorlds) return
  const prefix = `${sessionId ?? ""}|`
  for (const key of tab.controlWorlds.keys())
    if (frameId === undefined ? key.startsWith(prefix) : key === `${prefix}${frameId}`) tab.controlWorlds.delete(key)
}

function controlCall(tab, target, functionDeclaration, values = []) {
  return controlEvaluate(tab, target, functionDeclaration, values, true).then((result) => result?.value)
}

async function controlEvaluate(tab, target, functionDeclaration, values, returnByValue) {
  const run = async () => {
    const executionContextId = await controlWorld(tab, target.sessionId, target.frameId)
    const params = { functionDeclaration, arguments: values.map((value) => ({ value })), returnByValue }
    if (target.backendNodeId === undefined) params.executionContextId = executionContextId
    else {
      const { object } = await command(
        tab.chromeTabID,
        "DOM.resolveNode",
        { backendNodeId: target.backendNodeId, executionContextId },
        target.sessionId,
      )
      params.objectId = object?.objectId
    }
    const response = await command(tab.chromeTabID, "Runtime.callFunctionOn", params, target.sessionId)
    if (response?.exceptionDetails) throw new Error("A page control function failed")
    return response?.result
  }
  return run().catch((error) => {
    if (!/Cannot find context/i.test(error instanceof Error ? error.message : String(error))) throw error
    forgetControlWorlds(tab, target.sessionId, target.frameId)
    return run()
  })
}

function controlOutput(value) {
  if (!value || typeof value !== "object") return {}
  if (value.sensitive === true) return { sensitive: true }
  const output = {}
  const checked = tristate(value.checked)
  if (checked !== undefined) output.checked = checked
  if (typeof value.value === "string") output.value = value.value.slice(0, 1024)
  if (Array.isArray(value.selected))
    output.selected = value.selected.slice(0, MAX_SELECT_OPTIONS).map((option) => ({
      ...(typeof option?.value === "string" ? { value: option.value.slice(0, 1024) } : {}),
      label: String(option?.label ?? "").slice(0, 1024),
      index: Number(option?.index),
    }))
  return output
}

function describeTarget(tab, target) {
  return command(tab.chromeTabID, "DOM.describeNode", { backendNodeId: target.backendNodeId, depth: 0 }, target.sessionId)
}

function assertCurrent(tab, documentGeneration) {
  if (tabs.get(tab.id) !== tab || tab.documentGeneration !== documentGeneration)
    throw new Error("The shared tab observation is stale")
}

async function elementPoint(tab, target) {
  await command(tab.chromeTabID, "DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, target.sessionId)
  const { quads } = await command(tab.chromeTabID, "DOM.getContentQuads", { backendNodeId: target.backendNodeId }, target.sessionId)
  const quad = quads?.[0]
  if (!quad) throw new Error("Element is not visible")
  return mainPoint(tab, target, quad)
}

async function axNode(tab, target) {
  const { nodes } = await command(
    tab.chromeTabID,
    "Accessibility.getPartialAXTree",
    { backendNodeId: target.backendNodeId, fetchRelatives: false },
    target.sessionId,
  )
  const node = nodes?.find((item) => item.backendDOMNodeId === target.backendNodeId) ?? nodes?.[0]
  if (!node) throw new Error("Element is not in the accessibility tree")
  return node
}

async function settle(read, done) {
  const deadline = Date.now() + CONTROL_SETTLE_MS
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await sleep(50)
    value = await read()
  }
  return value
}

async function click(tab, ref, markDispatched) {
  await clickTarget(tab, requireRef(tab, ref), markDispatched, LABELS.click)
}

async function clickTarget(tab, target, markDispatched, label) {
  const documentGeneration = tab.documentGeneration
  const described = await describeTarget(tab, target)
  const attributes = attrs(described.node.attributes)
  if (attributes.has("download")) throw new Error("Explicit download links are unsupported")
  if (attributes.get("target") && attributes.get("target") !== "_self")
    throw new Error("New tabs and popups are unsupported")
  const href = attributes.get("href")
  if (href) {
    const url = new URL(href, target.url || tab.url)
    if (!["http:", "https:"].includes(url.protocol) || !tab.allowedOrigins.has(url.origin))
      throw new Error("Link destination is not allowed")
  }
  rejectProtectedInput(described.node)
  const { x, y } = await elementPoint(tab, target)
  assertCurrent(tab, documentGeneration)
  await moveCursor(tab, x, y, label, true)
  markDispatched()
  for (const type of ["mousePressed", "mouseReleased"])
    await inputCommand(tab, { type, x, y, button: "left", clickCount: 1 })
}

async function fill(tab, ref, text, markDispatched) {
  const documentGeneration = tab.documentGeneration
  const target = requireRef(tab, ref)
  if (typeof text !== "string") throw new Error("Fill requires text")
  const described = await describeTarget(tab, target)
  rejectSensitiveField(described.node, target.name)
  const planned = await controlCall(tab, target, F_FILL, [text, false])
  if (!planned?.kind) throw new Error(planned?.error ?? "Element cannot be filled")
  const { x, y } = await elementPoint(tab, target)
  assertCurrent(tab, documentGeneration)
  await moveCursor(tab, x, y, LABELS.type)
  markDispatched()
  const applied = await controlCall(tab, target, F_FILL, [text, true])
  if (!applied?.kind) throw new Error(applied?.error ?? "Element cannot be filled")
  if (applied.kind === "insert" && text) await command(tab.chromeTabID, "Input.insertText", { text }, target.sessionId)
  if (applied.kind === "insert" && !text)
    for (const type of ["keyDown", "keyUp"])
      await command(tab.chromeTabID, "Input.dispatchKeyEvent", { type, ...namedKeys.Delete }, target.sessionId)
  const control = controlOutput(await controlCall(tab, target, F_CONTROL_STATE))
  return control.sensitive || control.value === text
    ? { control }
    : { control, message: "The field value differs from the requested text" }
}

function selectCriteria(action) {
  const keys = ["values", "labels", "indexes"].filter((key) => action[key] !== undefined)
  const list = action[keys[0]]
  if (keys.length !== 1 || !Array.isArray(list) || !list.length || list.length > MAX_SELECT_OPTIONS)
    throw new Error("Select takes one list of values, labels, or indexes")
  return { [keys[0]]: list }
}

async function selectOptions(tab, action, markDispatched) {
  const documentGeneration = tab.documentGeneration
  const target = requireRef(tab, action.ref)
  const criteria = selectCriteria(action)
  const described = await describeTarget(tab, target)
  if (String(described.node.nodeName).toLowerCase() !== "select") return selectListOption(tab, target, criteria, markDispatched)
  const checked = await controlCall(tab, target, F_SELECT, [criteria, false])
  if (!checked?.ok) throw new Error(checked?.error ?? "Select failed")
  const { x, y } = await elementPoint(tab, target)
  assertCurrent(tab, documentGeneration)
  await moveCursor(tab, x, y, LABELS.select)
  markDispatched()
  const applied = await controlCall(tab, target, F_SELECT, [criteria, true])
  if (!applied?.ok) throw new Error(applied?.error ?? "Select failed")
  return { control: controlOutput(await controlCall(tab, target, F_CONTROL_STATE)) }
}

async function selectListOption(tab, target, criteria, markDispatched) {
  const node = await axNode(tab, target)
  const role = String(node.role?.value ?? "")
  let listbox = target.backendNodeId
  if (role === "combobox") {
    if (booleanState(axProperty(node, "expanded")) !== true) throw new Error("Open the list first, observe, then select")
    listbox = node.properties?.find((item) => item.name === "controls")?.value?.relatedNodes?.[0]?.backendDOMNodeId
    if (!listbox) throw new Error("The combobox does not control a listbox")
  } else if (role !== "listbox") throw new Error("Element is not a select or listbox")
  if (criteria.values) throw new Error("Listbox options are selected by labels or indexes")
  const wanted = criteria.labels ?? criteria.indexes
  if (wanted.length !== 1) throw new Error("A listbox selects one option at a time")
  const { nodes } = await command(
    tab.chromeTabID,
    "Accessibility.queryAXTree",
    { backendNodeId: listbox, role: "option" },
    target.sessionId,
  )
  const options = (nodes ?? []).filter((item) => !item.ignored && item.role?.value === "option" && item.backendDOMNodeId)
  const index = criteria.labels
    ? options.findIndex((item) => normalizeText(item.name?.value) === normalizeText(criteria.labels[0]))
    : criteria.indexes[0]
  const option = options[index]
  if (!option) throw new Error("Option not found")
  if (booleanState(axProperty(option, "disabled")) === true) throw new Error("Option is disabled")
  const chosen = { label: normalizeText(option.name?.value).slice(0, 1024), index }
  if (booleanState(axProperty(option, "selected")) === true) return { control: { selected: [chosen] } }
  const optionTarget = { ...target, backendNodeId: option.backendDOMNodeId }
  await clickTarget(tab, optionTarget, markDispatched, LABELS.select)
  const selected = await settle(
    async () => booleanState(axProperty(await axNode(tab, optionTarget).catch(() => undefined), "selected")) === true,
    (value) => value,
  )
  return selected
    ? { control: { selected: [chosen] } }
    : { control: { selected: [] }, message: "The control did not change state" }
}

async function setChecked(tab, action, markDispatched) {
  const target = requireRef(tab, action.ref)
  if (typeof action.checked !== "boolean") throw new Error("Check requires checked:true or checked:false")
  const node = await axNode(tab, target)
  const role = String(node.role?.value ?? "")
  const state = tristate(axProperty(node, "checked"))
  if (state === undefined) throw new Error("Element has no checked state")
  if (state === action.checked) return { control: { checked: state } }
  if (!action.checked && (role === "radio" || role === "menuitemradio"))
    throw new Error("A radio option cannot be unchecked; check another option instead")
  await clickTarget(tab, target, markDispatched, LABELS.click)
  const observed = await settle(
    async () => tristate(axProperty(await axNode(tab, target).catch(() => undefined), "checked")),
    (value) => value === action.checked,
  )
  const control = observed === undefined ? {} : { checked: observed }
  return observed === action.checked ? { control } : { control, message: "The control did not change state" }
}

async function rejectSensitiveFocus(tab) {
  let target = await mainFrameTarget(tab)
  for (let depth = 0; depth <= MAX_FRAMES; depth++) {
    const focused = await controlEvaluate(tab, target, F_FOCUSED, [], false)
    if (typeof focused?.objectId !== "string" || !focused.objectId)
      throw new Error("Editing keys require an inspectable focused target")
    const sessionId = target.sessionId
    try {
      const { node } = await command(
        tab.chromeTabID,
        "DOM.describeNode",
        { objectId: focused.objectId, depth: 1, pierce: true },
        target.sessionId,
      )
      if (
        node?.nodeType !== 1 ||
        typeof node.nodeName !== "string" ||
        !node.nodeName.trim() ||
        !Number.isSafeInteger(node.backendNodeId) ||
        node.backendNodeId <= 0 ||
        !Array.isArray(node.attributes) ||
        node.attributes.length % 2 !== 0 ||
        !node.attributes.every((attribute) => typeof attribute === "string") ||
        (node.shadowRoots !== undefined && (
          !Array.isArray(node.shadowRoots) ||
          node.shadowRoots.some((root) => !root || typeof root !== "object" || Array.isArray(root) || !["open", "closed", "user-agent"].includes(root.shadowRootType))
        ))
      ) throw new Error("The focused target could not be inspected as an element")
      const connected = await command(tab.chromeTabID, "Runtime.callFunctionOn", {
        functionDeclaration: F_CONNECTED,
        objectId: focused.objectId,
        returnByValue: true,
      }, sessionId)
      if (connected?.exceptionDetails || connected?.result?.value !== true)
        throw new Error("Editing keys require an attached focused target")
      if (node.shadowRoots?.some((root) => root.shadowRootType === "closed"))
        throw new Error("Editing keys cannot be sent while focus is inside a closed shadow root")
      const nodeName = node.nodeName.toLowerCase()
      if (nodeName === "object" || nodeName === "embed")
        throw new Error("Editing keys cannot be sent to an unverified embedded target")
      if (nodeName === "iframe" || nodeName === "frame") {
        const child = [...tabSessions(tab)].find(([, session]) => node.frameId && session.targetId === node.frameId)
        if (!child || child[1].failed || !approvedOrigins(tab).has(originOf(child[1].url)))
          throw new Error("Editing keys cannot be sent while focus is in a frame YCoding cannot inspect")
        target = { sessionId: child[0], frameId: node.frameId }
        continue
      }
      const { nodes } = await command(
        tab.chromeTabID,
        "Accessibility.getPartialAXTree",
        { objectId: focused.objectId, fetchRelatives: false },
        target.sessionId,
      )
      const accessible = Array.isArray(nodes) ? nodes.find((item) => item?.backendDOMNodeId === node.backendNodeId) : undefined
      if (typeof accessible?.name?.value !== "string")
        throw new Error("The focused target cannot be inspected in the accessibility tree")
      rejectSensitiveField(node, accessible.name.value)
      if ((await controlCall(tab, { ...target, backendNodeId: node.backendNodeId }, F_SENSITIVE_ELEMENT)) !== false)
        throw new Error("Sensitive fields such as passwords, one-time codes, and payment details cannot be filled or typed into")
      return
    } finally {
      await command(tab.chromeTabID, "Runtime.releaseObject", { objectId: focused.objectId }, sessionId).catch(() => {})
    }
  }
  throw new Error("Editing keys cannot be sent while focus is in a frame YCoding cannot inspect")
}

async function hover(tab, ref, markDispatched) {
  const documentGeneration = tab.documentGeneration
  const target = requireRef(tab, ref)
  await describeTarget(tab, target)
  const { x, y } = await elementPoint(tab, target)
  assertCurrent(tab, documentGeneration)
  await moveCursor(tab, x, y, LABELS.hover)
  markDispatched()
  await inputCommand(tab, { type: "mouseMoved", x, y })
}

async function visibleNode(tab, target) {
  const response = await command(
    tab.chromeTabID,
    "DOM.getContentQuads",
    { backendNodeId: target.backendNodeId },
    target.sessionId,
  ).catch(() => undefined)
  return (response?.quads ?? []).some((quad) => {
    if (!Array.isArray(quad) || quad.length < 8) return false
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    return Math.max(...xs) - Math.min(...xs) > 0 && Math.max(...ys) - Math.min(...ys) > 0
  })
}

async function connectedNode(tab, target) {
  return controlCall(tab, target, F_CONNECTED).then(
    (value) => value === true,
    () => false,
  )
}

async function targetState(tab, target, state) {
  const attached = !!target && (await connectedNode(tab, target))
  if (state === "attached") return attached
  if (state === "detached") return !attached
  const visible = attached && (await visibleNode(tab, target))
  return state === "visible" ? visible : !visible
}

async function locatorMatches(tab, locator) {
  const matches = []
  for (const frame of await frameTargets(tab)) {
    if (!frame.readable) continue
    let tree
    try {
      tree = await command(
        tab.chromeTabID,
        "Accessibility.getFullAXTree",
        { depth: MAX_AX_DEPTH, ...(frame.frameId ? { frameId: frame.frameId } : {}) },
        frame.sessionId,
      )
    } catch (error) {
      if (frame.top) throw error
      continue
    }
    for (const node of tree.nodes ?? []) {
      if (node.ignored || !node.backendDOMNodeId || String(node.role?.value ?? "") !== locator.role) continue
      if (String(node.name?.value ?? "").slice(0, 128) !== locator.name) continue
      matches.push({ sessionId: frame.sessionId, backendNodeId: node.backendDOMNodeId, frameId: frame.frameId, url: frame.url, top: frame.top })
    }
  }
  return matches
}

async function mainFrameTarget(tab) {
  const { frameTree } = await command(tab.chromeTabID, "Page.getFrameTree")
  return { sessionId: undefined, frameId: frameTree.frame.id }
}

function matchedFrame(target) {
  return target && !target.top ? { frame: target.url } : {}
}

function waitCondition(tab, action, started) {
  const targeted = action.ref !== undefined || action.locator !== undefined
  const conditions = [targeted, action.url !== undefined, action.load !== undefined, action.text !== undefined].filter(Boolean)
  if (conditions.length > 1 || (action.state !== undefined && !targeted)) throw new Error("Wait takes one condition")
  if (action.state !== undefined && !WAIT_STATES.has(action.state)) throw new Error("Unsupported wait state")
  if (action.ref !== undefined) {
    requireRef(tab, action.ref)
    const state = action.state ?? "attached"
    return {
      subject: "the element",
      interval: 250,
      check: async () => {
        const target = tab.refs.get(action.ref)
        return (await targetState(tab, target, state)) && (state === "attached" || state === "visible" ? matchedFrame(target) : {})
      },
    }
  }
  if (action.locator !== undefined) {
    const locator = parseLocator(action.locator)
    if (!locator) throw new Error("Locator is malformed")
    const state = action.state ?? "visible"
    return {
      subject: "the element",
      interval: 250,
      check: async () => {
        const matches = await locatorMatches(tab, locator).catch(() => undefined)
        if (!matches) return false
        const target = matches[locator.nth]
        if (state === "attached") return !!target && matchedFrame(target)
        if (state === "detached") return !target && {}
        const visible = !!target && (await visibleNode(tab, target))
        return state === "visible" ? visible && matchedFrame(target) : !visible && {}
      },
    }
  }
  if (action.url !== undefined) {
    if (typeof action.url !== "string" || !action.url) throw new Error("Wait URL pattern is empty")
    return {
      subject: "the URL",
      interval: 100,
      check: async () => {
        const info = await tabInfo(tab)
        if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
          await revokeTab(tab, "navigated")
          throw new Error("The shared tab changed to an unapproved site")
        }
        const page = safePage(info.url)
        return globMatch(action.url, `${page.origin}${page.path}`) && {}
      },
    }
  }
  if (action.text !== undefined) {
    if (typeof action.text !== "string" || !action.text) throw new Error("Wait text is empty")
    return {
      subject: "the text",
      interval: 250,
      check: async () => {
        for (const frame of await frameTargets(tab)) {
          if (!frame.readable) continue
          const present = await controlCall(tab, { sessionId: frame.sessionId, frameId: frame.frameId }, F_TEXT_PRESENT, [action.text]).catch(
            () => false,
          )
          if (present === true) return matchedFrame(frame)
        }
        return false
      },
    }
  }
  const load = action.load ?? "load"
  if (!LOAD_STATES.has(load)) throw new Error("Unsupported load state")
  if (load === "networkidle")
    return {
      subject: "network idle",
      interval: 100,
      check: async () => {
        if (networkUntracked(tab)) throw new Error("Network activity cannot be tracked in a frame of this page")
        if (pendingRequests(tab)) return false
        return Date.now() - Math.max(started, tab.networkQuietSince ?? 0) >= NETWORK_IDLE_MS && {}
      },
    }
  return {
    subject: "the page to load",
    interval: 100,
    check: async () => {
      const state = await controlCall(tab, await mainFrameTarget(tab), F_READY).catch(() => undefined)
      return (load === "load" ? state === "complete" : state === "interactive" || state === "complete") && {}
    },
  }
}

async function waitAction(tab, action) {
  const timeout = Math.min(Math.max(action.timeoutMs ?? 5000, 0), MAX_WAIT_MS)
  const started = Date.now()
  const deadline = started + timeout
  const condition = waitCondition(tab, action, started)
  for (;;) {
    const met = await condition.check()
    if (met) return met
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${condition.subject}`)
    await sleep(condition.interval)
  }
}

async function scroll(tab, deltaY, markDispatched) {
  const { layoutViewport } = await command(tab.chromeTabID, "Page.getLayoutMetrics")
  const x = (layoutViewport?.clientWidth ?? 0) / 2
  const y = (layoutViewport?.clientHeight ?? 0) / 2
  await moveCursor(tab, x, y, LABELS.scroll)
  markDispatched()
  await inputCommand(tab, { type: "mouseWheel", x, y, deltaX: 0, deltaY })
}

function forgetDocument(tab) {
  tab.world = undefined
  tab.fontInstalled = false
  tab.controlWorlds = undefined
}

function isolatedWorld(tab) {
  tab.world ??= createWorld(tab).catch((error) => {
    tab.world = undefined
    throw error
  })
  return tab.world
}

async function createWorld(tab) {
  const { frameTree } = await command(tab.chromeTabID, "Page.getFrameTree")
  const { executionContextId } = await command(tab.chromeTabID, "Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: CURSOR_WORLD,
  })
  return executionContextId
}

async function pageEvaluate(tab, expression, extra = {}) {
  const run = async () =>
    command(tab.chromeTabID, "Runtime.evaluate", {
      expression,
      contextId: await isolatedWorld(tab),
      returnByValue: true,
      ...extra,
    })
  return run().catch((error) => {
    tab.world = undefined
    if (!/Cannot find context/i.test(error instanceof Error ? error.message : String(error))) throw error
    return run()
  })
}

async function mainWorldEvaluate(tab, expression, sessionId) {
  const response = await command(
    tab.chromeTabID,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Page evaluation failed"
    throw new Error(String(detail).slice(0, 1024))
  }
  return response.result?.value
}

function modelContextExpression(body) {
  return `(async () => { const mc = (typeof document !== "undefined" && document.modelContext) || (typeof navigator !== "undefined" && navigator.modelContext) || undefined; if (!mc) return { supported: false }; ${body} })()`
}

async function peripheralAction(tab, action, markDispatched) {
  if (action.type === "dialog") {
    if (action.accept === undefined) {
      if (!tab.dialog) throw new Error("No JavaScript dialog is open on this tab")
      const { sessionId: _sessionId, ...dialog } = tab.dialog
      return { dialog }
    }
    if (tab.dialog) {
      markDispatched()
      await command(tab.chromeTabID, "Page.handleJavaScriptDialog", {
        accept: action.accept,
        ...(action.text === undefined ? {} : { promptText: action.text }),
      }, tab.dialog.sessionId)
      delete tab.dialog
    }
    return {}
  }
  if (action.type === "clipboard_read") {
    await assertPageCaptureSafe(tab)
    const text = await mainWorldEvaluate(tab, "navigator.clipboard.readText()").catch((error) => {
      throw new Error(`Clipboard read is unavailable on this page: ${safeError(error)}`)
    })
    if (typeof text !== "string") throw new Error("Clipboard read did not return text")
    if (new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) throw new Error("Clipboard text exceeds the 64 KiB limit")
    return { text }
  }
  if (action.type === "clipboard_write") {
    markDispatched()
    await mainWorldEvaluate(tab, `navigator.clipboard.writeText(${JSON.stringify(action.text)})`).catch((error) => {
      throw new Error(`Clipboard write is unavailable on this page: ${safeError(error)}`)
    })
    return {}
  }
  if (action.type === "upload") {
    const target = requireRef(tab, action.ref)
    const described = await command(
      tab.chromeTabID,
      "DOM.describeNode",
      { backendNodeId: target.backendNodeId, depth: 0 },
      target.sessionId,
    )
    const type = (attrs(described.node.attributes).get("type") ?? "").toLowerCase()
    if (String(described.node.nodeName).toLowerCase() !== "input" || type !== "file")
      throw new Error("Upload target is not a file input")
    if (!Array.isArray(action.paths) || !action.paths.length || action.paths.length > MAX_UPLOAD_FILES)
      throw new Error("Upload requires between one and eight files")
    markDispatched()
    await command(
      tab.chromeTabID,
      "DOM.setFileInputFiles",
      { backendNodeId: target.backendNodeId, files: action.paths },
      target.sessionId,
    )
    return {}
  }
  if (action.type === "download") {
    await optionalPermission("downloads")
    if (!chrome.downloads?.search) throw new Error("Chrome downloads are unavailable")
    const timeout = Math.min(Math.max(action.timeoutMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS)
    const deadline = Date.now() + timeout
    const since = tab.downloadSince ?? 0
    for (;;) {
      const items = (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 10 })) ?? []
      const item = items.find((candidate) => {
        const started = candidate.startTime ? Date.parse(candidate.startTime) : Number.NaN
        if (Number.isFinite(started) && started < since) return false
        if (!candidate.referrer) return true
        try {
          const origin = new URL(candidate.referrer).origin
          return origin === new URL(tab.url).origin || tabFrameOrigins(tab).has(origin) || tab.allowedOrigins.has(origin)
        } catch {
          return false
        }
      })
      if (item?.state === "complete")
        return {
          download: {
            filename: String(item.filename ?? "").slice(0, 1024),
            state: String(item.state).slice(0, 32),
            bytesReceived: item.bytesReceived,
            totalBytes: item.totalBytes,
            mime: item.mime ? String(item.mime).slice(0, 128) : undefined,
          },
        }
      if (item?.state === "interrupted") throw new Error("The latest download was interrupted")
      if (Date.now() >= deadline) throw new Error("Timed out waiting for a download")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (action.type === "logs") {
    const limit = Math.min(Math.max(action.limit ?? MAX_LOG_ENTRIES, 1), MAX_LOG_ENTRIES)
    return { logs: tabLogs(tab).slice(-limit) }
  }
  if (action.type === "export") {
    const { data } = await command(tab.chromeTabID, "Page.captureSnapshot", { format: "mhtml" })
    if (typeof data !== "string" || !data) throw new Error("Chrome did not return MHTML data")
    if (new TextEncoder().encode(data).byteLength > MAX_EXPORT_BYTES) throw new Error("Export exceeds the 8 MiB limit")
    return { data }
  }
  if (action.type === "webmcp_list") {
    const value = await mainWorldEvaluate(
      tab,
      modelContextExpression(
        "const tools = typeof mc.getTools === 'function' ? await mc.getTools() : (mc.tools ?? []); return { supported: true, tools: [...tools].map((tool) => ({ name: String(tool?.name ?? ''), description: String(tool?.description ?? '') })) };",
      ),
    )
    if (!value?.supported) throw new Error("WebMCP is not available on this page")
    const tools = (Array.isArray(value.tools) ? value.tools : [])
      .filter((tool) => tool?.name)
      .slice(0, MAX_LOG_ENTRIES)
      .map((tool) => ({
        name: String(tool.name).slice(0, 128),
        ...(tool.description ? { description: String(tool.description).slice(0, 1024) } : {}),
      }))
    tab.webmcpTools = tools.map((tool) => tool.name)
    return { webmcpTools: tools }
  }
  if (action.type === "webmcp_invoke") {
    const listed = await peripheralAction(tab, { type: "webmcp_list" }, () => {})
    if (!listed.webmcpTools?.some((tool) => tool.name === action.name)) throw new Error("WebMCP tool is no longer available on this page")
    markDispatched()
    const value = await mainWorldEvaluate(
      tab,
      modelContextExpression(
        `if (typeof mc.executeTool === 'function') return { supported: true, result: await mc.executeTool(${JSON.stringify(action.name)}, ${JSON.stringify(action.arguments ?? {})}) }; if (typeof mc.callTool === 'function') return { supported: true, result: await mc.callTool(${JSON.stringify(action.name)}, ${JSON.stringify(action.arguments ?? {})}) }; return { supported: true, unsupportedInvoke: true };`,
      ),
    )
    if (!value?.supported) throw new Error("WebMCP is not available on this page")
    if (value.unsupportedInvoke) throw new Error("WebMCP invocation is not supported on this page")
    const text = typeof value.result === "string" ? value.result : (JSON.stringify(value.result) ?? "")
    if (new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) throw new Error("WebMCP result exceeds the 64 KiB limit")
    return { text }
  }
  return {}
}

function bounded(promise, milliseconds, message) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds)
    }),
  ]).finally(() => clearTimeout(timeout))
}

async function inputCommand(tab, params) {
  let timeout
  try {
    await Promise.race([
      command(tab.chromeTabID, "Input.dispatchMouseEvent", params),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Chrome did not acknowledge browser input")), INPUT_COMMAND_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function typeText(tab, ref, text, markDispatched) {
  const documentGeneration = tab.documentGeneration
  const target = requireRef(tab, ref)
  const described = await describeTarget(tab, target)
  rejectSensitiveField(described.node, target.name)
  assertCurrent(tab, documentGeneration)
  const { x, y } = await elementPoint(tab, target)
  await moveCursor(tab, x, y, LABELS.type)
  markDispatched()
  await command(tab.chromeTabID, "DOM.focus", { backendNodeId: target.backendNodeId }, target.sessionId)
  await command(tab.chromeTabID, "Input.insertText", { text }, target.sessionId)
}

async function moveCursor(tab, x, y, label, click = false) {
  await bounded(mark(tab, { x, y, label, click }), CURSOR_COMMAND_TIMEOUT_MS, "Cursor placement timed out").catch(() => {})
}

function serialize(tab, work) {
  const run = (tab.markerWork ?? Promise.resolve()).then(work)
  tab.markerWork = run.catch(() => {})
  return run
}

async function mark(tab, cursor) {
  const epoch = tab.controlEpoch
  const controlled = () => tab.controlEpoch === epoch && tab.attached && tabs.get(tab.id) === tab
  const ok = await serialize(tab, async () => {
    if (!controlled()) return false
    const documentGeneration = tab.documentGeneration
    const font = cursor && !tab.fontInstalled ? geistSans : undefined
    const applied = await bounded(
      pageEvaluate(tab, markerScript("mark", cursor, font), { awaitPromise: true }),
      timing.mark,
      "Control marker timed out",
    ).then(
      ({ result }) => {
        if (cursor && result?.value?.font === true && tab.documentGeneration === documentGeneration) tab.fontInstalled = true
        return result?.value?.ok === true
      },
      () => false,
    )
    return applied && controlled()
  })
  if (ok) tab.marked = true
  syncRefreshTimer()
  return ok
}

async function clearMarker(tab) {
  tab.controlEpoch = (tab.controlEpoch ?? 0) + 1
  tab.marked = false
  syncRefreshTimer()
  if (!tab.attached) return
  await bounded(
    serialize(tab, () => pageEvaluate(tab, markerScript("clear"))),
    timing.clear,
    "Control marker cleanup timed out",
  ).catch(() => {})
  forgetDocument(tab)
}

async function ensureControlled(tab) {
  const info = await chrome.tabs.get(tab.chromeTabID)
  if (info.pinned) throw new Error("Pinned tabs cannot show the YCoding control marker; unpin the tab first")
  await attachProfile(tab)
  if (!(await mark(tab))) throw new Error(MARKER_FAILED)
}

async function controlTabs(list) {
  const fresh = list.filter((tab) => tab.profile && !tab.attached)
  try {
    for (const tab of list) await ensureControlled(tab)
  } catch (error) {
    await Promise.all(fresh.filter((tab) => tabs.get(tab.id) === tab).map(releaseControl))
    throw error
  }
}

async function releaseControl(tab) {
  await clearMarker(tab)
  tab.attached = false
  await chrome.debugger.detach({ tabId: tab.chromeTabID }).catch(() => {})
  clearBadge(tab.chromeTabID)
  tab.revision = 0
  tab.refs.clear()
  tabSessions(tab).clear()
  clearRequests(tab)
  tab.logs = []
}

async function relinquish(message) {
  try {
    requireConnection()
    if (message.generation !== generation) throw new Error("Stale bridge generation")
    const tab = tabs.get(message.tabID)
    if (tab && !tab.profile) throw new Error("Only paired profile tab control can be released")
    if (tab) await releaseControl(tab)
    send({ type: "relinquished", callID: message.callID, tabID: message.tabID, generation })
  } catch (error) {
    fail(message, safeError(error))
  }
}

function syncRefreshTimer() {
  const needed = [...tabs.values()].some((tab) => tab.marked)
  if (needed && !refreshTimer) refreshTimer = setInterval(refreshMarkers, timing.refresh)
  if (!needed && refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}

function refreshMarkers() {
  return Promise.all([...tabs.values()].filter((tab) => tab.marked && tab.attached).map((tab) => mark(tab)))
}

async function assertPageCaptureSafe(tab) {
  const sessions = [undefined, ...tabSessions(tab).keys()]
  let missing = 0
  for (const sessionId of sessions) {
    const { root } = await command(
      tab.chromeTabID,
      "DOM.getDocument",
      { depth: MAX_CAPTURE_INSPECTION_DEPTH, pierce: true },
      sessionId,
    )
    missing += inspectCaptureSafe(root)
  }
  if (missing !== tabSessions(tab).size) throw incompleteCaptureInspection()
}

async function capture(tab, action = {}) {
  await assertPageCaptureSafe(tab)
  let clip = action.clip
  if (action.ref) {
    const target = requireRef(tab, action.ref)
    await command(tab.chromeTabID, "DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, target.sessionId)
    const { quads } = await command(tab.chromeTabID, "DOM.getContentQuads", { backendNodeId: target.backendNodeId }, target.sessionId)
    const quad = quads?.[0]
    if (!Array.isArray(quad) || quad.length < 8) throw new Error("Capture target has no visible bounds")
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    clip = {
      x: Math.max(0, Math.floor(Math.min(...xs))),
      y: Math.max(0, Math.floor(Math.min(...ys))),
      width: Math.max(1, Math.ceil(Math.max(...xs) - Math.min(...xs))),
      height: Math.max(1, Math.ceil(Math.max(...ys) - Math.min(...ys))),
    }
  }
  const { data } = await command(tab.chromeTabID, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
    ...(action.fullPage ? { captureBeyondViewport: true } : {}),
  })
  const bytes = Math.floor((data.length * 3) / 4)
  if (bytes > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds the 1 MiB limit")
  return { mediaType: "image/png", data, bytes }
}

function inspectCaptureSafe(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) throw incompleteCaptureInspection()
  const pending = [{ node: root, depth: 0 }]
  let inspected = 0
  let missing = 0
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
    if (String(current.node.nodeName).toLowerCase() === "iframe" && !contentDocument.length) missing++
    const nested = [...children, ...shadowRoots, ...contentDocument]
    if (current.depth >= MAX_CAPTURE_INSPECTION_DEPTH && nested.length) throw incompleteCaptureInspection()
    pending.push(...nested.map((node) => ({ node, depth: current.depth + 1 })))
  }
  return missing
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
  const target = tab.refs.get(ref)
  if (!target) throw new Error("Semantic element reference is stale")
  return target
}

async function mainPoint(tab, target, quad) {
  const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
  const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  if (!target.sessionId) return { x: cx, y: cy }
  const owner = await command(tab.chromeTabID, "DOM.getFrameOwner", { frameId: target.frameId })
  const { quads } = await command(tab.chromeTabID, "DOM.getContentQuads", { backendNodeId: owner.backendNodeId })
  const frame = quads?.[0]
  if (!frame) throw new Error("Element is not visible")
  const { layoutViewport } = await command(tab.chromeTabID, "Page.getLayoutMetrics", {}, target.sessionId)
  const width = Math.max(frame[2], frame[4]) - Math.min(frame[0], frame[6])
  const height = Math.max(frame[5], frame[7]) - Math.min(frame[1], frame[3])
  const scaleX = layoutViewport?.clientWidth ? width / layoutViewport.clientWidth : 1
  const scaleY = layoutViewport?.clientHeight ? height / layoutViewport.clientHeight : 1
  return { x: Math.min(frame[0], frame[6]) + cx * scaleX, y: Math.min(frame[1], frame[3]) + cy * scaleY }
}

function rejectProtectedInput(node) {
  if (String(node.nodeName).toLowerCase() !== "input") return
  const type = (attrs(node.attributes).get("type") ?? "text").toLowerCase()
  if (["password", "file"].includes(type)) throw new Error(`${type} inputs are unsupported`)
}

async function isActive(tab) {
  const info = await tabInfo(tab)
  if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
    await revokeTab(tab, "navigated")
    throw new Error("The shared tab changed to an unapproved site")
  }
  tab.active = info.active
  updateBadge(tab)
  return tab.active
}

async function tabInfo(tab) {
  const info = await chrome.tabs.get(tab.chromeTabID)
  if (!tab.owned) return info
  let history
  for (let attempt = 0; ; attempt++) {
    try {
      history = await command(tab.chromeTabID, "Page.getNavigationHistory")
      break
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes("Not attached to an active page") || attempt >= 40)
        throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const entry = history.entries[history.currentIndex] ?? history.entries.at(-1)
  const title = entry?.title ?? ""
  return { active: info.active, title, url: entry?.url }
}

async function removeInactive(chromeTabID) {
  const info = await chrome.tabs.get(chromeTabID).catch(() => undefined)
  if (info && !info.active) await chrome.tabs.remove(chromeTabID).catch(() => {})
}

async function waitForOwnedPage(tab) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (tabs.get(tab.id) !== tab) throw new Error("Created tab was revoked")
    try {
      const info = await tabInfo(tab)
      if (info.url && info.url !== "about:blank") return info
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes("Not attached to an active page"))
        throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Created tab did not finish navigation")
}

function command(chromeTabID, method, params = {}, sessionId) {
  return chrome.debugger.sendCommand(
    sessionId ? { tabId: chromeTabID, sessionId } : { tabId: chromeTabID },
    method,
    params,
  )
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
    message: "Chrome bridge is paused",
  })
}

async function stop(disconnected) {
  clearInterval(heartbeatTimer)
  const attached = [...tabs.values()]
  tabs.clear()
  chromeTabs.clear()
  syncRefreshTimer()
  for (const tab of attached) {
    clearBadge(tab.chromeTabID)
    await clearMarker(tab)
    if (!tab.profile || tab.attached) await chrome.debugger.detach({ tabId: tab.chromeTabID }).catch(() => {})
    if (tab.owned && !tab.deliverable) await removeInactive(tab.chromeTabID)
  }
  const current = socket
  socket = undefined
  generation = undefined
  requestedPause = false
  groups.clear()
  if (!disconnected && current?.readyState === WebSocket.OPEN) current.close(1000, "stopped")
}

async function disconnected(current, event) {
  if (socket !== current) return
  await stop(true)
  if (event?.code === 4403) {
    await revokePairedTabs()
    pairing = undefined
    await chrome.storage.local.remove(STORAGE_KEY)
    await clearReconnectAlarms()
    return
  }
  scheduleReconnect()
}

async function disablePairing() {
  if (pairing) {
    pairing = { ...pairing, enabled: true, forgetPending: true }
    await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
    await ensureRecoveryAlarm()
    if (socket?.readyState === WebSocket.OPEN) await revokeConnectedPairing()
    else await reconnect()
    if (pairing) throw new Error("Reconnect to the previously paired server before switching pairing")
  }
  await revokePairedTabs()
  await clearReconnectAlarms()
  pairing = undefined
  await chrome.storage.local.remove(STORAGE_KEY)
  await stop(false)
}

async function forget() {
  await revokePairedTabs()
  if (!pairing) {
    await clearReconnectAlarms()
    await stop(false)
    return
  }
  pairing = { ...pairing, enabled: true, forgetPending: true }
  await chrome.storage.local.set({ [STORAGE_KEY]: pairing })
  await ensureRecoveryAlarm()
  await reconnect()
  if (pairing && socket?.readyState === WebSocket.OPEN) await revokeConnectedPairing()
}

async function revokeConnectedPairing() {
  await revokePairedTabs()
  await clearReconnectAlarms()
  send({ type: "forget" })
  pairing = undefined
  await chrome.storage.local.remove(STORAGE_KEY)
  await stop(false)
}

async function restore() {
  await chrome.storage.local.remove("browserProfileGrant")
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
  if (!validPairing(stored)) {
    await chrome.storage.local.remove(STORAGE_KEY)
    await chrome.storage.local.remove(PROFILE_DENIED_KEY)
    await clearReconnectAlarms()
    return
  }
  pairing = stored
  const denied = (await chrome.storage.local.get(PROFILE_DENIED_KEY))[PROFILE_DENIED_KEY]
  if (denied?.serverID === pairing.serverID && Array.isArray(denied.tabIDs)) {
    for (const id of denied.tabIDs) if (Number.isInteger(id) && id > 0) deniedTabs.add(id)
  } else await chrome.storage.local.remove(PROFILE_DENIED_KEY)
  if (pairing.enabled) {
    await ensureRecoveryAlarm()
    await reconnect()
  } else await clearReconnectAlarms()
}

function validPairing(input) {
  if (!input || typeof input !== "object") return false
  try {
    connectURL(input.serverURL)
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
  return {
    paired: !!pairing,
    connected,
    enabled: pairing?.enabled === true,
    profileGranted: !!pairing?.enabled && !pairing.forgetPending,
    serverURL: pairing?.serverURL,
    message:
      message ??
      (connected
        ? `${tabs.size} tab${tabs.size === 1 ? "" : "s"} listed`
        : pairing?.enabled
          ? "Reconnecting to YCoding"
          : pairing
            ? "Paired with YCoding; reconnect explicitly to resume"
            : "Not paired"),
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Cannot access|not allowed|restricted|chrome:\/\//i.test(message))
    return "Chrome does not allow this restricted or enterprise-managed tab to be shared"
  return message.slice(0, 1024)
}

function updateBadge(tab) {
  if (tab.profile && !tab.attached) return
  void chrome.action.setBadgeText({ tabId: tab.chromeTabID, text: "ON" }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ tabId: tab.chromeTabID, color: tokens.colors["badge-on"] }).catch(() => {})
}

function clearBadge(chromeTabID) {
  void chrome.action.setBadgeText({ tabId: chromeTabID, text: "" }).catch(() => {})
}

void restore()
