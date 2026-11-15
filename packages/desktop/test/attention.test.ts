import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import { createDesktopAttention, createDesktopAudio } from "../src/attention"

const request = { id: "evt_request", created: 1, type: "permission.asked", data: { id: "per_synthetic", sessionID: "ses_synthetic", action: "synthetic-private-action", resources: ["synthetic-private-resource"] } } as YCodingEvent

test("attention requests are silent by preference and do not expose event content", async () => {
  const sent: unknown[] = []
  const attention = createDesktopAttention({ enabled: () => true, notifications: () => true, sound: () => false, volume: () => 0.5, play: async () => {}, focused: () => false, notify: async (input) => { sent.push(input) }, error: () => {} })
  attention.event(request)
  attention.event({ ...request, id: "evt_duplicate" })
  await Promise.resolve()
  expect(sent).toEqual([{ kind: "request", silent: true }])
  expect(JSON.stringify(sent)).not.toContain("synthetic-private")
})

test("disabled or focused attention never issues a native notification or replays one after focus changes", async () => {
  const sent: unknown[] = []
  let focused = true
  let enabled = true
  const attention = createDesktopAttention({ enabled: () => enabled, notifications: () => true, sound: () => true, volume: () => 0.5, play: async () => {}, focused: () => focused, notify: async (input) => { sent.push(input) }, error: () => {} })
  attention.event(request)
  focused = false
  attention.event(request)
  enabled = false
  attention.event({ id: "evt_complete", created: 2, type: "session.execution.succeeded", data: { sessionID: "ses_synthetic" } } as YCodingEvent)
  enabled = true
  attention.event({ id: "evt_failure", created: 3, type: "session.execution.failed", data: { sessionID: "ses_synthetic" } } as YCodingEvent)
  await Promise.resolve()
  expect(sent).toEqual([{ kind: "failure", silent: true }])
})

test("attention resets notification identity on connection replacement and reports failure without retrying", async () => {
  let calls = 0
  const errors: unknown[] = []
  const attention = createDesktopAttention({ enabled: () => true, notifications: () => true, sound: () => false, volume: () => 0.5, play: async () => {}, focused: () => false, notify: async () => { calls++; throw new Error("synthetic notification failure") }, error: (error) => { errors.push(error) } })
  attention.event(request)
  await Promise.resolve()
  attention.event(request)
  attention.reset()
  attention.event(request)
  await Promise.resolve()
  expect(calls).toBe(2)
  expect(errors).toHaveLength(2)
})

test("attention sounds are independent of window focus and native notifications and respect volume", async () => {
  const played: unknown[] = []
  const notifications: unknown[] = []
  const attention = createDesktopAttention({ enabled: () => true, notifications: () => false, sound: () => true, volume: () => 0.25, play: async (kind, volume) => { played.push([kind, volume]) }, focused: () => true, notify: async (input) => { notifications.push(input) }, error: () => {} })
  attention.event(request)
  attention.event(request)
  attention.event({ id: "evt_question", created: 2, type: "question.asked", data: { sessionID: "ses_synthetic", id: "question_synthetic" } } as YCodingEvent)
  await Promise.resolve()
  expect(played).toEqual([["permission", 0.25], ["question", 0.25]])
  expect(notifications).toEqual([])
})

test("bundled audio uses the chosen volume and stops retired playback without reporting cancellation as failure", async () => {
  const clips: { src: string; volume: number; plays: number; pauses: number }[] = []
  const player = createDesktopAudio((src) => {
    const state = { src, volume: 1, plays: 0, pauses: 0 }
    clips.push(state)
    return Object.assign(state, { play: async () => { state.plays++ }, pause: () => { state.pauses++ } })
  })
  await player.play("permission", 0.25)
  expect(clips[0]?.src).toEndWith("/staplebops-06.mp3")
  expect(clips[0]?.volume).toBe(0.25)
  expect(clips[0]?.plays).toBe(1)
  await player.play("question", 1)
  expect(clips[0]?.pauses).toBe(1)
  expect(clips[0]?.src).toBe("")
  expect(clips[1]?.src).toEndWith("/bip-bop-03.mp3")
  player.stop()
  expect(clips[1]?.pauses).toBe(1)
  await expect(player.play("complete", Number.NaN)).rejects.toThrow("Choose a volume between 0 and 1.")
  expect(clips).toHaveLength(2)
})
