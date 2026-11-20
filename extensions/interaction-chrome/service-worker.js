import { ChromeFault, createChromeController } from "./controller.js"
import { createChromeKernel } from "./kernel.js"

const maxFrame = 262_144
const requestLimit = 2048
const api = chrome
const kernel = createChromeKernel(api)
const controller = createChromeController(kernel, { revoked: (event) => send(channel, { type: "revoked", ...event }) })
const operations = new Set(["inventory", "attach", "observe", "perform", "preview", "detach"])
const safeCodes = new Set(["consent", "ownership", "stale", "stopped", "busy", "invalid", "unavailable", "cleanup", "marker",
  "unsupported", "sensitive", "captcha", "policy", "permission", "target_lost", "confirmation_required"])
let channel
let status = "unavailable"

function code(error) {
  return error instanceof ChromeFault && safeCodes.has(error.code) ? error.code : "unavailable"
}

function send(current, frame) {
  if (!current || current !== channel || current.socket.readyState !== WebSocket.OPEN) return false
  const text = JSON.stringify(frame)
  if (new TextEncoder().encode(text).length > maxFrame || current.socket.bufferedAmount > maxFrame) {
    close(current, "disconnected")
    return false
  }
  try {
    current.socket.send(text)
    return true
  } catch {
    close(current, "disconnected")
    return false
  }
}

function close(current, reason) {
  if (channel !== current) return
  channel = undefined
  status = "unavailable"
  clearTimeout(current.timer)
  void controller.reset(reason)
  current.socket.close()
}

async function receive(current, raw) {
  if (channel !== current) return
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > maxFrame) {
    close(current, "disconnected")
    return
  }
  let frame
  try { frame = JSON.parse(raw) } catch { close(current, "disconnected"); return }
  if (!frame || typeof frame !== "object") { close(current, "disconnected"); return }
  if (!current.ready) {
    if (frame.type !== "authenticated" || frame.version !== 1) { close(current, "disconnected"); return }
    current.ready = true
    clearTimeout(current.timer)
    status = "connected"
    return
  }
  if (frame.type === "pending") {
    try { controller.offer({ ...frame.input, mode: frame.input?.selection?.mode, url: frame.input?.selection?.url }) }
    catch { close(current, "disconnected") }
    return
  }
  if (frame.type === "cancel") {
    if (frame.input) controller.dismiss(frame.input)
    return
  }
  if (frame.type !== "request" || typeof frame.id !== "string" || frame.id.length !== 36 || !operations.has(frame.op) ||
    !frame.input || typeof frame.input !== "object" || !Number.isSafeInteger(frame.deadline) ||
    current.seen.has(frame.id) || current.seen.size >= requestLimit) {
    close(current, "disconnected")
    return
  }
  current.seen.add(frame.id)
  try {
    if (Date.now() >= frame.deadline && frame.op !== "detach") throw new ChromeFault("stopped")
    const result = await controller[frame.op]({ ...frame.input, deadline: frame.deadline })
    send(current, { type: "result", id: frame.id, result: result ?? null })
  } catch (error) {
    send(current, { type: "error", id: frame.id, code: code(error) })
  }
}

function connect(address, supplied) {
  if (channel || typeof address !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(address) ||
    typeof supplied !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(supplied)) throw new ChromeFault("invalid")
  const url = new URL(address)
  url.protocol = "ws:"
  url.pathname = "/api/interaction/chrome/connect"
  const socket = new WebSocket(url)
  const current = { socket, ready: false, seen: new Set() }
  channel = current
  status = "connecting"
  current.timer = setTimeout(() => close(current, "disconnected"), 10_000)
  socket.addEventListener("open", () => {
    send(current, { type: "authenticate", version: 1, extensionID: api.runtime.id, code: supplied })
  }, { once: true })
  socket.addEventListener("message", ({ data }) => { void receive(current, data) })
  socket.addEventListener("error", () => close(current, "disconnected"), { once: true })
  socket.addEventListener("close", () => close(current, "disconnected"), { once: true })
}

async function onLocal(message) {
  if (message?.type === "pair") {
    connect(message.address, message.code)
    return { status }
  }
  const current = channel
  if (message?.type === "stop") {
    await controller.detach(message)
    return { status }
  }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (!tab || current !== channel) throw new ChromeFault("unavailable")
  const selection = { tabId: tab.id, windowId: tab.windowId }
  const state = controller.localState(selection)
  if (message?.type === "status") return { status, ...state }
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
  if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("popup.html")) return false
  void onLocal(message).then((result) => reply({ ok: true, ...result }), (error) => reply({ ok: false, code: code(error) }))
  return true
})

function lost(id) { controller.invalidate(id, "target_lost") }

function groupChanged(group, moved = false) {
  if (!moved && group.title === "YCoding control" && group.color === "green" && !group.collapsed) return
  kernel.forgetGroup(group.id)
  for (const id of kernel.targetsInGroup(group.id)) if (!kernel.groupingChange(id)) lost(id)
}

api.tabs.onUpdated.addListener((id, change) => {
  if (change.pinned !== undefined || change.discarded !== undefined) lost(id)
  if ((change.url !== undefined || change.status === "loading") && !kernel.ownedChange(id)) lost(id)
  if (change.groupId !== undefined) {
    kernel.foreignMember(change.groupId, id)
    if (!kernel.groupingChange(id, change.groupId)) lost(id)
    for (const member of kernel.targetsInGroup(change.groupId)) if (member !== id) lost(member)
  }
})
api.tabs.onCreated.addListener((tab) => {
  kernel.foreignMember(tab.groupId, tab.id)
  for (const member of kernel.targetsInGroup(tab.groupId)) if (member !== tab.id) lost(member)
})
api.tabs.onRemoved.addListener((id) => controller.invalidate(id, "target_lost"))
api.tabs.onMoved.addListener((id) => { if (!kernel.groupingChange(id)) lost(id) })
api.tabs.onDetached.addListener((id) => lost(id))
api.tabs.onAttached.addListener((id) => lost(id))
api.tabs.onReplaced.addListener((_added, removed) => controller.invalidate(removed, "target_lost"))
api.debugger.onEvent.addListener(({ tabId }, method, params) => kernel.nativeEvent(tabId, method, params))
api.debugger.onDetach.addListener(({ tabId }, reason) => {
  kernel.nativeDetached(tabId)
  controller.invalidate(tabId, reason === "canceled_by_user" ? "cancelled" : "target_lost")
})
api.tabGroups.onUpdated.addListener((group) => groupChanged(group))
api.tabGroups.onMoved.addListener((group) => groupChanged(group, true))
api.tabGroups.onRemoved.addListener((group) => groupChanged(group, true))
