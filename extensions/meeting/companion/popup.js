export function mountPopup(document, runtime, microphoneAccess) {
  const node = (id) => document.getElementById(id)
  const state = { phase: "checking", busy: false, paired: false, startCancelled: false }
  const activeStates = ["starting", "capturing", "reconnecting", "stopping"]
  let revision = 0
  let refreshing
  let actionError
  const recovery = {
    service_unavailable:
      "Capture service is unavailable. Reload YCoding Meet capture in chrome://extensions and reopen the popup.",
    service_restarted: "Service restarted. Recording stopped; press Start again only after checking consent.",
    pairing_expired: "Pairing expired. Copy a fresh one-use code from the TUI and pair again.",
    queue_overflow: "Audio delivery overflowed. Recording stopped; check the local bridge before starting again.",
    reconnect_exhausted:
      "Local bridge did not acknowledge audio. Recording stopped; check the bridge and pair again if needed.",
    stop_unacknowledged:
      "Recording stopped locally, but the bridge did not acknowledge Stop. Check the TUI meeting state.",
    microphone_access_required:
      "Allow the microphone in the YCoding tab that just opened, then come back and press Start again.",
    microphone_denied:
      "Microphone permission was denied. Allow it in Chrome, or disable microphone capture and press Start again.",
    tab_capture_denied: "Tab audio capture was denied. Select the Meet tab and press Start again.",
    select_meet_tab: "Select a Google Meet meeting tab before pressing Start.",
    consent_required: "Check participant consent before starting capture.",
    pair_first: "Copy a one-use pairing code from the TUI and pair first.",
    stop_before_pairing: "Stop recording before replacing the pairing.",
    pairing_rejected: "Pairing was rejected. Copy a fresh one-use code from the TUI.",
    pairing_unavailable: "Local bridge is unavailable. Check the TUI bridge address and try pairing again.",
    invalid_bridge_url: "Use the TUI bridge address: http://127.0.0.1:<port>.",
    invalid_pairing_code: "Copy the full one-use pairing code from the TUI.",
    permissions_revoked: "Chrome permission was revoked. Recording stopped; restore permission before starting again.",
    call_connection_closed: "Call connection closed. Recording stopped; a reconnect requires a fresh Start.",
    backend_stopped: "The TUI ended the meeting. Recording stopped.",
    inference_failed:
      "Speech recognition failed on part of the audio. Recording stopped; the transcript so far is saved. Use Retry failed audio on the live page or /meeting retry, then press Start again.",
    tab_closed: "Meet tab closed. Recording stopped.",
    tab_navigated: "Meet tab navigated. Recording stopped.",
    track_ended: "Audio track ended. Recording stopped.",
    audio_processor_failed:
      "The audio processor failed. Recording stopped; reopen the companion and start again with consent.",
  }
  const describe = (reason) =>
    recovery[reason] ??
    "Recording could not continue. Stop, check the TUI and Chrome permissions, then start again with consent."
  const render = (view) => {
    const wasActive = activeStates.includes(state.phase)
    Object.assign(state, view)
    const active = activeStates.includes(state.phase)
    if (active) {
      node("consent").checked = true
      if (typeof state.microphone === "boolean") node("microphone").checked = state.microphone
    }
    if (wasActive && !active) node("consent").checked = false
    const names = {
      checking: "Checking",
      unpaired: "Not paired",
      ready: "Ready",
      starting: "Starting",
      capturing: "Capturing",
      reconnecting: "Reconnecting",
      stopping: "Stopping",
      error: "Error",
      stopped: "Stopped",
    }
    node("status").textContent = names[state.phase] ?? "Error"
    node("error").textContent = state.reason ? describe(state.reason) : ""
    node("error").hidden = !state.reason
    node("status").dataset.active = String(active)
    node("pairing").hidden = state.paired
    node("capture").hidden = !state.paired && !active
    node("start").disabled = state.busy || active || !node("consent").checked
    node("stop").disabled = !active
    node("forget").disabled = state.busy || active
    node("consent").disabled = active
    node("microphone").disabled = active
    node("pair").disabled = state.busy || state.phase === "checking"
    node("pair").ariaBusy = String(state.busy)
  }
  const request = async (message) => {
    const expected = revision
    const view = await runtime.sendMessage(message)
    if (expected !== revision) return
    if (view?.error) throw new Error(view.error)
    if (message.type === "status" && actionError && !activeStates.includes(view.phase)) {
      render({ ...view, phase: "error", reason: actionError })
      return
    }
    render({ ...view, reason: view.reason })
  }
  const action = async (callback) => {
    if (state.busy) return
    const expected = ++revision
    actionError = undefined
    state.busy = true
    state.reason = undefined
    render(state)
    try {
      await callback()
    } catch (error) {
      if (expected !== revision) return
      actionError = error.message
      render({ phase: "error", reason: error.message })
    }
    if (expected !== revision) return
    state.busy = false
    render(state)
  }
  node("pairing").addEventListener("submit", (event) => {
    event.preventDefault()
    const code = node("code").value
    node("code").value = ""
    return action(() => request({ type: "pair", url: node("url").value.trim(), code }))
  })
  node("capture").addEventListener("submit", (event) => {
    event.preventDefault()
    return action(async () => {
      if (!node("consent").checked) throw new Error("consent_required")
      const expected = revision
      const microphone = node("microphone").checked
      state.startCancelled = false
      state.phase = "starting"
      state.reason = undefined
      state.microphone = microphone
      render(state)
      if (microphone) {
        const permission = await microphoneAccess.state()
        if (state.startCancelled || expected !== revision) return
        if (permission !== "granted") {
          await microphoneAccess.openAccessPage()
          throw new Error("microphone_access_required")
        }
      }
      if (state.startCancelled || expected !== revision) return
      await request({ type: "start", consent: true, microphone })
    })
  })
  node("stop").addEventListener("click", () => {
    const expected = ++revision
    actionError = undefined
    state.startCancelled = true
    state.busy = true
    state.phase = "stopping"
    state.reason = undefined
    render(state)
    return request({ type: "stop" })
      .catch((error) => {
        if (expected !== revision) return
        actionError = error.message
        render({ phase: "error", reason: error.message })
      })
      .finally(() => {
        if (expected !== revision) return
        state.busy = false
        render(state)
      })
  })
  node("forget").addEventListener("click", () => action(() => request({ type: "forget" })))
  node("consent").addEventListener("change", () => render(state))
  render(state)
  return {
    refresh: () => {
      if (state.busy) return Promise.resolve()
      if (refreshing) return refreshing
      const expected = revision
      refreshing = request({ type: "status" })
        .catch((error) => {
          if (expected === revision && !state.busy) render({ phase: "error", reason: "service_unavailable" })
          throw error
        })
        .finally(() => {
          refreshing = undefined
        })
      return refreshing
    },
    render,
  }
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  const popup = mountPopup(document, chrome.runtime, {
    state: () =>
      navigator.permissions.query({ name: "microphone" }).then(
        (permission) => permission.state,
        () => "prompt",
      ),
    openAccessPage: () => chrome.tabs.create({ url: chrome.runtime.getURL("microphone.html") }),
  })
  void popup.refresh().catch(() => {})
  const timer = setInterval(() => {
    void popup.refresh().catch(() => {})
  }, 1000)
  globalThis.addEventListener("pagehide", () => clearInterval(timer), { once: true })
}
