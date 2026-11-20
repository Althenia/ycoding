const form = document.querySelector("#pair")
const status = document.querySelector("#status")
const feedback = document.querySelector("#feedback")
const requests = document.querySelector("#requests")
const active = document.querySelector("#active")
let version = 0
let busy = false
let rendered = ""

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

async function statusRead() {
  const current = ++version
  const result = await chrome.runtime.sendMessage({ type: "status" }).catch(() => undefined)
  if (current !== version) return
  const signature = JSON.stringify(result)
  if (rendered === signature) return
  rendered = signature
  const connected = result?.status === "connected"
  status.textContent = connected ? (result.active.length ? "Control active" : "Connected · no active control") :
    result?.status === "connecting" ? "Connecting…" : "Not connected"
  form.hidden = connected || result?.status === "connecting"
  const groupingNotice = result?.groupingUnavailable ? document.createElement("p") : undefined
  if (groupingNotice) groupingNotice.textContent = "This tab cannot join YCoding control without changing another group."
  requests.replaceChildren(...(groupingNotice ? [groupingNotice] : []), ...(result?.pending ?? []).map((item) => {
    const input = { candidateID: item.candidateID, sessionID: item.sessionID, targetID: item.targetID, grouping: item.grouping }
    const action = item.purpose === "attach" ? "Allow control" : `Allow ${item.action}`
    const grouping = item.grouping === "move" ? " Move only this tab into a new YCoding control group." :
      item.grouping === "already" ? " Keep this tab in its existing YCoding control group." :
      item.grouping === "create" ? " Open the tab in a new YCoding control group." : ""
    return row(`${action}: ${item.target.label} · ${item.url ?? `${item.target.origin}${item.target.pathname}`}.${grouping}`, [
      button(item.grouping === "move" ? "Approve and group" : "Approve", "approve", { type: "approve", ...input }),
      button("Reject", "reject", { type: "reject", ...input }),
    ])
  }))
  active.replaceChildren(...(result?.active ?? []).map((item) =>
    row(item.label, [button("Stop control", "stop", { type: "stop", sessionID: item.sessionID, leaseID: item.leaseID, epoch: item.epoch })])))
}

async function send(message, control) {
  if (busy) return
  busy = true
  version++
  control.disabled = true
  feedback.textContent = ""
  try {
    const result = await chrome.runtime.sendMessage(message)
    if (!result?.ok) feedback.textContent = result?.code === "cleanup" ? "Control stopped. Chrome cleanup was not confirmed." :
      "This request did not complete. Check the current target or connection."
  } catch {
    feedback.textContent = "The extension connection is unavailable. Check its current status."
  } finally {
    control.disabled = false
    busy = false
    await statusRead()
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault()
  if (!event.isTrusted || busy) return
  const input = new FormData(form)
  form.elements.namedItem("code").value = ""
  void send({ type: "pair", address: input.get("address"), code: input.get("code") }, event.submitter ?? form.querySelector("button"))
})

void statusRead()
setInterval(() => { if (!busy) void statusRead() }, 350)
