const deckBody = document.querySelector("#deck-body")
const headerStatus = document.querySelector("#header-status")
const connection = document.querySelector("#connection")
const status = document.querySelector("#status")
const matchCode = document.querySelector("#match-code")
const connect = document.querySelector("#connect")
const address = document.querySelector("input[name=address]")
const forget = document.querySelector("#forget")
const openPanel = document.querySelector("#open-panel")
const feedback = document.querySelector("#feedback")
const requests = document.querySelector("#requests")
const active = document.querySelector("#active")
const pauseReasons = {
  foreground_required: "This step needs the tab in front.",
  file_chooser: "Choose the file in the page yourself.",
  dialog: "Answer the page dialog.",
  captcha: "Complete the human check in the page.",
  sensitive: "Enter the sensitive details yourself.",
  user_takeover: "You took over this tab.",
}
const statusInfo = {
  idle: { text: "Not connected", state: "disconnected" },
  connecting: { text: "Connecting…", state: "waiting" },
  reconnecting: { text: "Reconnecting…", state: "waiting" },
  enrolling: { text: "Confirm on your Mac", state: "waiting" },
  offline: { text: "YCoding is not reachable. Retrying…", state: "error" },
  denied: { text: "This Mac did not allow the connection", state: "error" },
  rejected: { text: "This Chrome profile is no longer allowed. Connect to ask again.", state: "error" },
  busy: { text: "Another Chrome profile is connected", state: "error" },
  forgetting: { text: "Forgetting this profile…", state: "waiting" },
}
const popupWindow = chrome.windows.getCurrent().then((window) => window.id)
let version = 0
let busy = false
let rendered = ""
let addressShown = false
let firstActive

function button(label, kind, input) {
  const control = document.createElement("button")
  control.type = "button"
  control.textContent = label
  control.dataset.kind = kind
  control.addEventListener("click", (event) => {
    if (event.isTrusted) void send(input, control)
  })
  return control
}

function row(label, controls) {
  const article = document.createElement("article")
  const text = document.createElement("p")
  text.textContent = label
  const actions = document.createElement("div")
  actions.className = "actions"
  actions.append(...controls)
  article.append(text, actions)
  return article
}

function describe(result) {
  if (result?.status !== "connected") return statusInfo[result?.status] ?? statusInfo.idle
  if (result.active?.some((item) => item.paused)) return { text: "Paused", state: "paused" }
  return result.active?.length ? { text: "Control active", state: "active" } : { text: "Connected", state: "connected" }
}

function syncVisibility() {
  headerStatus.hidden = !headerStatus.textContent.trim()
  status.hidden = !status.textContent.trim()
  feedback.hidden = !feedback.textContent.trim()
  requests.hidden = requests.children.length === 0
  active.hidden = active.children.length === 0
  connection.hidden = status.hidden && matchCode.hidden && connect.hidden
  deckBody.hidden = connection.hidden && requests.hidden && active.hidden && feedback.hidden
}

async function statusRead() {
  const current = ++version
  const result = await chrome.runtime.sendMessage({ type: "status", windowId: await popupWindow }).catch(() => undefined)
  if (current !== version) return
  const signature = JSON.stringify(result)
  if (rendered === signature) return
  rendered = signature
  const info = describe(result)
  if (info.state === "connected") {
    headerStatus.textContent = info.text
    headerStatus.dataset.state = info.state
    status.textContent = ""
    delete status.dataset.state
  } else {
    headerStatus.textContent = ""
    delete headerStatus.dataset.state
    status.textContent = info.text
    status.dataset.state = info.state
  }
  if (!addressShown && result?.address) {
    address.value = result.address
    addressShown = true
  }
  matchCode.hidden = result?.status !== "enrolling" || !result.matchCode
  matchCode.textContent = result?.matchCode ?? ""
  connect.hidden = !["idle", "denied", "rejected", "busy", "offline"].includes(result?.status ?? "idle")
  forget.hidden = !result?.authorized
  firstActive = result?.active?.[0]
  openPanel.hidden = !firstActive
  const groupingNotice = result?.groupingUnavailable ? document.createElement("p") : undefined
  if (groupingNotice) groupingNotice.textContent = "This tab is in one of your tab groups. Move it out of that group to let YCoding control it."
  requests.replaceChildren(...(groupingNotice ? [groupingNotice] : []), ...(result?.pending ?? []).map((item) => {
    const input = { candidateID: item.candidateID, sessionID: item.sessionID, targetID: item.targetID, grouping: item.grouping }
    const action = item.purpose === "attach" ? "Allow control" : `Allow ${item.action}`
    const grouping = item.grouping === "move" ? " Move only this tab into the YCoding control group." :
      item.grouping === "already" ? " Keep this tab in the YCoding control group." :
      item.grouping === "create" ? " Open the tab in the background in the YCoding control group." : ""
    const requester = item.sessionLabel ? ` for ${item.sessionLabel}` : ""
    return row(`${action}${requester}: ${item.target.label} · ${item.url ?? `${item.target.origin}${item.target.pathname}`}.${grouping}`, [
      button(item.grouping === "move" ? "Approve and group" : "Approve", "approve", { type: "approve", ...input }),
      button("Reject", "reject", { type: "reject", ...input }),
    ])
  }))
  active.replaceChildren(...(result?.active ?? []).map((item) => {
    const lease = { sessionID: item.sessionID, leaseID: item.leaseID, epoch: item.epoch }
    const owner = item.sessionLabel ? `${item.sessionLabel} · ` : ""
    const state = item.paused ? ` · Paused. ${pauseReasons[item.paused] ?? ""}` : ""
    return row(`${owner}${item.label}${state}`, [
      item.paused ? button("Resume", "resume", { type: "resume", ...lease }) : button("Take over", "takeover", { type: "takeover", ...lease }),
      button("Stop control", "stop", { type: "stop", ...lease }),
    ])
  }))
  syncVisibility()
}

function failure(result) {
  if (result?.code === "cleanup") return "Control stopped. Chrome cleanup was not confirmed."
  if (result?.code === "invalid") return "Enter a local address such as http://127.0.0.1:42188."
  if (result?.code === "busy") return "Wait for the current step to finish, then try again."
  return "This request did not complete. Check the current tab or connection."
}

async function send(message, control) {
  if (busy) return
  busy = true
  version++
  control.disabled = true
  feedback.textContent = ""
  syncVisibility()
  try {
    const result = await chrome.runtime.sendMessage({ ...message, windowId: await popupWindow })
    if (!result?.ok) feedback.textContent = failure(result)
  } catch {
    feedback.textContent = "The extension connection is unavailable. Check its current status."
  } finally {
    control.disabled = false
    busy = false
    rendered = ""
    syncVisibility()
    await statusRead()
  }
}

connect.addEventListener("click", (event) => {
  if (event.isTrusted) void send({ type: "connect", address: address.value.trim() }, connect)
})
forget.addEventListener("click", (event) => {
  if (event.isTrusted) void send({ type: "forget" }, forget)
})
openPanel.addEventListener("click", (event) => {
  if (event.isTrusted && firstActive) void send({ type: "openPanel", leaseID: firstActive.leaseID }, openPanel)
})

void statusRead()
setInterval(() => { if (!busy) void statusRead() }, 350)
