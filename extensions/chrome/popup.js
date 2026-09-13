const server = document.querySelector("#server")
const session = document.querySelector("#session")
const secret = document.querySelector("#secret")
const pair = document.querySelector("#pair")
const connect = document.querySelector("#connect")
const forget = document.querySelector("#forget")
const share = document.querySelector("#share")
const revoke = document.querySelector("#revoke")
const status = document.querySelector("#status")

function show(result) {
  status.textContent = result.message
  share.disabled = !result.connected || result.currentShared
  revoke.disabled = !result.connected || !result.currentShared
  connect.disabled = !result.paired || result.connected
  forget.disabled = !result.paired
}

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "status" })
  if (result.serverURL) server.value = result.serverURL
  if (result.sessionID) session.value = result.sessionID
  show(result)
}

pair.addEventListener("click", async () => {
  pair.disabled = true
  status.textContent = "Pairing selected Session…"
  const result = await chrome.runtime.sendMessage({
    type: "pair",
    serverURL: server.value,
    sessionID: session.value,
    secret: secret.value,
  })
  secret.value = ""
  pair.disabled = false
  show(result)
})

connect.addEventListener("click", async () => {
  connect.disabled = true
  status.textContent = "Connecting selected Session…"
  show(
    await chrome.runtime.sendMessage({
      type: "connect",
      serverURL: server.value,
      sessionID: session.value,
    }),
  )
})

forget.addEventListener("click", async () => {
  forget.disabled = true
  show(await chrome.runtime.sendMessage({ type: "forget" }))
})

share.addEventListener("click", async () => {
  share.disabled = true
  const result = await chrome.runtime.sendMessage({ type: "share-current" })
  show(result)
})

revoke.addEventListener("click", async () => {
  revoke.disabled = true
  const result = await chrome.runtime.sendMessage({ type: "revoke-current" })
  show(result)
})

void refresh()
