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
const statusText = {
  idle: "Not connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  enrolling: "Confirm on your Mac",
  offline: "YCoding is not reachable. Retrying…",
  denied: "This Mac did not allow the connection",
  rejected: "This Chrome profile is no longer allowed. Connect to ask again.",
  busy: "Another Chrome profile is connected",
  forgetting: "Forgetting this profile…",
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
  if (result?.status !== "connected") return statusText[result?.status] ?? "Not connected"
  if (result.active.some((item) => item.paused)) return "Paused"
  return result.active.length ? "Control active" : "Connected"
}

async function statusRead() {
  const current = ++version
  const result = await chrome.runtime.sendMessage({ type: "status", windowId: await popupWindow }).catch(() => undefined)
  if (current !== version) return
  const signature = JSON.stringify(result)
  if (rendered === signature) return
  rendered = signature
  status.textContent = describe(result)
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
  try {
    const result = await chrome.runtime.sendMessage({ ...message, windowId: await popupWindow })
    if (!result?.ok) feedback.textContent = failure(result)
  } catch {
    feedback.textContent = "The extension connection is unavailable. Check its current status."
  } finally {
    control.disabled = false
    busy = false
    rendered = ""
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
