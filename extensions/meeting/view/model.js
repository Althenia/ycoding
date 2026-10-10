export function readViewKey(hash) {
  const values = new URLSearchParams(hash.replace(/^#/, ""))
  const key = values.get("key")
  return [...values.keys()].length === 1 && /^[0-9a-f]{64}$/.test(key ?? "") ? key : undefined
}

export function formatSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)} s` : "Unreported"
}

export function pairingState(pairing, now = Date.now()) {
  if (typeof pairing?.code !== "string" || !pairing.code || !Number.isFinite(pairing.expiresAt))
    return { status: "unreported", seconds: undefined }
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000))
  return { status: seconds ? "waiting" : "expired", seconds }
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
            ? "Armed · start in Chrome"
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
      ? "Audio inference failed. Retry failed audio retained in this process. Capture remains stopped; recording requires a ready meeting, consent and Start in Chrome."
      : analysisFailed
        ? "Analysis failed; the transcript is retained. Use /meeting summary in the terminal to retry analysis."
        : meeting?.status === "interrupted"
          ? "The capture source disconnected. Re-arm the meeting in YCoding, then check consent and press Start in Chrome."
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
      no_transcript: "No transcript is available yet. Start recording in Chrome and wait for text, then retry.",
      select_meeting: "No meeting is selected. Arm a meeting in YCoding, then reopen its view.",
      invalid_question: "Enter a question of at most 2,000 characters.",
      unauthorized: "This view key is invalid. Reopen the meeting from YCoding.",
      ask_unavailable: "Ask AI is unavailable in this runtime. Reopen the meeting from YCoding.",
      answer_failed: "The AI provider could not answer. Retry the same question when the provider is available.",
    }[error] ?? "Could not answer. Retry when the runtime is ready."
  )
}
