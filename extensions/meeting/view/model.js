export function readCredentials(hash) {
  const values = new URLSearchParams(hash.replace(/^#/, ""))
  const fields = [...values.keys()]
  const credential = /^[0-9a-f]{64}$/
  if (new Set(fields).size !== fields.length || fields.some((field) => !["key", "owner"].includes(field))) return undefined
  const key = values.get("key")
  if (!credential.test(key ?? "")) return undefined
  const owner = values.get("owner")
  if (owner !== null && !credential.test(owner)) return undefined
  return owner ? { key, owner } : { key }
}

export function encodeModelChoice(providerID, id) {
  return JSON.stringify([providerID, id])
}

export function decodeModelChoice(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === "string" && part.length > 0)
      ? { providerID: parsed[0], id: parsed[1] }
      : undefined
  } catch {
    return undefined
  }
}

export function resolveAskSelection(selected, loaded) {
  if (
    selected === "inherit" ||
    !loaded ||
    typeof loaded !== "object" ||
    typeof loaded.profile !== "string" ||
    !loaded.profile ||
    selected.providerID !== loaded.providerID
  )
    return selected
  return { ...selected, profile: loaded.profile }
}

export function ownerModelStatus(model) {
  if (!model || (typeof model.enabled !== "boolean" && typeof model.status !== "string")) return "Unreported"
  if (model.enabled === false) return "Unavailable · disabled in catalog"
  if (model.status === "deprecated") return "Unavailable · deprecated"
  return "Available"
}

export function ownerBindingStatus(binding, servers) {
  const server = (Array.isArray(servers) ? servers : []).find((item) => item?.name === binding?.server)
  const state = !server?.status
    ? "Server unreported"
    : server.status === "connected"
      ? "Server connected"
      : `Server ${server.status}`
  if (!binding?.write) return state
  const capability =
    binding.writeCapability === "revision-aware"
      ? " · revision-aware"
      : binding.writeCapability === "manual-only"
        ? " · manual proposals only"
        : binding.writeCapability === "unavailable"
          ? " · write tool unavailable"
          : ""
  return `${state} · write requires approval${capability}`
}

export function formatSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)} s` : "Unreported"
}

export function describeView(view) {
  const meeting = view.meeting
  const audioFailed = !!view.audio?.error
  const analysisFailed = view.analysis?.status === "error"
  const degraded = !!view.health?.warning || (typeof view.audio?.backlog === "number" && view.audio.backlog > 1)
  const status =
    meeting?.status === "recording"
      ? "REC · Recording"
      : audioFailed
        ? "Capture stopped · audio failed"
        : analysisFailed
          ? "Analysis failed"
          : meeting?.status === "ready"
            ? "Ready · nothing is recording"
            : meeting?.status === "stopping"
              ? "Finalizing audio"
              : ["stopped", "interrupted"].includes(meeting?.status) && view.analysis?.status === "running"
                ? "Finalizing analysis"
                : view.summary?.final
                  ? "Summary ready"
                  : meeting?.status === "interrupted"
                    ? "Capture interrupted"
                    : meeting?.status === "error"
                      ? "Meeting error"
                      : meeting?.status === "stopped"
                        ? "Capture stopped"
                        : "Waiting for a meeting"
  return {
    status,
    tone: audioFailed || analysisFailed || view.health?.status === "error" ? "error" : degraded ? "warning" : "ready",
    health: view.health?.warning
      ? "Degraded"
      : ({ ready: "Ready", error: "Error", loading: "Loading", unloaded: "Unloaded" }[view.health?.status] ??
        "Unreported"),
    canStop: ["ready", "recording"].includes(meeting?.status),
    canRetry: audioFailed && typeof view.audio?.backlog === "number" && view.audio.backlog > 0,
    notice: audioFailed
      ? "Audio inference failed. Retry failed audio retained in this process. Capture remains stopped; recording requires a ready meeting and fresh consent on this page."
      : analysisFailed
        ? "Analysis failed; the transcript is retained. Use /meeting summary in the terminal to retry analysis."
        : meeting?.status === "interrupted"
          ? "The capture source disconnected. Re-arm the meeting in YCoding, then give fresh consent and Start on this page."
          : meeting?.error ||
            view.health?.error ||
            view.health?.warning ||
            (degraded
              ? "Audio backlog is growing. Processing continues locally; stop and finalize if the delay persists."
              : ""),
    buffered: formatSeconds(view.audio?.bufferedSeconds),
    processed: formatSeconds(view.audio?.processedSeconds),
    backlog:
      typeof view.audio?.backlog === "number" && Number.isInteger(view.audio.backlog) && view.audio.backlog >= 0
        ? `${view.audio.backlog} chunks`
        : "Unreported",
    lag: "Unreported",
    remote: view.audio?.sources?.remote || "Unreported",
    microphone: view.audio?.sources?.microphone || "Unreported",
  }
}

export function questionError(error) {
  return (
    {
      busy: "Only one question can be answered at a time. Wait for the pending answer.",
      no_transcript: "No transcript is available yet. Start recording on this page and wait for text, then retry.",
      select_meeting: "No meeting is selected. Arm a meeting in YCoding, then reopen its view.",
      invalid_question: "Enter a question of at most 2,000 characters.",
      unauthorized: "This view key is invalid. Reopen the meeting from YCoding.",
      ask_unavailable: "Ask AI is unavailable in this runtime. Reopen the meeting from YCoding.",
      answer_failed: "The AI provider could not answer. Retry the same question when the provider is available.",
    }[error] ?? "Could not answer. Retry when the runtime is ready."
  )
}
