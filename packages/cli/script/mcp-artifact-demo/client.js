import { createMcpAppBridge } from "../mcp-app/bridge.js"

const protocolVersion = "2026-01-26"
const hostTimeoutMs = 3000
const probeTimeoutMs = 2000
const probeReadyType = "yc-fixture-probe-ready"
const childCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; form-action 'none'; base-uri 'none'"
const items = [
  ["Summary", "Short recap of the Session so far.", "ready"],
  ["Proposed actions", "Three follow-ups awaiting a decision.", "review"],
  ["Open questions", "One question is still unanswered.", "open"],
]
const titles = { list: "List variant", cards: "Cards variant" }

const byId = (id) => document.getElementById(id)
const make = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const shown = (value) => (typeof value === "string" && value ? value.slice(0, 64) : "unreported")

const view = byId("variant-view")
const heading = byId("variant-heading")
const switchButtons = document.querySelectorAll("button[data-variant]")

function render(variant) {
  heading.textContent = titles[variant]
  switchButtons.forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.variant === variant)),
  )
  view.replaceChildren(variant === "cards" ? cardList() : rowList())
}

function rowList() {
  const list = make("ol", "rows")
  items.forEach(([title, detail, state]) => {
    const row = make("li")
    row.append(
      make("span", "row-title", title),
      make("span", "row-state", state),
      make("span", "row-detail", detail),
    )
    list.append(row)
  })
  return list
}

function cardList() {
  const list = make("ul", "cards")
  items.forEach(([title, detail, state]) => {
    const card = make("article")
    card.append(make("h3", "", title), make("p", "", detail), make("p", "chip", state))
    const entry = make("li")
    entry.append(card)
    list.append(entry)
  })
  return list
}

const fromHash = () => (location.hash === "#variant=cards" ? "cards" : "list")

switchButtons.forEach((button) =>
  button.addEventListener("click", () => {
    const hash = "#variant=" + button.dataset.variant
    if (location.hash !== hash) location.hash = hash
    render(button.dataset.variant)
  }),
)
window.addEventListener("hashchange", () => render(fromHash()))
render(fromHash())

const hostStatus = byId("host-status")
const embedded = window.parent !== window

function setHost(state, text) {
  hostStatus.dataset.state = state
  hostStatus.textContent = text
}

const bridge = createMcpAppBridge({
  appInfo: { name: "artifact-preview-fixture", version: "0.0.0" },
  allowedTools: [],
  initializeTimeoutMs: hostTimeoutMs,
})

if (!embedded) setHost("failed", "Failed: no host window. This document is not embedded.")
else {
  setHost("pending", "Pending: waiting for the host to answer ui/initialize.")
  bridge.initialize().then(
    (info) =>
      setHost(
        "initialized",
        "Initialized: host " +
          shown(info.name) +
          " " +
          shown(info.version) +
          " accepted protocol " +
          protocolVersion +
          ".",
      ),
    (error) => {
      if (error.code === "rejected")
        setHost("failed", "Failed: host rejected ui/initialize (" + shown(error.hostMessage) + ").")
      else if (error.code === "invalid-result")
        setHost("failed", "Failed: host answered ui/initialize without a result.")
      else if (error.code === "protocol-mismatch")
        setHost("failed", "Failed: host selected protocol " + shown(error.hostProtocolVersion) + ", not " + protocolVersion + ".")
      else if (error.code === "timeout")
        setHost("failed", "Failed: no answer to ui/initialize within " + hostTimeoutMs / 1000 + " s.")
      else setHost("failed", "Failed: host did not answer ui/initialize.")
    },
  )
}

const probeButton = byId("probe-button")
const probeStatus = byId("probe-status")
const probeHost = byId("probe-host")
let frame
let probeTimer

function setProbe(state, text) {
  probeStatus.dataset.state = state
  probeStatus.textContent = text
}

function childMain() {
  const list = document.getElementById("child-items")
  const title = document.getElementById("child-heading")
  const buttons = document.querySelectorAll("button[data-variant]")
  function show(variant) {
    list.className = variant
    title.textContent = variant === "cards" ? "Nested cards variant" : "Nested list variant"
    buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.variant === variant)))
  }
  buttons.forEach((button) => button.addEventListener("click", () => show(button.dataset.variant)))
  show("list")
  parent.postMessage({ type: "yc-fixture-probe-ready" }, "*")
}

function childDocument() {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    childCsp +
    '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<style>" +
    byId("shared").textContent +
    byId("child").textContent +
    "</style></head><body><main>" +
    '<h2 id="child-heading" tabindex="-1"></h2>' +
    '<div class="switch" role="group" aria-label="Nested variant">' +
    '<button type="button" id="child-variant-list" data-variant="list" aria-pressed="true">List</button>' +
    '<button type="button" id="child-variant-cards" data-variant="cards" aria-pressed="false">Cards</button></div>' +
    '<ul id="child-items" class="list"><li>Alpha</li><li>Beta</li><li>Gamma</li></ul></main>' +
    "<script>(" +
    childMain.toString() +
    ")()<\/script></body></html>"
  )
}

function runProbe() {
  if (probeButton.getAttribute("aria-disabled") === "true") return
  clearTimeout(probeTimer)
  if (frame) frame.remove()
  frame = document.createElement("iframe")
  frame.id = "probe-frame"
  frame.title = "Isolated nested frame probe"
  frame.setAttribute("sandbox", "allow-scripts")
  frame.srcdoc = childDocument()
  probeButton.setAttribute("aria-disabled", "true")
  setProbe("pending", "Not confirmed: waiting for the nested frame to report ready.")
  probeHost.append(frame)
  probeTimer = setTimeout(() => {
    probeButton.removeAttribute("aria-disabled")
    if (probeStatus.dataset.state !== "pending") return
    setProbe(
      "unavailable",
      "Unavailable: no readiness message within " +
        probeTimeoutMs / 1000 +
        " s. The host may block nested frames; support is not established.",
    )
  }, probeTimeoutMs)
}

function onProbeMessage(event) {
  const data = event.data
  const ready =
    event.origin === "null" &&
    data &&
    typeof data === "object" &&
    Object.keys(data).length === 1 &&
    data.type === probeReadyType
  if (!ready) return
  clearTimeout(probeTimer)
  probeButton.removeAttribute("aria-disabled")
  setProbe(
    "confirmed",
    "Confirmed: the nested frame ran its script and sent its readiness message. This is one host observation only.",
  )
}

probeButton.addEventListener("click", runProbe)
window.addEventListener("message", (event) => {
  if (event.source && frame && event.source === frame.contentWindow) return onProbeMessage(event)
})