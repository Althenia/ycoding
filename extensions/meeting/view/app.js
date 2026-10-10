import { describeView, pairingState, questionError, readViewKey } from "/view/model.js"

const key = readViewKey(location.hash)
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
  clock,
  activeRead,
  closed = false
let original = false,
  follow = true
const requests = new Set()
const segments = new Map()
const chats = new Map()

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
  node("stop").disabled = !available || controlPending || stopPending || !view?.canStop
  node("stop").setAttribute(
    "aria-describedby",
    controlPending || stopPending ? "control-feedback" : !available ? "connection" : "meeting-status",
  )
  node("new-code").disabled =
    !available || controlPending || current?.meeting?.status === "recording" || current?.meeting?.status === "stopping"
  node("new-code").setAttribute("aria-describedby", "pair-countdown")
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

function renderPairing() {
  const pair = pairingState(current?.pairing)
  text("pair-address", current?.pairing?.url || location.origin)
  text(
    "pair-code",
    pair.status === "waiting" ? current.pairing.code : pair.status === "expired" ? "Expired" : "No active pairing code",
  )
  text(
    "pair-countdown",
    pair.status === "waiting"
      ? `${pair.seconds} s remaining · one use only`
      : pair.status === "expired"
        ? "Pairing code expired. Generate a new code."
        : current?.meeting?.status === "recording"
          ? "Capture is active. Stop before generating a new code."
          : "No active code reported; this does not report the companion's paired state.",
  )
  node("copy-code").disabled = pair.status !== "waiting"
  node("pairing").hidden = !current?.pairing && current?.meeting?.status === "recording"
}

function timestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unreported time"
  const seconds = Math.max(0, Math.floor(value / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function renderSegments() {
  const list = records(current?.segments)
  const reported = new Set(list.map((segment) => segment.id))
  const anchor = [...segments.values()].find(
    (row) => row.getBoundingClientRect().top >= 0 && row.getBoundingClientRect().bottom <= innerHeight,
  )
  const before = anchor?.getBoundingClientRect().top
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
  if (!follow && anchor?.isConnected && typeof before === "number")
    window.scrollBy(0, anchor.getBoundingClientRect().top - before)
  if (follow && changed && !node("chat-panel").contains(document.activeElement) && !node("stop-dialog").open)
    node("segments").lastElementChild?.scrollIntoView({ block: "end" })
}

function renderFindings() {
  if (!Array.isArray(current?.findings)) {
    text("findings-title", "Findings · unreported")
    node("finding-list").replaceChildren()
    node("finding-list").dataset.version = "unreported"
    return
  }
  const list = records(current?.findings)
  const version = JSON.stringify(list)
  if (node("finding-list").dataset.version === version) return
  node("finding-list").dataset.version = version
  text("findings-title", `${list.length} findings · statuses from YCoding`)
  node("finding-list").replaceChildren(
    ...list.map((finding) => {
      const entry = document.createElement("article")
      entry.className = "finding"
      const label = document.createElement("h3")
      label.textContent = `${finding.kind || "Kind unreported"} · ${finding.status || "Status unreported"}`
      const content = document.createElement("p")
      content.textContent = finding.summary ?? "Summary unreported"
      const evidence = document.createElement("div")
      evidence.className = "evidence-links"
      const refs = Array.isArray(finding.sourceSegmentIds) ? finding.sourceSegmentIds : []
      for (const id of refs) {
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = `Evidence · ${id}`
        button.addEventListener("click", () => {
          const row = segments.get(id)
          if (!row) {
            text(
              "control-feedback",
              "This evidence segment is outside the current transcript window. Read the full transcript in YCoding.",
            )
            return
          }
          follow = false
          updateFollow()
          for (const other of segments.values()) other.classList.remove("evidence")
          row.classList.add("evidence")
          row.scrollIntoView({ block: "center" })
          row.focus({ preventScroll: true })
        })
        evidence.append(button)
      }
      entry.append(label, content, evidence)
      return entry
    }),
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
  }
  current = value
  connected = true
  const view = describeView(current)
  text("meeting-title", current.meeting?.title || "YCoding Meeting")
  text("meeting-status", view.status)
  node("meeting-status").dataset.tone = view.tone
  text("health-status", view.health)
  node("health-status").dataset.tone = view.tone
  text("source-status", `Remote · ${view.remote} / You · ${view.microphone}`)
  text("connection", "Connected to local runtime · view-only access")
  node("connection").dataset.tone = "ready"
  text("model", current.health?.model || "Model unreported")
  text(
    "device",
    `Device · ${current.health?.device || "Unreported"} / Provider · ${current.health?.provider || "Unreported"}`,
  )
  text("bridge", `Bridge · ${current.pairing?.url || location.origin}`)
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
  renderPairing()
  renderSegments()
  renderFindings()
  renderChat()
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
    action === "pair"
      ? "Generating a one-use pairing code…"
      : action === "retry"
        ? "Retrying retained failed audio…"
        : "Stopping capture and finalizing buffered audio…",
  )
  updateControls()
  clearTimeout(polling)
  await activeRead
  try {
    const value = await request("/view/control", { action })
    if (closed) return
    if (value?.error) throw new Error("operation_failed")
    text(
      "control-feedback",
      action === "pair"
        ? "New pairing code ready; the previous code is invalid."
        : action === "retry"
          ? "Failed audio retry completed. Capture has not restarted; use YCoding and Chrome to record again."
          : "Capture stopped. Remaining analysis continues in YCoding.",
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

function updateFollow() {
  node("follow").setAttribute("aria-pressed", String(follow))
  text("follow", follow ? "✓ Follow newest" : "Ⅱ Follow paused")
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
  renderSegments()
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
node("new-code").addEventListener("click", () => control("pair"))
node("retry-audio").addEventListener("click", () => control("retry"))
node("copy-code").addEventListener("click", async () => {
  if (pairingState(current?.pairing).status !== "waiting") return
  try {
    await navigator.clipboard.writeText(current.pairing.code)
    text("pair-feedback", "Copied pairing code. Paste it into the Chrome popup.")
  } catch {
    text("pair-feedback", "Copy unavailable. Select the displayed code and copy it manually.")
  }
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
window.addEventListener("pagehide", () => {
  closed = true
  clearTimeout(polling)
  clearInterval(clock)
  requests.forEach((abort) => abort.abort())
})
window.addEventListener("pageshow", (event) => {
  if (!event.persisted || !key || denied) return
  closed = false
  clock = setInterval(() => renderPairing(), 1000)
  poll()
})
if (!key) {
  denied = true
  text("connection", "Missing or invalid view key. Reopen the meeting from YCoding; keys are not stored in this page.")
  node("connection").dataset.tone = "error"
  text("chat-feedback", "Ask AI is unavailable without a valid view key.")
} else {
  clock = setInterval(() => renderPairing(), 1000)
  poll()
}
