import { createMcpAppBridge } from "./bridge.js"
import { parsePreviewPolicy, validatePreview } from "./model.js"

const status = document.querySelector("#status")
const refresh = document.querySelector("#refresh")
const region = document.querySelector("#frame-region")
const policy = parsePreviewPolicy(document.querySelector("#preview-policy").textContent)
let lease
let frame
let timer
let revision = 0
let refreshing = false
let disposed = false

const bridge = createMcpAppBridge({
  appInfo: { name: "ycoding-local-http-app", version: "1" },
  allowedTools: ["local_app_status"],
  onToolResult: apply,
})

function show(state, text) {
  status.dataset.state = state
  status.textContent = text
  refresh.disabled =
    disposed ||
    refreshing ||
    bridge.state !== "initialized" ||
    !lease ||
    Date.parse(lease.expiresAt) <= Date.now() ||
    lease.status === "revoked" ||
    lease.status === "expired"
  refresh.setAttribute("aria-disabled", String(refresh.disabled))
}

function removeFrame() {
  frame?.remove()
  frame = undefined
  clearTimeout(timer)
}

function expiry() {
  clearTimeout(timer)
  const remaining = Date.parse(lease.expiresAt) - Date.now()
  if (remaining > 0) {
    timer = setTimeout(expiry, Math.min(remaining, 2147483647))
    return
  }
  revision++
  lease = { ...lease, status: "expired" }
  removeFrame()
  show("expired", "Expired. Request a new app preview.")
}

function apply(result) {
  if (disposed) return
  revision++
  refreshing = false
  const next = validatePreview(result, policy)
  const same =
    next &&
    lease &&
    next.appID === lease.appID &&
    next.sessionID === lease.sessionID &&
    next.expiresAt === lease.expiresAt
  if (!next) {
    lease = undefined
    removeFrame()
    show("unavailable", "Preview unavailable. Request a new app preview.")
    return
  }
  const { url, ...current } = next
  lease = current
  if (next.status !== "ready") {
    removeFrame()
    show(
      next.status,
      next.status === "expired"
        ? "Expired. Request a new app preview."
        : next.status === "revoked"
          ? "Revoked. App access has ended."
          : "Preview unavailable. Refresh to check access.",
    )
    return
  }
  if (same && frame) {
    expiry()
    show(
      frame.dataset.loaded === "true" ? "loaded" : "pending",
      frame.dataset.loaded === "true" ? "Frame loaded; app response not verified." : "Pending app frame.",
    )
    return
  }
  removeFrame()
  if (!url) {
    show("unavailable", "Preview unavailable. Request a new app preview.")
    return
  }
  frame = document.createElement("iframe")
  frame.id = "preview"
  frame.setAttribute("aria-label", "App preview")
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms")
  frame.setAttribute("referrerpolicy", "no-referrer")
  frame.addEventListener("load", (event) => {
    if (disposed || event.target !== frame) return
    if (Date.parse(lease.expiresAt) <= Date.now()) return expiry()
    frame.dataset.loaded = "true"
    show("loaded", "Frame loaded; app response not verified.")
  })
  frame.src = url
  show("pending", "Pending app frame.")
  region.append(frame)
  expiry()
}

refresh.addEventListener("click", async () => {
  if (refresh.disabled) return
  const requested = revision
  refreshing = true
  show("pending", "Checking app access.")
  try {
    const result = await bridge.callTool("local_app_status", { sessionID: lease.sessionID, input: { id: lease.appID } })
    if (!disposed && requested === revision) apply(result)
  } catch {
    if (disposed || requested !== revision) return
    refreshing = false
    removeFrame()
    show("unavailable", "Preview unavailable. Refresh to check access.")
  }
})

window.addEventListener(
  "pagehide",
  () => {
    disposed = true
    revision++
    removeFrame()
    bridge.dispose()
    show("unavailable", "Preview unavailable. This app connection is closed.")
  },
  { once: true },
)

bridge
  .initialize()
  .then(() => {
    if (!disposed && !lease) show("pending", "Pending initialization: waiting for an app preview.")
  })
  .catch(() => {
    if (!disposed) {
      removeFrame()
      show("unavailable", "Preview unavailable. The host connection could not initialize.")
    }
  })
