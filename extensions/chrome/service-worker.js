import {
  MAX_CAPTURE_BYTES,
  MAX_ELEMENTS,
  MAX_SHARED_TABS,
  VERSION,
  connectURL,
  reconnectDelay,
  safePage,
  tabID,
} from "./protocol.js"

const PROTOCOL_VERSION = "1.3"
const STORAGE_KEY = "browserPairing"
const PROFILE_DENIED_KEY = "browserProfileDeniedTabs"
const RECONNECT_ALARM = "browser-reconnect"
const RECOVERY_ALARM = "browser-recovery"
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
const groups = new Map()
const deniedTabs = new Set()

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
      title: info.title ?? "",
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
  if (tab && !tab.owned) {
    deniedTabs.add(tab.chromeTabID)
    void persistDeniedTabs()
  }
  chromeTabs.delete(source.tabId)
  tabs.delete(id)
  clearBadge(source.tabId)
  send({ type: "revoked", tabID: id })
  if (tab?.owned) void removeInactive(tab.chromeTabID)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  const id = chromeTabs.get(source.tabId)
  const tab = id ? tabs.get(id) : undefined
  if (!tab) return
  if (method !== "Page.frameNavigated" || params.frame?.parentId) return
  if (!isAllowedPage(tab, params.frame?.url)) {
    void revokeTab(tab)
    return
  }
  tab.documentGeneration++
  tab.revision = 0
  tab.refs.clear()
  tab.url = params.frame.url
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
  if (message.type === "open") await openTab(message)
  if (message.type === "close") await closeTab(message)
  if (message.type === "release" && message.generation === generation) {
    const tab = tabs.get(message.tabID)
    if (tab?.owned) await revokeTab(tab)
  }
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
    await Promise.all([
      command(chromeTabID, "Page.enable"),
      command(chromeTabID, "DOM.enable"),
      command(chromeTabID, "Accessibility.enable"),
    ])
    if (socket !== owner || generation !== bridgeGeneration || owner.readyState !== WebSocket.OPEN)
      throw new Error("Chrome bridge changed while opening a tab")
    const tab = {
      id: message.tabID,
      chromeTabID,
      windowID: created.windowId,
      owned: true,
      documentGeneration: 1,
      revision: 0,
      refs: new Map(),
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
      title: info[request.tabIDs.indexOf(message.tabID)].title ?? "",
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
      title: info[ids.indexOf(anchor.chromeTabID)].title ?? "",
      url: anchor.url,
      groupID: request.groupID,
    })
  } catch (error) {
    fail(message, safeError(error), dispatched)
  }
}

async function observe(message) {
  try {
    const tab = requireTab(message)
    await isActive(tab)
    await attachProfile(tab)
    const documentGeneration = tab.documentGeneration
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
    const info = await tabInfo(tab)
    if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, info.url)) {
      await revokeTab(tab)
      return fail(message, "The shared tab changed to an unapproved site")
    }
    if (tab.documentGeneration !== documentGeneration) return fail(message, "The shared tab observation is stale")
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
    if (requestedPause) return paused(message, tab)
    await isActive(tab)
    if (tab.documentGeneration !== message.documentGeneration || tab.revision !== message.observationRevision)
      return fail(message, "The shared tab observation is stale")
    if (message.action.type === "group") return groupTabs(message)
    if (message.action.type === "ungroup") return ungroupTabs(message)
    await attachProfile(tab)
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
    })
  } catch (error) {
    fail(message, safeError(error), dispatched)
  }
}

async function attachProfile(tab) {
  if (!tab.profile || tab.attached) return
  if (!pairing?.enabled || socket?.readyState !== WebSocket.OPEN) throw new Error("Profile access is unavailable")
  await chrome.debugger.attach({ tabId: tab.chromeTabID }, PROTOCOL_VERSION)
  tab.attached = true
  updateBadge(tab)
  if (tabs.get(tab.id) !== tab || !isAllowedPage(tab, (await chrome.tabs.get(tab.chromeTabID)).url)) {
    await revokeTab(tab)
    throw new Error("The profile tab changed to an unapproved site or was revoked")
  }
  await Promise.all([
    command(tab.chromeTabID, "Page.enable"),
    command(tab.chromeTabID, "DOM.enable"),
    command(tab.chromeTabID, "Accessibility.enable"),
  ])
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
  const documentGeneration = tab.documentGeneration
  const backendNodeId = requireRef(tab, ref)
  const described = await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId, depth: 0 })
  const attributes = attrs(described.node.attributes)
  if (attributes.has("download")) throw new Error("Explicit download links are unsupported")
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
  if (tabs.get(tab.id) !== tab || tab.documentGeneration !== documentGeneration)
    throw new Error("The shared tab observation is stale")
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
  const documentGeneration = tab.documentGeneration
  const backendNodeId = requireRef(tab, ref)
  const described = await command(tab.chromeTabID, "DOM.describeNode", { backendNodeId, depth: 0 })
  rejectProtectedInput(described.node)
  if (tabs.get(tab.id) !== tab || tab.documentGeneration !== documentGeneration)
    throw new Error("The shared tab observation is stale")
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
  if (!tab.owned) return info
  const history = await command(tab.chromeTabID, "Page.getNavigationHistory")
  const entry = history.entries[history.currentIndex] ?? history.entries.at(-1)
  return { active: info.active, title: entry?.title ?? "", url: entry?.url }
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
    message: "Chrome bridge is paused",
  })
}

async function stop(disconnected) {
  clearInterval(heartbeatTimer)
  const attached = [...tabs.values()]
  tabs.clear()
  chromeTabs.clear()
  for (const tab of attached) {
    clearBadge(tab.chromeTabID)
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
  void chrome.action.setBadgeBackgroundColor({ tabId: tab.chromeTabID, color: "#28753e" }).catch(() => {})
}

function clearBadge(chromeTabID) {
  void chrome.action.setBadgeText({ tabId: chromeTabID, text: "" }).catch(() => {})
}

void restore()
