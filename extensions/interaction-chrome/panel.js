const session = document.querySelector("#session")
const status = document.querySelector("#status")
const frame = document.querySelector("#frame")
const capture = document.querySelector("#capture")
const stop = document.querySelector("#stop")
const resume = document.querySelector("#resume")
const feedback = document.querySelector("#feedback")
const leaseID = new URLSearchParams(location.search).get("lease")
const pauseReasons = {
  foreground_required: "Paused: bring the tab to the front",
  file_chooser: "Paused: choose the file yourself",
  dialog: "Paused: answer the page dialog",
  captcha: "Paused: complete the human check",
  sensitive: "Paused: enter sensitive details yourself",
  user_takeover: "Paused: you took over",
}
let lease
let notice
let busy = false
let glancing = false

function fence() {
  return lease && { sessionID: lease.sessionID, leaseID: lease.leaseID, epoch: lease.epoch }
}

async function read() {
  const result = await chrome.runtime.sendMessage({ type: "panel", leaseID }).catch(() => undefined)
  lease = result?.lease
  session.textContent = lease?.sessionLabel || "YCoding Session"
  const state = !lease ? "Control ended" : lease.paused ? pauseReasons[lease.paused] ?? "Paused" : `Controlling ${lease.label}`
  status.textContent = notice && Date.now() < notice.until ? notice.text : state
  resume.hidden = !lease?.paused
  capture.disabled = busy || !lease
  stop.disabled = busy || !lease
  if (!lease) frame.removeAttribute("src")
}

async function glance() {
  if (glancing || busy || !lease || document.visibilityState !== "visible") return
  glancing = true
  const result = await chrome.runtime.sendMessage({ type: "glance", ...fence() }).catch(() => undefined)
  glancing = false
  if (result?.ok && result.frame) frame.src = `data:${result.frame.mimeType};base64,${result.frame.base64}`
}

async function act(message, control, done) {
  if (busy || !lease) return
  busy = true
  control.disabled = true
  feedback.textContent = ""
  try {
    const result = await chrome.runtime.sendMessage({ ...message, ...fence() })
    if (result?.ok) notice = { text: done, until: Date.now() + 3000 }
    else feedback.textContent = result?.code === "sensitive" ? "This page could not be captured safely." :
      result?.code === "cleanup" ? "Control stopped. Chrome cleanup was not confirmed." : "This request did not complete. Check the tab and try again."
  } catch {
    feedback.textContent = "The extension connection is unavailable."
  } finally {
    busy = false
    control.disabled = false
    await read()
  }
}

capture.addEventListener("click", (event) => {
  if (event.isTrusted) void act({ type: "capture" }, capture, "Capture sent")
})
stop.addEventListener("click", (event) => {
  if (event.isTrusted) void act({ type: "stop" }, stop, "Control stopped")
})
resume.addEventListener("click", (event) => {
  if (event.isTrusted) void act({ type: "resume" }, resume, "Control resumed")
})

void read().then(glance)
setInterval(() => { if (!busy) void read() }, 1000)
setInterval(() => { void glance() }, 2000)
