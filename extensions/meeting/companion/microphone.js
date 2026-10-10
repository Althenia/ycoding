export function mountMicrophoneAccess(document, mediaDevices, openSiteSettings) {
  const node = (id) => document.getElementById(id)
  const request = async () => {
    node("allow").disabled = true
    node("status").textContent = "Waiting for Chrome's microphone prompt…"
    const stream = await mediaDevices
      .getUserMedia({ audio: { echoCancellation: true }, video: false })
      .catch(() => undefined)
    if (!stream) {
      node("status").textContent =
        "Microphone was not allowed. Press Allow microphone and choose Allow while visiting the site. If Chrome does not ask, open Chrome site settings and set Microphone to Allow."
      node("allow").disabled = false
      node("settings").hidden = false
      return
    }
    stream.getTracks().forEach((track) => track.stop())
    node("settings").hidden = true
    node("status").textContent = "Microphone allowed. Close this tab, return to the Meet tab, and press Start again."
  }
  node("allow").addEventListener("click", request)
  node("settings").addEventListener("click", () => openSiteSettings())
  return { request }
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void mountMicrophoneAccess(document, navigator.mediaDevices, () =>
    chrome.tabs.create({
      url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}`,
    }),
  ).request()
}
