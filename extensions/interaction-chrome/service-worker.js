import { ChromeFault, createChromeController, storedLink, validAddress } from "./controller.js"
import { createChromeKernel } from "./kernel.js"

const maxFrame = 262_144
const requestLimit = 2048
const defaultAddress = "http://127.0.0.1:42188"
const storageKey = "connection"
const reconnectAlarm = "ycoding-reconnect"
const retryDelays = [1000, 2000, 5000, 10_000, 20_000, 30_000]
const closeRejected = 4401
const closeBusy = 4409
const api = chrome
const kernel = createChromeKernel(api)
const controller = createChromeController(kernel, {
  revoked: (event) => send(channel, { type: "revoked", ...event }),
  paused: (event) => send(channel, { type: "paused", ...event }),
  resumed: (event) => send(channel, { type: "resumed", ...event }),
})
const operations = new Set(["inventory", "attach", "observe", "perform", "preview", "resume", "run", "cancelRun", "detach"])
const safeCodes = new Set(["consent", "ownership", "stale", "stopped", "busy", "invalid", "unavailable", "cleanup", "marker",
  "unsupported", "sensitive", "captcha", "policy", "permission", "target_lost", "confirmation_required", "paused"])
const pages = new Set(["/popup.html", "/panel.html"])
let channel
let status = "idle"
let attempt = 0
let retryTimer
let matchCode

function code(error) {
  return error instanceof ChromeFault && safeCodes.has(error.code) ? error.code : "unavailable"
}

async function load() {
  const stored = storedLink((await api.storage.local.get(storageKey))[storageKey])
  if (stored.discarded) await save(stored.link)
  return stored.link
}

function save(value) {
  return api.storage.local.set({ [storageKey]: value })
}

function randomSecret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function profileMatchCode(profileID) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ycoding-chrome-profile:${profileID}`)))
  const bits = digest.subarray(0, 5).reduce((value, byte) => value * 256n + BigInt(byte), 0n)
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const text = Array.from({ length: 8 }, (_, index) => alphabet[Number((bits >> BigInt(35 - index * 5)) & 31n)]).join("")
  return `${text.slice(0, 4)}-${text.slice(4)}`
}

function profileLabel() {
  const version = /Chrome\/([0-9]+)/.exec(navigator.userAgent)?.[1]
  return version ? `Chrome ${version}` : "Chrome"
}

function send(current, frame) {
  if (!current || current !== channel || current.socket.readyState !== WebSocket.OPEN) return false
  const text = JSON.stringify(frame)
  if (new TextEncoder().encode(text).length > maxFrame || current.socket.bufferedAmount > maxFrame) {
    current.socket.close()
    return false
  }
  try {
    current.socket.send(text)
    return true
  } catch {
    current.socket.close()
    return false
  }
}

function open(address, first) {
  const url = new URL(address)
  url.protocol = "ws:"
  url.pathname = "/api/interaction/chrome/connect"
  const socket = new WebSocket(url)
  const current = { socket, first, ready: false, opened: false, seen: new Set() }
  channel = current
  status = first.type === "enroll" ? "enrolling" : first.type === "forget" ? "forgetting" : attempt ? "reconnecting" : "connecting"
  current.timer = setTimeout(() => socket.close(), first.type === "enroll" ? 80_000 : 10_000)
  socket.addEventListener("open", () => {
    current.opened = true
    send(current, first)
  }, { once: true })
  socket.addEventListener("message", ({ data }) => { void receive(current, data) })
  socket.addEventListener("close", ({ code: closeCode }) => { void closed(current, closeCode) }, { once: true })
}

async function closed(current, closeCode) {
  if (channel !== current) return
  channel = undefined
  clearTimeout(current.timer)
  clearInterval(current.ping)
  void controller.reset("disconnected")
  const saved = await load()
  if (current.first.type === "forget") {
    if (closeCode === closeRejected) {
      await save({ address: saved.address })
      await api.alarms.clear(reconnectAlarm)
      status = "idle"
      return
    }
    status = "forgetting"
    return retry()
  }
  if (current.first.type === "enroll" && !current.ready) {
    matchCode = undefined
    status = closeCode === closeBusy ? "busy" : current.opened ? "denied" : "offline"
    return
  }
  if (closeCode === closeRejected) {
    await save({ address: saved.address })
    await api.alarms.clear(reconnectAlarm)
    status = "rejected"
    return
  }
  status = closeCode === closeBusy ? "busy" : "offline"
  retry()
}

function retry() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => { void resume() }, retryDelays[Math.min(attempt, retryDelays.length - 1)])
  attempt++
}

async function resume() {
  if (channel) return
  const saved = await load()
  if (channel) return
  if (saved.forget && validAddress(saved.address))
    return open(saved.address, { type: "forget", version: 1, extensionID: api.runtime.id, ...saved.forget })
  if (!saved.credential || !saved.profileID || !validAddress(saved.address)) return
  open(saved.address, { type: "authenticate", version: 1, extensionID: api.runtime.id, profileID: saved.profileID, credential: saved.credential })
}

async function receive(current, raw) {
  if (channel !== current) return
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > maxFrame) {
    current.socket.close()
    return
  }
  let frame
  try { frame = JSON.parse(raw) } catch { current.socket.close(); return }
  if (!frame || typeof frame !== "object") {
    current.socket.close()
    return
  }
  if (!current.ready) {
    await authenticated(current, frame)
    return
  }
  if (frame.type === "pending") {
    try { controller.offer({ ...frame.input, mode: frame.input?.selection?.mode, url: frame.input?.selection?.url }) }
    catch { current.socket.close() }
    return
  }
  if (frame.type === "cancel") {
    if (frame.input) controller.dismiss(frame.input)
    return
  }
  if (frame.type !== "request" || typeof frame.id !== "string" || frame.id.length !== 36 || !operations.has(frame.op) ||
    !frame.input || typeof frame.input !== "object" || !Number.isSafeInteger(frame.deadline) ||
    current.seen.has(frame.id) || current.seen.size >= requestLimit) {
    current.socket.close()
    return
  }
  current.seen.add(frame.id)
  try {
    if (Date.now() >= frame.deadline && frame.op !== "detach" && frame.op !== "cancelRun") throw new ChromeFault("stopped")
    const input = { ...frame.input, deadline: frame.deadline }
    const result = await controller[frame.op](input)
    send(current, { type: "result", id: frame.id, result: result ?? null })
  } catch (error) {
    send(current, { type: "error", id: frame.id, code: code(error) })
  }
}

async function authenticated(current, frame) {
  const enrolling = current.first.type === "enroll"
  if (frame.type !== "authenticated" || frame.version !== 1 ||
    (enrolling ? typeof frame.credential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(frame.credential) : frame.credential !== undefined)) {
    current.socket.close()
    return
  }
  if (enrolling) {
    const saved = await load()
    await save({ address: saved.address, profileID: current.first.profileID, credential: frame.credential })
    matchCode = undefined
  }
  if (channel !== current) return
  current.ready = true
  clearTimeout(current.timer)
  clearTimeout(retryTimer)
  attempt = 0
  status = "connected"
  current.ping = setInterval(() => send(current, { type: "ping" }), 20_000)
  await api.alarms.create(reconnectAlarm, { periodInMinutes: 0.5 })
}

async function connect(address) {
  if (!validAddress(address)) throw new ChromeFault("invalid")
  if (channel) return
  const saved = await load()
  clearTimeout(retryTimer)
  attempt = 0
  if (saved.forget) throw new ChromeFault("busy")
  if (saved.credential && saved.profileID && saved.address === address)
    return open(address, { type: "authenticate", version: 1, extensionID: api.runtime.id, profileID: saved.profileID, credential: saved.credential })
  const profileID = saved.address === address && saved.profileID && !saved.credential ? saved.profileID : randomSecret()
  await save({ address, profileID })
  matchCode = await profileMatchCode(profileID)
  if (channel) return
  open(address, { type: "enroll", version: 1, profileID, profileLabel: profileLabel() })
}

async function forget() {
  const saved = await load()
  clearTimeout(retryTimer)
  attempt = 0
  matchCode = undefined
  const current = channel
  channel = undefined
  current?.socket.close()
  await controller.reset("stopped")
  if (!saved.credential || !saved.profileID) {
    await save({ address: saved.address })
    await api.alarms.clear(reconnectAlarm)
    status = "idle"
    return
  }
  await save({ address: saved.address, forget: { profileID: saved.profileID, credential: saved.credential } })
  await resume()
}

async function openPanel(leaseID) {
  if (!controller.lease(leaseID)) throw new ChromeFault("ownership")
  const base = api.runtime.getURL("panel.html")
  const windows = await api.windows.getAll({ populate: true, windowTypes: ["popup"] })
  await Promise.all(windows.filter((item) => item.tabs?.some((tab) => tab.url?.startsWith(base))).map((item) => api.windows.remove(item.id)))
  await api.windows.create({ url: `${base}?lease=${encodeURIComponent(leaseID)}`, type: "popup", width: 360, height: 480, focused: true })
}

async function onLocal(message, page) {
  const current = channel
  if (message?.type === "connect") {
    await connect(message.address)
    return { status }
  }
  if (message?.type === "forget") {
    await forget()
    return { status }
  }
  if (message?.type === "panel") return { status, lease: controller.lease(message.leaseID) }
  if (message?.type === "stop") {
    await controller.detach(message)
    return { status }
  }
  if (message?.type === "takeover") return { status, done: controller.takeover(message) }
  if (message?.type === "resume") return { status, done: await controller.resume(message, true) }
  if (message?.type === "glance") return { status, frame: await controller.glance(message) }
  if (message?.type === "capture") {
    if (page !== "/panel.html" || !current?.ready) throw new ChromeFault("unavailable")
    const lease = controller.lease(message.leaseID)
    const capture = await controller.capture(message)
    if (!lease || !send(current, { type: "capture", leaseID: lease.leaseID, epoch: lease.epoch, capture })) throw new ChromeFault("unavailable")
    return { status }
  }
  if (message?.type === "openPanel") {
    await openPanel(message.leaseID)
    return { status }
  }
  const windowId = page === "/popup.html" && Number.isSafeInteger(message?.windowId) ? message.windowId : undefined
  const [tab] = windowId === undefined ? [] : await api.tabs.query({ active: true, windowId })
  if (!tab || current !== channel) throw new ChromeFault("unavailable")
  const selection = { tabId: tab.id, windowId: tab.windowId }
  const state = controller.localState(selection)
  if (message?.type === "status") {
    const saved = await load()
    return { status, matchCode, address: saved.address ?? defaultAddress, authorized: !!saved.credential, ...state }
  }
  if (!current?.ready) throw new ChromeFault("unavailable")
  if (message?.type === "approve") {
    const proof = controller.approve(message, selection)
    if (!send(current, { type: "approved", proof })) throw new ChromeFault("unavailable")
    return { status }
  }
  if (message?.type === "reject") {
    if (!state.pending.some((request) => request.candidateID === message.candidateID && request.sessionID === message.sessionID) ||
      !controller.dismiss(message)) throw new ChromeFault("consent")
    send(current, { type: "rejected", candidateID: message.candidateID })
    return { status }
  }
  throw new ChromeFault("invalid")
}

api.runtime.onMessage.addListener((message, sender, reply) => {
  const url = typeof sender.url === "string" && URL.canParse(sender.url) ? new URL(sender.url) : undefined
  if (sender.id !== api.runtime.id || url?.origin !== new URL(api.runtime.getURL("")).origin || !pages.has(url.pathname)) return false
  void onLocal(message, url.pathname).then((result) => reply({ ok: true, ...result }), (error) => reply({ ok: false, code: code(error) }))
  return true
})

function lost(id) { controller.invalidate(id, "target_lost") }

function groupChanged(group, removed = false) {
  if (!removed && group.title === "YCoding control" && group.color === "green" && !group.collapsed) return
  const members = kernel.targetsInGroup(group.id)
  kernel.forgetGroup(group.id)
  for (const id of members) if (!kernel.groupingChange(id)) lost(id)
}

api.tabs.onUpdated.addListener((id, change) => {
  if (change.pinned !== undefined || change.discarded !== undefined) lost(id)
  if ((change.url !== undefined || change.status === "loading") && !kernel.ownedChange(id)) lost(id)
  if (change.groupId !== undefined) {
    const members = kernel.targetsInGroup(change.groupId)
    if (kernel.foreignMember(change.groupId, id)) for (const member of members) lost(member)
    if (kernel.controlled(id) && !kernel.groupingChange(id, change.groupId)) lost(id)
  }
})
api.tabs.onCreated.addListener((tab) => {
  const members = kernel.targetsInGroup(tab.groupId)
  if (kernel.foreignMember(tab.groupId, tab.id)) for (const member of members) lost(member)
})
api.tabs.onRemoved.addListener((id) => controller.invalidate(id, "target_lost"))
api.tabs.onDetached.addListener((id) => lost(id))
api.tabs.onAttached.addListener((id) => lost(id))
api.tabs.onReplaced.addListener((_added, removed) => controller.invalidate(removed, "target_lost"))
api.debugger.onEvent.addListener((source, method, params) => kernel.nativeEvent(source, method, params))
api.debugger.onDetach.addListener(({ tabId }, reason) => {
  kernel.nativeDetached(tabId)
  controller.invalidate(tabId, reason === "canceled_by_user" ? "cancelled" : "target_lost")
})
api.tabGroups.onUpdated.addListener((group) => groupChanged(group))
api.tabGroups.onRemoved.addListener((group) => groupChanged(group, true))
api.runtime.onStartup.addListener(() => { void resume() })
api.runtime.onInstalled.addListener(() => { void resume() })
api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === reconnectAlarm) void resume() })
void kernel.recover().finally(resume)
