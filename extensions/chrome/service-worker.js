import {
  MAX_AX_DEPTH,
  MAX_CAPTURE_BYTES,
  MAX_CLIPBOARD_BYTES,
  MAX_ELEMENTS,
  MAX_EXPORT_BYTES,
  MAX_FRAMES,
  MAX_HISTORY_RESULTS,
  MAX_LOG_ENTRIES,
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
import { LABELS, TITLE_PREFIX, markerScript, timing, tokens } from "./indicator.js"

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
const MARKER_TEXT = TITLE_PREFIX.trimEnd()
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
    void revokeTab(current).then(() => registerProfileTab(info))
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
      title: current.marked ? stripMarker(info.title ?? "") : (info.title ?? ""),
      url: current.url,
      documentGeneration: current.documentGeneration,
    })
  }
  if (!current) registerProfileTab(info)
})

chrome.tabs.onRemoved.addListener((chromeTabID) => {
  deniedTabs.delete(chromeTabID)
  void persistDeniedTabs()
  const tab = tabs.get(chromeTabs.get(chromeTabID))
  if (tab) void revokeTab(tab)
})

chrome.debugger.onDetach.addListener((source) => {
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
  send({ type: "revoked", tabID: id })
  if (tab?.owned) void removeInactive(tab.chromeTabID)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  const id = chromeTabs.get(source.tabId)
  const tab = id ? tabs.get(id) : undefined
  if (!tab) return
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
    const session = source.sessionId ? tabSessions(tab).get(source.sessionId) : undefined
    if (session && !params.frame?.parentId && params.frame?.url) session.url = params.frame.url
    return
  }
  if (!isAllowedPage(tab, params.frame?.url)) {
    void revokeTab(tab)
    return
  }
  tab.documentGeneration++
  tab.revision = 0
  tab.refs.clear()
  tabSessions(tab).clear()
  tab.logs = []
  tab.url = params.frame.url
  forgetDocument(tab)
  if (tab.marked) void mark(tab)
  tabInfo(tab).then(
    (info) => {
      if (tabs.get(tab.id) !== tab || tab.url !== params.frame.url) return
      if (!isAllowedPage(tab, info.url)) {
        void revokeTab(tab)
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
  })
}

async function revokePairedTabs() {
  send({ type: "profile_access", enabled: false })
  for (const tab of [...tabs.values()].filter((item) => item.profile)) await revokeTab(tab)
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

async function revokeTab(tab) {
  if (!tab || tabs.get(tab.id) !== tab) return
  chromeTabs.delete(tab.chromeTabID)
  tabs.delete(tab.id)
  clearBadge(tab.chromeTabID)
  send({ type: "revoked", tabID: tab.id })
  await clearMarker(tab)
  if (!tab.profile || tab.attached) await chrome.debugger.detach({ tabId: tab.chromeTabID }).catch(() => {})
  if (tab.owned) await removeInactive(tab.chromeTabID)
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
    if (tab?.owned) await revokeTab(tab)
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
}

function forgetChildSession(tab, sessionId) {
  if (!sessionId) return
  tabSessions(tab).delete(sessionId)
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

async function observe(message) {
  let fresh
  try {
    const tab = requireTab(message)
    await isActive(tab)
    fresh = tab.profile && !tab.attached ? tab : undefined
    await controlTabs([tab])
    applyFrameOrigins(tab, message)
    const documentGeneration = tab.documentGeneration
    const allowed = new Set([...tab.allowedOrigins, ...tabFrameOrigins(tab)])
    const sessions = [{ sessionId: undefined, url: tab.url }, ...[...tabSessions(tab).entries()].map(([sessionId, value]) => ({ sessionId, ...value }))]
    await Promise.all(sessions.map((session) => session.ready).filter(Boolean))
    tab.revision++
    tab.refs.clear()
    const elements = []
    const texts = []
    const frames = []
    const seen = new Set()
    let candidateCount = 0
    let textCount = 0
    for (const session of sessions) {
      let frameList
      try {
        const { frameTree } = await command(tab.chromeTabID, "Page.getFrameTree", {}, session.sessionId)
        frameList = collectFrames(frameTree)
      } catch (error) {
        if (!session.sessionId) throw error
        frames.push({ url: session.url || tab.url, observed: false })
        continue
      }
      for (const [index, frame] of frameList.entries()) {
        const top = !session.sessionId && index === 0
        const url = frame.url || (top ? tab.url : session.url || tab.url)
        let origin
        try {
          origin = safePage(url).origin
        } catch {
          origin = undefined
        }
        if (!top && (!origin || !allowed.has(origin) || session.failed)) {
          frames.push({ url, observed: false })
          continue
        }
        let tree
        try {
          tree = await command(
            tab.chromeTabID,
            "Accessibility.getFullAXTree",
            { depth: MAX_AX_DEPTH, ...(frame.id ? { frameId: frame.id } : {}) },
            session.sessionId,
          )
        } catch (error) {
          if (top) throw error
          frames.push({ url, observed: false })
          continue
        }
        if (!top) frames.push({ url, observed: true })
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
          if (!interactiveRoles.has(role) || !node.backendDOMNodeId) continue
          const key = `${session.sessionId ?? ""}\0${node.backendDOMNodeId}`
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
              session.sessionId,
            )
          } catch {
            continue
          }
          const ref = `b${elements.length + 1}`
          tab.refs.set(ref, {
            sessionId: session.sessionId,
            backendNodeId: node.backendDOMNodeId,
            frameId: frame.id,
            url,
          })
          const attributes = attrs(described.node.attributes)
          const href = attributes.get("href")
          const destination = href ? new URL(href, url).toString() : undefined
          elements.push({
            ref,
            role,
            name: String(node.name?.value ?? ""),
            description: node.description?.value ? String(node.description.value) : undefined,
            disabled: node.properties?.some((item) => item.name === "disabled" && item.value?.value === true) || undefined,
            destination,
            ...(top ? {} : { frame: url }),
          })
        }
      }
    }
    const info = await tabInfo(tab)
    if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
      await revokeTab(tab)
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
    await controlTabs([tab])
    tab.allowedOrigins = new Set(message.allowedOrigins)
    applyFrameOrigins(tab, message)
    if (["navigate", "click", "type", "back", "forward", "reload", "key", "webmcp_invoke"].includes(message.action.type))
      tab.downloadSince = Date.now() - 1000
    if (message.action.type === "navigate") await navigate(tab, message.action.url, () => (dispatched = true))
    if (message.action.type === "click") await click(tab, message.action.ref, () => (dispatched = true))
    if (message.action.type === "type")
      await typeText(tab, message.action.ref, message.action.text, () => (dispatched = true))
    if (message.action.type === "scroll") await scroll(tab, message.action.deltaY, () => (dispatched = true))
    if (message.action.type === "back") await history(tab, -1, () => (dispatched = true))
    if (message.action.type === "forward") await history(tab, 1, () => (dispatched = true))
    if (message.action.type === "reload") {
      dispatched = true
      await command(tab.chromeTabID, "Page.reload", {})
    }
    if (message.action.type === "key") await dispatchKey(tab, message.action, () => (dispatched = true))
    if (message.action.type === "wait") await waitAction(tab, message.action)
    const peripheral = ["clipboard_read", "clipboard_write", "upload", "download", "logs", "export", "webmcp_list", "webmcp_invoke"].includes(message.action.type)
      ? await peripheralAction(tab, message.action, () => (dispatched = true))
      : {}
    const captured = message.action.type === "capture" ? await capture(tab) : undefined
    await isActive(tab)
    const info = await tabInfo(tab)
    if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
      await revokeTab(tab)
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
    await revokeTab(tab)
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
  markDispatched()
  await command(tab.chromeTabID, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    modifiers,
    ...(single && !named && !modifiers ? { text: action.key } : {}),
  })
  await command(tab.chromeTabID, "Input.dispatchKeyEvent", { type: "keyUp", ...base, modifiers })
}

async function waitAction(tab, action) {
  const timeout = Math.min(Math.max(action.timeoutMs ?? 5000, 0), MAX_WAIT_MS)
  const deadline = Date.now() + timeout
  for (;;) {
    if (action.ref) {
      const target = tab.refs.get(action.ref)
      if (target) {
        try {
          await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId: target.backendNodeId, depth: 0 }, target.sessionId)
          return
        } catch {}
      }
    } else {
      const ready = await pageEvaluate(tab, "document.readyState").then(
        ({ result }) => result?.value === "complete",
        () => false,
      )
      if (ready) return
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the page")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function click(tab, ref, markDispatched) {
  const documentGeneration = tab.documentGeneration
  const target = requireRef(tab, ref)
  const { backendNodeId } = target
  const described = await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId, depth: 0 }, target.sessionId)
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
  await command(tab.chromeTabID, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, target.sessionId)
  const { quads } = await command(tab.chromeTabID, "DOM.getContentQuads", { backendNodeId }, target.sessionId)
  const quad = quads?.[0]
  if (!quad) throw new Error("Element is not visible")
  const { x, y } = await mainPoint(tab, target, quad)
  if (tabs.get(tab.id) !== tab || tab.documentGeneration !== documentGeneration)
    throw new Error("The shared tab observation is stale")
  await moveCursor(tab, x, y, LABELS.click, true)
  markDispatched()
  for (const type of ["mousePressed", "mouseReleased"])
    await inputCommand(tab, { type, x, y, button: "left", clickCount: 1 })
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
  const { backendNodeId } = target
  const described = await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId, depth: 0 }, target.sessionId)
  rejectProtectedInput(described.node)
  if (tabs.get(tab.id) !== tab || tab.documentGeneration !== documentGeneration)
    throw new Error("The shared tab observation is stale")
  await command(tab.chromeTabID, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, target.sessionId)
  const { quads } = await command(tab.chromeTabID, "DOM.getContentQuads", { backendNodeId }, target.sessionId)
  const quad = quads?.[0]
  if (!quad) throw new Error("Element is not visible")
  const { x, y } = await mainPoint(tab, target, quad)
  await moveCursor(tab, x, y, LABELS.type)
  markDispatched()
  await command(tab.chromeTabID, "DOM.focus", { backendNodeId }, target.sessionId)
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

function stripMarker(title) {
  return title.startsWith(MARKER_TEXT) ? title.slice(MARKER_TEXT.length).replace(/^ /, "") : title
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

async function capture(tab) {
  await assertPageCaptureSafe(tab)
  const { data } = await command(tab.chromeTabID, "Page.captureScreenshot", { format: "png", fromSurface: true })
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
    await revokeTab(tab)
    throw new Error("The shared tab changed to an unapproved site")
  }
  tab.active = info.active
  updateBadge(tab)
  return tab.active
}

async function tabInfo(tab) {
  const info = await chrome.tabs.get(tab.chromeTabID)
  if (!tab.owned) return tab.marked ? { ...info, title: stripMarker(info.title ?? "") } : info
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
  return { active: info.active, title: tab.marked ? stripMarker(title) : title, url: entry?.url }
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
    if (tab.owned) await removeInactive(tab.chromeTabID)
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
