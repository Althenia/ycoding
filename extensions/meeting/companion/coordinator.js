import { bridgeURL, meetURL } from "./protocol.js"
import { observeCallConnection, forwardCallConnection } from "./call-observer.js"

export function createCoordinator(environment) {
  const api = environment.chrome
  const epoch = crypto.randomUUID()
  const state = {
    pair: undefined,
    capture: undefined,
    phase: "unpaired",
    reason: undefined,
    starting: false,
    stopping: undefined,
    generation: 0,
    pairing: false,
  }
  const status = () => ({
    phase: state.phase,
    reason: state.reason,
    paired: Boolean(state.pair),
    microphone: state.capture?.microphone ?? false,
    tabID: state.capture?.tabID,
    url: state.pair?.url,
  })
  const badge = async () => {
    const text = ["capturing", "starting", "reconnecting", "stopping"].includes(state.phase)
      ? "REC"
      : state.phase === "error"
        ? "!"
        : ""
    await api.action.setBadgeBackgroundColor({ color: text === "!" ? "#505b6b" : "#28753e" })
    await api.action.setBadgeText({ text })
    await api.action.setTitle({
      title: `YCoding Meet capture: ${state.phase}${state.reason ? ` (${state.reason})` : ""}`,
    })
  }
  const postStop = async (capture, reason) => {
    if (!capture || !state.pair) return false
    const response = await environment
      .fetch(`${state.pair.url}/capture`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.pair.token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "stop", captureID: capture.captureID, reason }),
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      })
      .catch(() => undefined)
    return response?.status === 200
  }
  const stop = async (reason = "user") => {
    state.generation++
    if (state.stopping) return state.stopping
    const capture = state.capture
    if (!capture) return status()
    state.phase = "stopping"
    state.stopping = (async () => {
      await badge()
      const result = await environment
        .sendOffscreen({ target: "offscreen", type: "stop", reason, epoch })
        .catch(() => undefined)
      await api.tabs.sendMessage(capture.tabID, { type: "remove-call-observer" }).catch(() => undefined)
      await api.offscreen.closeDocument().catch(() => undefined)
      if (!result?.ok && !(await postStop(capture, reason))) {
        state.phase = "error"
        state.reason = "stop_unacknowledged"
      }
      if (state.capture === capture) state.capture = undefined
      await api.storage.session.remove(["capture"])
      if (state.phase !== "error") {
        state.phase = ["capture_failed", "permissions_revoked", "service_restarted"].includes(reason)
          ? "error"
          : state.pair
            ? "ready"
            : "unpaired"
        state.reason = ["user", "keyboard", "unpaired"].includes(reason) ? undefined : reason
      }
      await badge()
      state.stopping = undefined
      return status()
    })()
    return state.stopping
  }
  const initialize = async () => {
    await api.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    const saved = await api.storage.session.get(["pair", "capture"])
    state.pair = saved.pair
    state.phase = state.pair ? "ready" : "unpaired"
    await api.offscreen.closeDocument().catch(() => undefined)
    if (saved.capture) {
      await api.tabs.sendMessage(saved.capture.tabID, { type: "remove-call-observer" }).catch(() => undefined)
      await postStop(saved.capture, "service_restarted")
      await api.storage.session.remove(["capture"])
      state.phase = "error"
      state.reason = "service_restarted"
    }
    await badge()
  }
  const start = async (message) => {
    if (message.consent !== true) throw new Error("consent_required")
    if (typeof message.microphone !== "boolean") throw new Error("invalid_microphone_choice")
    if (!state.pair) throw new Error("pair_first")
    if (state.pairing) throw new Error("pairing_in_progress")
    if (state.capture || state.starting || state.stopping) throw new Error("capture_already_active")
    state.starting = true
    const generation = ++state.generation
    let offscreenCreated = false
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true })
      if (generation !== state.generation) throw new Error("capture_cancelled")
      const tab = tabs[0]
      if (!Number.isInteger(tab?.id) || !meetURL(tab.url)) throw new Error("select_meet_tab")
      const capture = { captureID: crypto.randomUUID(), tabID: tab.id, microphone: message.microphone, epoch }
      state.capture = capture
      state.phase = "starting"
      state.reason = undefined
      await api.storage.session.set({ capture })
      await badge()
      const check = () => {
        if (state.capture !== capture || state.stopping) throw new Error("capture_cancelled")
      }
      await api.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Explicitly consented Google Meet tab audio and optional microphone capture",
      })
      offscreenCreated = true
      check()
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        func: forwardCallConnection,
        args: [capture.captureID],
      })
      await api.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: observeCallConnection })
      check()
      const streamID = await api.tabCapture.getMediaStreamId({ targetTabId: tab.id })
      check()
      const result = await environment.sendOffscreen({
        target: "offscreen",
        type: "start",
        epoch,
        options: { ...state.pair, ...capture, streamID, consent: true },
      })
      check()
      if (!result?.ok) throw new Error(result?.error ?? "capture_start_failed")
      state.phase = "capturing"
      await badge()
      return status()
    } catch (error) {
      if (offscreenCreated && !state.capture) await api.offscreen.closeDocument().catch(() => undefined)
      const reason = [
        "select_meet_tab",
        "microphone_denied",
        "tab_capture_denied",
        "pairing_expired",
        "capture_cancelled",
      ].includes(error.message)
        ? error.message
        : "capture_start_failed"
      state.phase = "error"
      state.reason = reason
      await stop(reason)
      await badge()
      throw new Error(reason)
    } finally {
      state.starting = false
    }
  }
  const handle = async (message, sender) => {
    if (sender.id !== api.runtime.id || !message || typeof message !== "object") throw new Error("untrusted_sender")
    if (message.type === "call-ended") {
      if (!state.capture || sender.tab?.id !== state.capture.tabID || message.captureID !== state.capture.captureID)
        throw new Error("untrusted_sender")
      return stop("call_connection_closed")
    }
    if (sender.url === api.runtime.getURL("offscreen.html")) {
      if (message.type === "lease") return { epoch }
      if (
        message.type !== "capture-state" ||
        message.epoch !== epoch ||
        message.state?.captureID !== state.capture?.captureID
      )
        throw new Error("untrusted_sender")
      if (!["starting", "capturing", "reconnecting", "error", "stopped"].includes(message.state.phase))
        throw new Error("invalid_state")
      state.phase = message.state.phase
      state.reason = message.state.reason
      if (state.reason === "pairing_expired") {
        state.pair = undefined
        await api.storage.session.remove(["pair"])
      }
      await badge()
      if (state.phase === "stopped" || state.phase === "error") {
        void stop(state.reason ?? "capture_failed")
      }
      return { ok: true }
    }
    if (sender.url !== api.runtime.getURL("popup.html")) throw new Error("untrusted_sender")
    if (message.type === "status") return status()
    if (message.type === "start") return start(message)
    if (message.type === "stop") return stop("user")
    if (message.type === "forget") {
      await stop("unpaired")
      state.pair = undefined
      await api.storage.session.remove(["pair"])
      state.phase = "unpaired"
      state.reason = undefined
      await badge()
      return status()
    }
    if (message.type !== "pair") throw new Error("invalid_operation")
    if (state.capture || state.starting || state.stopping || state.pairing) throw new Error("stop_before_pairing")
    const url = bridgeURL(message.url)
    if (typeof message.code !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(message.code))
      throw new Error("invalid_pairing_code")
    state.pairing = true
    try {
      const response = await environment
        .fetch(`${url}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: message.code }),
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        })
        .catch(() => {
          throw new Error("pairing_unavailable")
        })
      if (!response.ok) throw new Error("pairing_rejected")
      const result = await response.json().catch(() => {
        throw new Error("pairing_rejected")
      })
      if (typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token))
        throw new Error("pairing_rejected")
      state.pair = { url, token: result.token }
      await api.storage.session.set({ pair: state.pair })
      state.phase = "ready"
      state.reason = undefined
      await badge()
      return status()
    } finally {
      state.pairing = false
    }
  }
  return {
    initialize,
    handle,
    stop,
    tabRemoved: (tabID) => (state.capture?.tabID === tabID ? stop("tab_closed") : Promise.resolve()),
    tabUpdated: (tabID, change) =>
      state.capture?.tabID === tabID && (change.status === "loading" || change.url !== undefined)
        ? stop("tab_navigated")
        : Promise.resolve(),
    permissionsRemoved: () => stop("permissions_revoked"),
    captureChanged: (info) =>
      state.capture?.tabID === info.tabId && ["stopped", "error"].includes(info.status)
        ? stop(info.status === "error" ? "capture_failed" : "track_ended")
        : Promise.resolve(),
  }
}
