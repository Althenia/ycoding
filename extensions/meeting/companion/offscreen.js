import { createCapture } from "./capture.js"

const state = { epoch: undefined, heartbeat: undefined }
const capture = createCapture({
  mediaDevices: navigator.mediaDevices,
  AudioContext,
  AudioWorkletNode,
  fetch: (input, init) => fetch(input, init),
  workletURL: chrome.runtime.getURL("worklet.js"),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onState: (value) => {
    void chrome.runtime.sendMessage({ type: "capture-state", state: value, epoch: state.epoch }).catch(() => {
      void capture.stop("service_unavailable")
    })
  },
})
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message.target !== "offscreen" ||
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    (sender.url !== undefined && sender.url !== chrome.runtime.getURL("service-worker.js"))
  )
    return false
  if (message.type === "stop") {
    clearInterval(state.heartbeat)
    void capture.stop(message.reason).then(
      () => reply({ ok: true }),
      () => reply({ ok: false, error: "cleanup_failed" }),
    )
    return true
  }
  if (message.type !== "start" || capture.active()) return false
  state.epoch = message.epoch
  state.heartbeat = setInterval(() => {
    void chrome.runtime.sendMessage({ type: "lease" }).then(
      (result) => {
        if (result?.epoch === state.epoch) return undefined
        clearInterval(state.heartbeat)
        return capture.stop("service_restarted")
      },
      () => {
        clearInterval(state.heartbeat)
        return capture.stop("service_unavailable")
      },
    )
  }, 1000)
  void capture.start(message.options).then(
    () => reply({ ok: true }),
    (error) => {
      clearInterval(state.heartbeat)
      reply({ ok: false, error: error.message })
    },
  )
  return true
})
