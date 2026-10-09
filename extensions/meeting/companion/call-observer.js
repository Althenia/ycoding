export function observeCallConnection() {
  const prototype = globalThis.RTCPeerConnection?.prototype
  if (!prototype) throw new Error("WebRTC observation unavailable")
  const original = prototype.close
  const close = function (...args) {
    const result = original.apply(this, args)
    document.dispatchEvent(new Event("ycoding-meeting-connection-ended"))
    return result
  }
  const cleanup = () => {
    if (prototype.close === close) prototype.close = original
    document.removeEventListener("ycoding-meeting-observer-remove", cleanup)
  }
  document.addEventListener("ycoding-meeting-observer-remove", cleanup)
  prototype.close = close
}

export function forwardCallConnection(captureID) {
  const ended = () => {
    void chrome.runtime.sendMessage({ type: "call-ended", captureID }).catch(() => {})
  }
  const cleanup = () => {
    document.removeEventListener("ycoding-meeting-connection-ended", ended)
    globalThis.removeEventListener("pagehide", ended)
    chrome.runtime.onMessage.removeListener(message)
  }
  const message = (input) => {
    if (input.type !== "remove-call-observer") return
    document.dispatchEvent(new Event("ycoding-meeting-observer-remove"))
    cleanup()
  }
  document.addEventListener("ycoding-meeting-connection-ended", ended)
  globalThis.addEventListener("pagehide", ended)
  chrome.runtime.onMessage.addListener(message)
}
