const server = document.querySelector("#server")
const secret = document.querySelector("#secret")
const pairingForm = document.querySelector("#pairing-form")
const pair = document.querySelector("#pair")
const pairingView = document.querySelector("#pairing-view")
const reconnectingView = document.querySelector("#reconnecting-view")
const reconnectingMessage = document.querySelector("#reconnecting-message")
const connectedView = document.querySelector("#connected-view")
const connectionState = document.querySelector("#connection-state")
const connectionActions = document.querySelector("#connection-actions")
const feedback = document.querySelector("#feedback")
const connect = document.querySelector("#connect")
const forget = document.querySelector("#forget")
let actionPending = false
let actionRevision = 0

function show(result) {
  const state = result.connected
    ? "connected"
    : result.paired
      ? result.enabled === false
        ? "paused"
        : "reconnecting"
      : "disconnected"
  connectionState.dataset.state = state
  connectionState.textContent =
    state === "connected" ? "Connected" : state === "reconnecting" ? "Reconnecting" : "Disconnected"
  pairingView.hidden = state !== "disconnected"
  reconnectingView.hidden = state !== "reconnecting" && state !== "paused"
  reconnectingMessage.textContent =
    state === "paused"
      ? "Connection is paused. Retry from settings; your pairing is saved."
      : "Trying the saved local service automatically. Your pairing code is not needed again."
  connectedView.hidden = state !== "connected"
  connectionActions.hidden = !result.paired
  if (result.serverURL) server.value = result.serverURL
  connect.hidden = result.connected || !result.paired
  forget.hidden = !result.paired
}

async function refresh() {
  if (actionPending) return
  const revision = actionRevision
  try {
    const result = await chrome.runtime.sendMessage({ type: "status" })
    if (revision !== actionRevision) return
    show(result)
    feedback.hidden = true
  } catch {
    if (revision !== actionRevision) return
    connectionState.dataset.state = "unavailable"
    connectionState.textContent = "Status unavailable"
    pairingView.hidden = true
    reconnectingView.hidden = false
    connectedView.hidden = true
    connectionActions.hidden = true
    forget.hidden = true
    feedback.textContent = "Unable to reach the extension background service. Close and reopen this popup."
    feedback.hidden = false
  }
}

async function request(message) {
  if (actionPending) return undefined
  actionPending = true
  actionRevision++
  try {
    const result = await chrome.runtime.sendMessage(message)
    show(result)
    feedback.textContent = result.message
    feedback.hidden = message.type === "pair" && result.connected
    return result
  } catch {
    feedback.textContent = "Unable to reach the extension background service. Reopen this popup to check its status."
    feedback.hidden = false
    return undefined
  } finally {
    actionPending = false
  }
}

pairingForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  if (pair.disabled) return
  pair.disabled = true
  await request({ type: "pair", serverURL: server.value, secret: secret.value })
  secret.value = ""
  pair.disabled = false
})

connect.addEventListener("click", () => request({ type: "connect", serverURL: server.value }))
forget.addEventListener("click", () => request({ type: "forget" }))

void refresh()
setInterval(refresh, 3_000)
