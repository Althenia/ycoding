import {
  decodeModelChoice,
  describeView,
  encodeModelChoice,
  ownerBindingStatus,
  ownerModelStatus,
  questionError,
  readCredentials,
  resolveAskSelection,
} from "/view/model.js"
import { createCapture } from "/view/capture.js"

const credentials = readCredentials(location.hash)
const key = credentials?.key
let ownerKey = credentials?.owner
history.replaceState(null, "", location.pathname)
const node = (id) => document.getElementById(id)
const text = (id, value) => {
  if (node(id).textContent !== value) node(id).textContent = value
}
const records = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [])
let current,
  connected = false,
  denied = false,
  reading = false,
  controlPending = false,
  askPending = false,
  stopPending = false
let retryQuestion,
  polling,
  activeRead,
  closed = false
let original = false,
  follow = true,
  reviewRetained = false
let ownerData,
  ownerDraft = [],
  ownerLoadedAskValue,
  ownerLoadedKnowledge,
  ownerPending = false,
  ownerDenied = false
const requests = new Set()
const segments = new Map()
const chats = new Map()
const captureState = { phase: "idle", reason: undefined }
const capture = createCapture({
  mediaDevices: navigator.mediaDevices,
  AudioContext,
  AudioWorkletNode,
  fetch: window.fetch.bind(window),
  workletURL: "/view/worklet.js",
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  microphonePermission: async () =>
    navigator.permissions
      .query({ name: "microphone" })
      .then((value) => value.state)
      .catch(() => "prompt"),
  onState: (value) => {
    Object.assign(captureState, value)
    preserveReader(renderCapture)
    updateControls()
    if (value.phase === "stopped" || value.phase === "error") void refresh()
  },
})

async function request(path, body) {
  const abort = new AbortController()
  requests.add(abort)
  const timeout = setTimeout(() => abort.abort(), body ? 175000 : 10000)
  try {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: abort.signal,
    })
    const value = await response.json()
    if (response.status === 401) {
      denied = true
      connected = false
      clearTimeout(polling)
      text("connection", "This view key is invalid. Reopen the meeting from YCoding.")
      node("connection").dataset.tone = "error"
      updateControls()
      throw new Error("unauthorized")
    }
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "request_failed")
    return value
  } finally {
    clearTimeout(timeout)
    requests.delete(abort)
  }
}

function updateControls() {
  const view = current ? describeView(current) : undefined
  const available = connected && !denied
  text("runtime-readiness", available ? "Connected" : denied ? "Invalid view key" : "Unavailable")
  node("start").disabled =
    !available ||
    controlPending ||
    capture.active() ||
    current?.meeting?.status !== "ready" ||
    !node("consent").checked ||
    !node("policy").checked
  node("consent").disabled = capture.active()
  node("policy").disabled = capture.active()
  node("microphone").disabled = capture.active()
  node("stop").disabled = !available || controlPending || stopPending || !view?.canStop
  node("stop").setAttribute(
    "aria-describedby",
    controlPending || stopPending ? "control-feedback" : !available ? "connection" : "meeting-status",
  )
  node("retry-audio").disabled = !available || controlPending
  node("retry-audio").setAttribute("aria-describedby", "control-feedback")
  node("ask").disabled = !available || askPending || current?.ask?.busy === true || !current?.meeting
  node("retry-question").disabled = node("ask").disabled
  node("confirm-stop").disabled = node("stop").disabled
  node("confirm-stop").setAttribute("aria-describedby", "control-feedback")
  if (!available)
    text(
      "chat-feedback",
      denied
        ? "Reopen the meeting from YCoding with a valid view key to ask AI."
        : "Local runtime unavailable. Wait for the connection before asking AI.",
    )
  if ((available && askPending) || current?.ask?.busy)
    text("chat-feedback", "Answering · one question at a time; other submits are disabled.")
  if (!current?.meeting && !askPending)
    text("chat-feedback", "Arm a meeting in YCoding before asking. One question at a time.")
  if (
    available &&
    current?.meeting &&
    !askPending &&
    !current?.ask?.busy &&
    /Waiting for|Local runtime unavailable/.test(node("chat-feedback").textContent)
  )
    text("chat-feedback", "Idle · one question at a time · advisory only.")
}

function renderCapture() {
  const view = describeView(current ?? {})
  const recording =
    ["capturing", "reconnecting"].includes(captureState.phase) ||
    (current?.meeting?.status === "recording" && !["stopping", "stopped", "error"].includes(captureState.phase))
  const phase = recording
    ? "live"
    : view.phase === "recovery" && reviewRetained
      ? "review"
      : view.phase === "recovery"
        ? "recovery"
        : stopPending || captureState.phase === "stopping" || view.phase === "live"
          ? "finalizing"
          : view.phase
  if (node("passage").dataset.phase !== phase) {
    node("passage").dataset.phase = phase
    if (phase === "review") node("workspace").insertBefore(node("insights"), node("transcript"))
    if (phase !== "review") node("workspace").insertBefore(node("insights"), node("owner-panel"))
  }
  for (const stage of ["setup", "live", "finalizing", "review"]) {
    if (stage === phase || (phase === "recovery" && stage === "finalizing"))
      node(`stage-${stage}`).setAttribute("aria-current", "step")
    if (stage !== phase && !(phase === "recovery" && stage === "finalizing"))
      node(`stage-${stage}`).removeAttribute("aria-current")
  }
  text("stage-finalizing", phase === "recovery" ? "03 Needs attention" : "03 Finalizing")
  node("ownership").hidden = !recording
  node("capture-gate").hidden = phase !== "setup"
  node("readiness").hidden = phase !== "setup"
  text("runtime-title", phase === "setup" ? "Readiness" : "Runtime")
  text("capture-readiness", typeof navigator.mediaDevices?.getDisplayMedia === "function" ? "Available" : "Unavailable")
  node("settings-help").hidden = recording
  node("capture-form").hidden = recording
  node("stop").hidden = !recording
  node("finalization").hidden = phase !== "finalizing"
  const analyzing = current?.meeting?.status === "stopped" && current?.analysis?.status === "analyzing"
  text("meeting-status", phase === "finalizing" && !analyzing ? "Finalizing audio" : view.status)
  text("finalization-title", analyzing ? "Finalizing analysis" : "Finalizing audio")
  text(
    "finalization-description",
    analyzing
      ? "Audio capture has ended. YCoding is analyzing the retained transcript."
      : "Capture is stopping and remaining audio is being processed. The transcript stays readable.",
  )
  text("finalization-audio", analyzing ? "Audio · capture ended" : "Audio · finalizing")
  text("finalization-analysis", analyzing ? "Analysis · analyzing" : "Analysis · waiting")
  node("review-retained").hidden = view.phase !== "recovery" || phase === "review"
  node("recovery-limit").hidden = !current?.audio?.error
  node("questions-panel").hidden = phase !== "review"
  node("actions-panel").hidden = phase !== "review"
  node("handoff").hidden = !["review", "recovery"].includes(phase)
  text("summary-title", phase === "review" ? "Summary" : "Working summary")
  const failures = {
    no_tab_audio:
      "Tab audio was not shared. Nothing is recording. Re-share the Meet tab and tick Share tab audio, with fresh consent.",
    picker_cancelled: "The share picker was cancelled. Nothing is recording. You can Start again with fresh consent.",
    picker_failed:
      "Chrome could not share this tab. Nothing is recording. Check browser capture permissions, then Start again.",
    microphone_denied:
      "Microphone was denied. Nothing is recording. Allow it in Chrome site settings, or use tab audio only with a fresh Start.",
    microphone_blocked:
      "Microphone is blocked for this origin. Nothing is recording. Change Chrome site settings, or use tab audio only with a fresh Start.",
    inference_failed:
      "Speech recognition failed and recording stopped. The transcript so far is saved. Retry failed audio below; it never restarts recording.",
    track_ended:
      "Chrome Stop sharing ended capture. The transcript so far is saved; processing state is reported above.",
    user: "Capture stopped. The retained transcript remains available; processing state is reported above.",
    backend_stopped: "The runtime stopped recording. Inspect its state before starting again.",
    unauthorized: "This view key is invalid. Reopen the meeting from YCoding.",
  }
  const progress = {
    picker: "Chrome’s share picker is open. Choose the Meet tab and tick Share tab audio.",
    microphone_prompt: "Tab audio is ready. Chrome is asking for microphone access; recording waits for permission.",
    microphone_allowed: "Microphone allowed for this origin. Preparing local audio capture…",
    capturing: "Recording live · tab playback is unchanged; microphone is never played to speakers.",
    reconnecting:
      "Audio backpressure · waiting for an unaccepted frame to be admitted; recording will stop if pressure persists.",
  }
  text(
    "capture-title",
    recording
      ? "Recording live"
      : captureState.phase === "stopping"
        ? "Finalizing capture"
        : captureState.phase === "picker"
          ? "Choose your Meet tab"
          : "Choose what to capture",
  )
  text(
    "capture-description",
    recording
      ? "Meet tab audio is being captured. Source status is reported by the runtime; your microphone is never played to speakers."
      : "Choose the Google Meet tab in Chrome’s share picker and tick “Share tab audio”. Sharing a screen or a window may not include tab audio.",
  )
  text(
    "capture-feedback",
    failures[captureState.reason] ||
      progress[captureState.phase] ||
      (captureState.phase === "error"
        ? "Capture failed or delivery is unconfirmed. Sources were released. Inspect runtime state before a fresh Start; capture never auto-resumes."
        : current?.meeting?.status === "ready" || !current?.meeting
          ? "Nothing is recording."
          : "Capture has ended. The retained transcript remains available."),
  )
  node("tab-only").hidden = !["microphone_denied", "microphone_blocked"].includes(captureState.reason)
  text(
    "start-reason",
    current?.meeting?.status !== "ready"
      ? "Arm a ready meeting in YCoding before a fresh Start. Audio retry does not arm or restart capture."
      : "Acknowledge both checks for every Start. This tab must stay open while recording.",
  )
}

function preserveReader(render) {
  const top = node("ownership").hidden ? 0 : node("ownership").getBoundingClientRect().bottom
  const anchor = follow
    ? undefined
    : [...segments.values()].find(
        (row) => row.getBoundingClientRect().bottom > top && row.getBoundingClientRect().top < innerHeight,
      )
  const before = anchor?.getBoundingClientRect().top
  render()
  if (anchor?.isConnected) window.scrollBy(0, anchor.getBoundingClientRect().top - before)
}

function timestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unreported time"
  const seconds = Math.max(0, Math.floor(value / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function renderSegments() {
  const list = records(current?.segments)
  const reported = new Set(list.map((segment) => segment.id))
  let changed = false
  for (const segment of list) {
    const id = typeof segment.id === "string" ? segment.id : ""
    if (!id) continue
    let row = segments.get(id)
    if (!row) {
      row = document.createElement("article")
      row.className = "segment"
      row.dataset.segmentId = id
      row.tabIndex = -1
      const meta = document.createElement("div")
      meta.className = "meta"
      row.append(meta, document.createElement("p"))
      node("segments").append(row)
      segments.set(id, row)
      changed = true
    }
    row.dataset.source = segment.source
    row.dataset.state = segment.state
    const meta = `${timestamp(segment.startMs)} · ${segment.source === "remote" ? "Remote / Meet tab" : segment.source === "microphone" ? "You / microphone" : "Source unreported"} · ${segment.state === "temporary" ? "Temporary" : segment.state === "final" ? "Final" : "State unreported"} · ${original ? "Original" : "Corrected"} · ${id}`
    const content = original ? segment.rawText : segment.text
    if (row.firstChild.textContent !== meta) row.firstChild.textContent = meta
    if (row.lastChild.textContent !== (content ?? "Text unreported")) {
      row.lastChild.textContent = content ?? "Text unreported"
      changed = true
    }
  }
  for (const [id, row] of segments) {
    if (reported.has(id)) continue
    row.remove()
    segments.delete(id)
    changed = true
  }
  node("transcript-empty").hidden = list.length > 0
  node("transcript-window").hidden = !(list[0]?.sequence > 1)
  if (follow && changed && !node("chat-panel").contains(document.activeElement) && !node("stop-dialog").open)
    node("segments").lastElementChild?.scrollIntoView({ block: "end" })
}

function renderFindings() {
  if (!Array.isArray(current?.findings)) {
    text("findings-title", "Findings · unreported")
    node("finding-list").replaceChildren()
    node("finding-list").dataset.version = "unreported"
    for (const id of ["actions-list", "questions-list"]) text(id, "Findings unreported.")
    return
  }
  const list = records(current?.findings)
  const review = node("passage").dataset.phase === "review"
  const version = JSON.stringify([review, list])
  if (node("finding-list").dataset.version === version) return
  node("finding-list").dataset.version = version
  const remaining = review ? list.filter((finding) => !["action", "question"].includes(finding.kind)) : list
  text("findings-title", `${remaining.length} ${review ? "other findings" : "findings"} · statuses from YCoding`)
  const renderList = (id, findings, empty) => {
    node(id).replaceChildren(
      ...findings.map((finding) => {
        const entry = document.createElement("article")
        entry.className = "finding"
        const label = document.createElement("h3")
        label.textContent = `${finding.kind || "Kind unreported"} · ${finding.status || "Status unreported"}`
        const content = document.createElement("p")
        content.textContent = finding.summary ?? "Summary unreported"
        entry.append(label, content)
        if (finding.owner || finding.deadline) {
          const assignment = document.createElement("p")
          assignment.className = "hint"
          assignment.textContent = [
            finding.owner && `Owner · ${finding.owner}`,
            finding.deadline && `Due · ${finding.deadline}`,
          ]
            .filter(Boolean)
            .join(" / ")
          entry.append(assignment)
        }
        const evidence = document.createElement("div")
        evidence.className = "evidence-links"
        const refs = Array.isArray(finding.sourceSegmentIds) ? finding.sourceSegmentIds : []
        for (const id of refs.filter((id) => typeof id === "string")) {
          const button = document.createElement("button")
          button.type = "button"
          button.dataset.evidenceId = id
          button.textContent = `Evidence · ${id}`
          button.addEventListener("click", () => {
            follow = false
            updateFollow()
            const row = segments.get(id)
            if (!row) {
              text(
                "evidence-feedback",
                "This evidence segment is outside the current transcript window. Read the full transcript in YCoding.",
              )
              node("evidence-feedback").scrollIntoView({ block: "center" })
              node("transcript").focus({ preventScroll: true })
              return
            }
            text("evidence-feedback", `Evidence · ${id}`)
            for (const other of segments.values()) other.classList.remove("evidence")
            row.classList.add("evidence")
            row.scrollIntoView({ block: "center" })
            row.focus({ preventScroll: true })
          })
          evidence.append(button)
        }
        entry.append(evidence)
        return entry
      }),
    )
    if (!findings.length) {
      const message = document.createElement("p")
      message.className = "hint"
      message.textContent = empty
      node(id).append(message)
    }
  }
  renderList("finding-list", remaining, "No other findings reported.")
  renderList(
    "actions-list",
    list.filter((finding) => finding.kind === "action"),
    "No proposed actions reported.",
  )
  renderList(
    "questions-list",
    list.filter((finding) => finding.kind === "question"),
    "No open questions reported.",
  )
}

function renderChat() {
  const list = records(current?.ask?.history)
  for (const entry of list) {
    if (typeof entry.id !== "string") continue
    let row = chats.get(entry.id)
    if (!row) {
      if (!chats.size) node("chat-history").replaceChildren()
      row = document.createElement("article")
      row.className = "chat-entry"
      row.append(document.createElement("p"), document.createElement("p"))
      node("chat-history").append(row)
      chats.set(entry.id, row)
    }
    const question = `You · ${entry.question || "Question unreported"}`
    const answer =
      entry.status === "pending"
        ? "Pending · reading the transcript so far…"
        : entry.status === "error"
          ? questionError(entry.error)
          : `Advisory · ${entry.answer || "Answer unreported"}`
    if (row.firstChild.textContent !== question) row.firstChild.textContent = question
    if (row.lastChild.textContent !== answer) row.lastChild.textContent = answer
  }
  const retained = new Set(list.map((entry) => entry.id))
  for (const [id, row] of chats) {
    if (retained.has(id)) continue
    row.remove()
    chats.delete(id)
  }
  if (!askPending && list.at(-1)?.status === "error" && !retryQuestion) {
    retryQuestion = list.at(-1).question
    node("retry-question").hidden = false
    text("chat-feedback", questionError(list.at(-1).error))
  }
}

function render(value) {
  if (!value || typeof value !== "object" || !value.health || !value.audio || !Array.isArray(value.segments))
    throw new Error("invalid_state")
  if (current?.meeting?.id && current.meeting.id !== value.meeting?.id) {
    segments.forEach((row) => row.remove())
    segments.clear()
    chats.clear()
    node("chat-history").replaceChildren()
    retryQuestion = undefined
    node("retry-question").hidden = true
    reviewRetained = false
  }
  current = value
  connected = true
  if (["capturing", "reconnecting"].includes(captureState.phase) && current.meeting?.status !== "recording")
    void capture.heartbeat()
  preserveReader(() => {
    const view = describeView(current)
    text("meeting-title", current.meeting?.title || "YCoding Meeting")
    text("meeting-status", view.status)
    node("meeting-status").dataset.tone = view.tone
    text("health-status", view.health)
    node("health-status").dataset.tone = view.tone
    text("source-status", `Remote · ${view.remote} / You · ${view.microphone}`)
    text("connection", "Connected to local runtime · page-owned capture")
    node("connection").dataset.tone = "ready"
    text("model", current.health?.model || "Model unreported")
    text(
      "device",
      `Device · ${current.health?.device || "Unreported"} / Provider · ${current.health?.provider || "Unreported"}`,
    )
    text("bridge", `Bridge · ${location.origin}`)
    for (const id of ["buffered", "processed", "backlog", "lag"]) text(id, view[id])
    node("recovery").hidden = !view.notice
    text("recovery-text", view.notice)
    text("error-detail", current.audio?.error || current.analysis?.error || current.health?.error || "")
    node("retry-audio").hidden = !view.canRetry
    text("summary-text", current.summary?.summary || "No summary yet.")
    text(
      "summary-status",
      current.summary?.final
        ? "Final summary · advisory"
        : `Analysis · ${current.analysis?.status || "Unreported"}${current.summary ? ` · through sequence ${current.summary.throughSequence ?? "Unreported"}` : ""}`,
    )
    renderCapture()
    renderSegments()
    renderFindings()
    renderChat()
  })
  updateControls()
}

async function refresh() {
  if (reading || denied || closed || !key) return
  reading = true
  try {
    const value = await request("/view/state")
    if (!closed) render(value)
  } catch {
    if (!closed && !denied) {
      connected = false
      text(
        "connection",
        `Local runtime unavailable${current ? " · last known transcript retained" : ""}. Keep YCoding running; reconnecting every 2 seconds.`,
      )
      node("connection").dataset.tone = "error"
      updateControls()
    }
  } finally {
    reading = false
  }
}

function poll() {
  clearTimeout(polling)
  if (closed || denied || !key) return
  activeRead = refresh().finally(() => {
    if (!closed && !denied) polling = setTimeout(poll, 2000)
  })
}

async function control(action) {
  if (controlPending || denied || !connected) return
  controlPending = true
  stopPending = action === "stop"
  text(
    "control-feedback",
    action === "retry" ? "Retrying retained failed audio…" : "Stopping capture and finalizing buffered audio…",
  )
  updateControls()
  clearTimeout(polling)
  await activeRead
  try {
    if (action === "stop" && capture.active()) await capture.stop("user")
    const value = await request("/view/control", { action })
    if (closed) return
    if (value?.error) throw new Error("operation_failed")
    if (action === "retry" && captureState.reason === "inference_failed") {
      captureState.phase = "stopped"
      captureState.reason = undefined
    }
    text(
      "control-feedback",
      action === "retry"
        ? "Failed audio retry completed. Capture has not restarted; arm a ready meeting in YCoding and give fresh consent here."
        : "Capture stopped. Review the reported processing state above.",
    )
  } catch {
    if (!closed && !denied)
      text(
        "control-feedback",
        "The operation failed or its outcome is unknown. State will refresh; inspect the result before retrying.",
      )
  } finally {
    controlPending = false
    stopPending = false
    updateControls()
    poll()
  }
}

async function ask(question) {
  if (askPending || current?.ask?.busy || denied || !connected) return
  if (!question.trim() || question.length > 2000) {
    text("chat-feedback", questionError("invalid_question"))
    node("question").setAttribute("aria-invalid", "true")
    node("question").focus()
    return
  }
  askPending = true
  retryQuestion = undefined
  node("retry-question").hidden = true
  node("question").removeAttribute("aria-invalid")
  text("chat-feedback", "Answering · one question at a time; other submits are disabled.")
  updateControls()
  try {
    const value = await request("/view/ask", { question: question.trim() })
    if (closed) return
    if (value?.status !== "answered") throw new Error(value?.error || "answer_failed")
    text("chat-feedback", "Answered · advisory only; no tools or actions were used.")
  } catch (error) {
    if (!closed && !denied) {
      retryQuestion = question
      node("retry-question").hidden = false
      text("chat-feedback", questionError(error instanceof Error ? error.message : "answer_failed"))
    }
  } finally {
    askPending = false
    updateControls()
    await refresh()
  }
}

async function ownerRequest(body) {
  const abort = new AbortController()
  requests.add(abort)
  const timeout = setTimeout(() => abort.abort(), 30000)
  try {
    const response = await fetch("/view/owner/settings", {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${ownerKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: abort.signal,
    })
    const value = await response.json()
    if (response.status === 401) {
      ownerDenied = true
      node("owner-form").hidden = true
      node("owner-retry").hidden = true
      text(
        "owner-feedback",
        "This owner link is invalid. The meeting view is unaffected. Reopen the owner link from YCoding to change settings.",
      )
      throw new Error("unauthorized")
    }
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "request_failed")
    return value
  } finally {
    clearTimeout(timeout)
    requests.delete(abort)
  }
}

function ownerOption(value, label, disabled = false) {
  const option = document.createElement("option")
  option.value = value
  option.textContent = label
  option.disabled = disabled
  return option
}

function selectedOwnerModel() {
  const choice = decodeModelChoice(node("owner-model").value)
  return records(ownerData?.models).find(
    (model) => choice && model.providerID === choice.providerID && model.id === choice.id,
  )
}

function renderOwnerVariants(selected) {
  const model = selectedOwnerModel()
  const variants = Array.isArray(model?.variants) ? model.variants.filter((id) => typeof id === "string") : []
  node("owner-variant").replaceChildren(
    ownerOption("", "Default variant"),
    ...variants.map((id) => ownerOption(id, id)),
    ...(selected && !variants.includes(selected) ? [ownerOption(selected, `${selected} · Unavailable`, true)] : []),
  )
  node("owner-variant").value = selected ?? ""
  node("owner-variant").disabled = !model || ownerPending
  const inherited = ownerData?.analysisModel
  text(
    "owner-model-status",
    model
      ? `Model availability · ${ownerModelStatus(model)}`
      : node("owner-model").value === "inherit"
        ? inherited && typeof inherited === "object"
          ? `Ask AI inherits the analysis model · ${inherited.providerID} · ${inherited.id}${inherited.variant ? ` · variant ${inherited.variant}` : ""}${inherited.profile ? ` · profile ${inherited.profile}` : ""}`
          : "Ask AI inherits the analysis model setting."
        : "Model availability unreported",
  )
}

function renderOwnerBindings() {
  const servers = records(ownerData?.servers)
  const known = new Map(
    records(ownerData?.knowledge?.bindings).map((binding) => [`${binding.server}:${binding.write ?? ""}`, binding]),
  )
  node("owner-bindings").replaceChildren(
    ...ownerDraft.map((binding, index) => {
      const row = document.createElement("article")
      row.className = "owner-binding"
      const title = document.createElement("h3")
      title.textContent = binding.server
      const tools = document.createElement("p")
      tools.className = "mono"
      tools.textContent = `search · ${binding.search} / read · ${binding.read}${binding.write ? ` / write · ${binding.write}` : " / no write tool"}`
      const status = document.createElement("p")
      status.className = "hint"
      status.textContent = ownerBindingStatus(
        { ...binding, writeCapability: known.get(`${binding.server}:${binding.write ?? ""}`)?.writeCapability },
        servers,
      )
      const toggle = document.createElement("label")
      toggle.className = "check"
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = binding.enabled !== false
      box.disabled = ownerPending
      box.setAttribute("aria-label", `Use connector ${binding.server}`)
      box.addEventListener("change", () => {
        binding.enabled = box.checked
      })
      const label = document.createElement("span")
      label.textContent = "Use this connector"
      toggle.append(box, label)
      const remove = document.createElement("button")
      remove.type = "button"
      remove.textContent = `Remove ${binding.server} binding`
      remove.disabled = ownerPending
      remove.addEventListener("click", () => {
        ownerDraft.splice(index, 1)
        renderOwnerBindings()
        renderOwnerAdd()
      })
      row.append(title, tools, status, toggle, remove)
      return row
    }),
  )
  text(
    "owner-bindings-status",
    ownerDraft.length
      ? `${ownerDraft.length} of 4 connector bindings · saved bindings are checked against the live registry on every use.`
      : "No connector bindings. Analysis runs without canonical knowledge retrieval.",
  )
}

function renderOwnerAdd() {
  const servers = records(ownerData?.servers)
  const unbound = servers.filter((server) => !ownerDraft.some((binding) => binding.server === server.name))
  const current = node("owner-add-server").value
  node("owner-add-server").replaceChildren(
    ownerOption("", unbound.length ? "Choose a server" : "No unbound server reported"),
    ...unbound.map((server) =>
      ownerOption(server.name, `${server.name} · ${server.status ? `server ${server.status}` : "server unreported"}`),
    ),
  )
  if (unbound.some((server) => server.name === current)) node("owner-add-server").value = current
  const server = unbound.find((item) => item.name === node("owner-add-server").value)
  const tools = Array.isArray(server?.tools) ? server.tools.filter((name) => typeof name === "string") : []
  for (const [id, empty] of [
    ["owner-add-search", "Choose the search tool"],
    ["owner-add-read", "Choose the read tool"],
  ])
    node(id).replaceChildren(
      ownerOption("", tools.length ? empty : "No tools reported"),
      ...tools.map((name) => ownerOption(name, name)),
    )
  node("owner-add-write").replaceChildren(
    ownerOption("", "No write tool"),
    ...tools.map((name) => ownerOption(name, name)),
  )
  const full = ownerDraft.length >= 4
  for (const id of ["owner-add-server", "owner-add-search", "owner-add-read", "owner-add-write", "owner-add"])
    node(id).disabled = ownerPending || full || !servers.length
  if (full) text("owner-bindings-status", "4 of 4 connector bindings · remove one before adding another.")
}

function renderOwner(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.models) || !data.knowledge)
    throw new Error("invalid_owner_settings")
  ownerData = data
  ownerLoadedAskValue = data.askModel ?? "inherit"
  const savedBindings = records(data.knowledge.bindings).map((binding) => ({
    server: binding.server,
    search: binding.search,
    read: binding.read,
    ...(binding.write ? { write: binding.write } : {}),
    enabled: binding.enabled !== false,
  }))
  ownerLoadedKnowledge = JSON.stringify({ mcpEnabled: data.knowledge.mcpEnabled === true, bindings: savedBindings })
  ownerDraft = savedBindings.map((binding) => ({ ...binding }))
  node("owner-mcp").checked = data.knowledge.mcpEnabled === true
  const ask = data.askModel && typeof data.askModel === "object" ? data.askModel : undefined
  node("owner-model").replaceChildren(
    ownerOption("inherit", "Inherit analysis model"),
    ...records(data.models).map((model) => {
      const status = ownerModelStatus(model)
      const unavailable = status.startsWith("Unavailable")
      return ownerOption(
        encodeModelChoice(model.providerID, model.id),
        `${model.providerID} · ${model.name || model.id}${unavailable ? ` · ${status}` : ""}`,
        unavailable && !(ask && ask.providerID === model.providerID && ask.id === model.id),
      )
    }),
  )
  node("owner-model").value = ask ? encodeModelChoice(ask.providerID, ask.id) : "inherit"
  if (ask && !selectedOwnerModel()) {
    node("owner-model").append(
      ownerOption(encodeModelChoice(ask.providerID, ask.id), `${ask.providerID} · ${ask.id} · Unreported`),
    )
    node("owner-model").value = encodeModelChoice(ask.providerID, ask.id)
  }
  node("owner-profile").hidden = !ask?.profile
  if (ask?.profile)
    text(
      "owner-profile",
      `Profile ${ask.profile} is set for this provider. It carries across model and variant changes while the provider stays the same; choosing another provider drops it.`,
    )
  renderOwnerVariants(ask?.variant)
  renderOwnerBindings()
  renderOwnerAdd()
  node("owner-form").hidden = false
  node("owner-retry").hidden = true
}

async function loadOwner() {
  if (!ownerKey || ownerPending || ownerDenied || closed) return
  ownerPending = true
  text("owner-feedback", "Loading owner settings from the local runtime…")
  node("owner-retry").hidden = true
  try {
    const data = await ownerRequest()
    ownerPending = false
    renderOwner(data)
    text("owner-feedback", "Owner settings loaded. Nothing is saved until you choose Save owner settings.")
  } catch {
    if (!closed && !ownerDenied) {
      text(
        "owner-feedback",
        "Owner settings could not load. The meeting view is unaffected; retry when the runtime is ready.",
      )
      node("owner-retry").hidden = false
    }
  } finally {
    ownerPending = false
  }
}

async function saveOwner() {
  if (!ownerKey || ownerPending || ownerDenied || !ownerData) return
  const choice = decodeModelChoice(node("owner-model").value)
  const selected = choice
    ? { ...choice, ...(node("owner-variant").value ? { variant: node("owner-variant").value } : {}) }
    : "inherit"
  const askModel = resolveAskSelection(selected, ownerLoadedAskValue)
  const loaded = ownerLoadedAskValue
  const sameAsk =
    askModel === loaded ||
    (askModel !== "inherit" &&
      loaded &&
      typeof loaded === "object" &&
      askModel.providerID === loaded.providerID &&
      askModel.id === loaded.id &&
      (askModel.variant ?? "") === (loaded.variant ?? "") &&
      (askModel.profile ?? "") === (loaded.profile ?? ""))
  const knowledge = {
    mcpEnabled: node("owner-mcp").checked,
    bindings: ownerDraft.map((binding) => ({ ...binding, enabled: binding.enabled !== false })),
  }
  const update = {}
  if (!sameAsk) update.askModel = askModel
  if (JSON.stringify(knowledge) !== ownerLoadedKnowledge) update.knowledge = knowledge
  if (!Object.keys(update).length) {
    text("owner-feedback", "No owner setting changes to save.")
    return
  }
  ownerPending = true
  node("owner-model-fieldset").disabled = true
  node("owner-knowledge-fieldset").disabled = true
  node("owner-save").disabled = true
  text("owner-feedback", "Saving owner settings…")
  try {
    renderOwner(await ownerRequest(update))
    text(
      "owner-feedback",
      "Owner settings saved. The Ask AI model applies to future questions; connector changes apply to new retrieval.",
    )
    void refresh()
  } catch (error) {
    if (!closed && !ownerDenied) {
      text(
        "owner-feedback",
        error instanceof Error && error.message === "selection_unavailable"
          ? "A selected model, variant or connector tool is no longer available. Your edits are retained; choose a reported option and save again."
          : "Owner settings could not be saved or the outcome is unknown. Your edits are retained; retry loading before saving again.",
      )
      node("owner-retry").hidden = false
    }
  } finally {
    ownerPending = false
    node("owner-model-fieldset").disabled = false
    node("owner-knowledge-fieldset").disabled = false
    node("owner-save").disabled = false
    renderOwnerVariants(node("owner-variant").value || undefined)
    renderOwnerBindings()
    renderOwnerAdd()
  }
}

function updateFollow() {
  node("follow").setAttribute("aria-pressed", String(follow))
  text("follow", follow ? "Follow newest · on" : "Follow paused")
}
node("follow").addEventListener("click", () => {
  follow = !follow
  updateFollow()
  if (follow) node("segments").lastElementChild?.scrollIntoView({ block: "end" })
})
node("original").addEventListener("click", () => {
  original = !original
  node("original").setAttribute("aria-pressed", String(original))
  text("original", original ? "Show corrected" : "Show original")
  preserveReader(renderSegments)
})
window.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY >= 0 || node("chat-panel").contains(event.target) || node("stop-dialog").open) return
    follow = false
    updateFollow()
  },
  { passive: true },
)
node("retry-audio").addEventListener("click", () => control("retry"))
node("review-retained").addEventListener("click", () => {
  reviewRetained = true
  preserveReader(() => {
    renderCapture()
    renderFindings()
  })
  node("summary-title").scrollIntoView({ block: "start" })
  node("summary-title").focus({ preventScroll: true })
})
node("capture-form").addEventListener("change", updateControls)
node("capture-form").addEventListener("submit", (event) => {
  event.preventDefault()
  if (node("start").disabled) return
  const options = {
    key,
    captureID: crypto.randomUUID(),
    consent: node("consent").checked,
    policy: node("policy").checked,
    microphone: node("microphone").checked,
  }
  node("consent").checked = false
  node("policy").checked = false
  void capture.start(options).catch(() => {
    renderCapture()
    updateControls()
  })
})
node("tab-only").addEventListener("click", () => {
  node("microphone").checked = false
  node("consent").focus()
})
text("permission-origin", `Microphone origin · ${location.origin}`)
node("settings-help").addEventListener("click", () => node("settings-dialog").showModal())
node("leave-preview").addEventListener("click", () => node("leave-dialog").showModal())
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return
    const controls = [...dialog.querySelectorAll("button:not(:disabled)")]
    const edge = event.shiftKey ? controls[0] : controls.at(-1)
    if (document.activeElement !== edge) return
    event.preventDefault()
    ;(event.shiftKey ? controls.at(-1) : controls[0]).focus()
  })
node("stop").addEventListener("click", () => {
  node("stop-dialog").returnValue = ""
  node("stop-dialog").showModal()
})
node("stop-dialog").addEventListener("close", () => {
  if (node("stop-dialog").returnValue === "stop") void control("stop")
})
node("chat-form").addEventListener("submit", (event) => {
  event.preventDefault()
  void ask(node("question").value)
})
node("retry-question").addEventListener("click", () => {
  if (retryQuestion) void ask(retryQuestion)
})
node("owner-retry").addEventListener("click", () => void loadOwner())
node("owner-model").addEventListener("change", () => renderOwnerVariants())
node("owner-add-server").addEventListener("change", () => renderOwnerAdd())
node("owner-add").addEventListener("click", () => {
  const binding = {
    server: node("owner-add-server").value,
    search: node("owner-add-search").value,
    read: node("owner-add-read").value,
    ...(node("owner-add-write").value ? { write: node("owner-add-write").value } : {}),
    enabled: true,
  }
  if (!binding.server || !binding.search || !binding.read) {
    text("owner-feedback", "Choose a server, its search tool and its read tool before adding a binding.")
    return
  }
  if (ownerDraft.length >= 4 || ownerDraft.some((item) => item.server === binding.server)) {
    text("owner-feedback", "Each server can be bound once, up to 4 bindings. Remove a binding before adding another.")
    return
  }
  ownerDraft.push(binding)
  renderOwnerBindings()
  renderOwnerAdd()
  text("owner-feedback", "Binding added. Save owner settings to apply it; nothing was written externally.")
})
node("owner-form").addEventListener("submit", (event) => {
  event.preventDefault()
  void saveOwner()
})
window.addEventListener("pagehide", () => {
  closed = true
  clearTimeout(polling)
  capture.leave()
  requests.forEach((abort) => abort.abort())
})
window.addEventListener("pageshow", (event) => {
  if (!event.persisted || !key || denied) return
  closed = false
  poll()
})
window.addEventListener("beforeunload", (event) => {
  if (!["capturing", "reconnecting"].includes(captureState.phase)) return
  event.preventDefault()
  event.returnValue = ""
})
if (!key) {
  denied = true
  text("connection", "Missing or invalid view key. Reopen the meeting from YCoding; keys are not stored in this page.")
  node("connection").dataset.tone = "error"
  text("chat-feedback", "Ask AI is unavailable without a valid view key.")
} else {
  poll()
}
if (ownerKey) {
  node("owner-panel").hidden = false
  void loadOwner()
}
window.addEventListener("hashchange", () => {
  const next = readCredentials(location.hash)
  history.replaceState(null, "", location.pathname)
  if (!next?.owner || next.key !== key || next.owner === ownerKey) return
  ownerKey = next.owner
  ownerDenied = false
  ownerData = undefined
  node("owner-panel").hidden = false
  void loadOwner()
})
