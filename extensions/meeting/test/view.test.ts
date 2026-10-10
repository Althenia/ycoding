import { describe, expect, test } from "bun:test"
import { describeView, formatSeconds, pairingState, questionError, readViewKey } from "../view/model.js"

describe("Meeting Telemetry live view-model", () => {
  test("requires the view credential only in a single canonical fragment field", () => {
    const key = "a".repeat(64)
    expect(readViewKey(`#key=${key}`)).toBe(key)
    for (const hash of ["", "#key=short", `#key=${key}&key=${key}`, `#key=${key}&token=other`])
      expect(readViewKey(hash)).toBeUndefined()
  })

  test("unknown metrics remain unreported, while actual zero retains its unit", () => {
    expect(formatSeconds(undefined)).toBe("Unreported")
    expect(formatSeconds(null)).toBe("Unreported")
    expect(formatSeconds(Number.NaN)).toBe("Unreported")
    expect(formatSeconds(-1)).toBe("Unreported")
    expect(formatSeconds(0)).toBe("0.0 s")
    expect(formatSeconds(12.34)).toBe("12.3 s")
  })

  test("pairing countdown expires at its exact timestamp and never infers pairing from absence", () => {
    expect(pairingState(undefined, 100)).toEqual({ status: "unreported", seconds: undefined })
    expect(pairingState({ code: "one-use", expiresAt: 60100 }, 100)).toEqual({ status: "waiting", seconds: 60 })
    expect(pairingState({ code: "one-use", expiresAt: 60100 }, 60100)).toEqual({ status: "expired", seconds: 0 })
  })

  test("uses runtime statuses for armed, recording, finalizing and summary-ready views", () => {
    expect(describeView({ meeting: { status: "ready" } }).status).toBe("Armed · start in Chrome")
    expect(describeView({ meeting: { status: "recording" } }).status).toBe("REC · Recording")
    expect(describeView({ meeting: { status: "stopping" } }).status).toBe("Finalizing audio")
    expect(describeView({ meeting: { status: "stopped" }, analysis: { status: "running" } }).status).toBe(
      "Finalizing analysis",
    )
    expect(describeView({ meeting: { status: "stopped" }, summary: { final: true, summary: "Ready" } }).status).toBe(
      "Summary ready",
    )
    expect(describeView({}).status).toBe("Waiting for a meeting")
  })

  test("failed inference exposes retained-audio recovery without claiming capture is active", () => {
    const view = describeView({
      meeting: { status: "stopped", error: "inference_failed" },
      health: { status: "error", error: "inference_failed" },
      audio: { backlog: 2, error: "inference_failed", sources: { remote: "inactive", microphone: "disabled" } },
    })
    expect(view.status).toBe("Capture stopped · audio failed")
    expect(view.canRetry).toBe(true)
    expect(view.canStop).toBe(false)
    expect(view.notice).toContain("Retry failed audio")
    expect(view.notice).toContain("Chrome")
  })

  test("analysis errors have terminal guidance, not an invented view action", () => {
    const view = describeView({
      meeting: { status: "stopped" },
      analysis: { status: "error", error: "Analysis failed" },
    })
    expect(view.status).toBe("Analysis failed")
    expect(view.canRetry).toBe(false)
    expect(view.notice).toContain("/meeting summary")
    const recording = describeView({ meeting: { status: "recording" }, analysis: { status: "error" } })
    expect(recording.status).toBe("REC · Recording")
    expect(recording.tone).toBe("error")
    expect(recording.notice).toContain("Analysis failed")
  })

  test("reported backlog/health warnings mark degradation; absence does not become zero", () => {
    expect(describeView({ meeting: { status: "recording" }, audio: { backlog: 3 } }).tone).toBe("warning")
    expect(describeView({ health: { status: "ready", warning: "CPU fallback" } }).health).toBe("Degraded")
    const unknown = describeView({})
    expect(unknown.buffered).toBe("Unreported")
    expect(unknown.backlog).toBe("Unreported")
    expect(unknown.lag).toBe("Unreported")
    expect(unknown.remote).toBe("Unreported")
    expect(describeView({ audio: { bufferedSeconds: 12, processedSeconds: 30, backlog: 2 } }).lag).toBe("Unreported")
  })

  test("advisory chat maps reachable server errors into actionable local feedback", () => {
    expect(questionError("busy")).toContain("one question")
    expect(questionError("no_transcript")).toContain("transcript")
    expect(questionError("select_meeting")).toContain("meeting")
    expect(questionError("answer_failed")).toContain("Retry")
  })
})
