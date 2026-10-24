import { expect, test } from "bun:test"
import type { LocationRef, ModelDaybreak, ModelRef, YCodingClient } from "@ycoding-ai/client"
import { establishLandingSession, landingAutonomyPayloads } from "../src/util/landing-session"

const manual = { permissions: "manual", guardrails: "manual", answers: "manual" } as const

test("landing autonomy sends every category in one request and nothing while all are Manual", () => {
  expect(landingAutonomyPayloads(undefined)).toEqual([])
  expect(landingAutonomyPayloads(manual)).toEqual([])
  expect(landingAutonomyPayloads({ ...manual, permissions: "auto" })).toEqual([
    { permissions: "auto", guardrails: "manual", answers: "manual" },
  ])
  expect(landingAutonomyPayloads({ permissions: "yolo", guardrails: "auto", answers: "yolo" })).toEqual([
    { permissions: "yolo", guardrails: "auto", answers: "yolo" },
  ])
})

test("landing goal is its own request after the category request", () => {
  expect(landingAutonomyPayloads({ ...manual, goal: "ship" })).toEqual([{ goal: "ship" }])
  expect(landingAutonomyPayloads({ ...manual, guardrails: "yolo", goal: "ship" })).toEqual([
    { permissions: "manual", guardrails: "yolo", answers: "manual" },
    { goal: "ship" },
  ])
})

const location = { directory: "/repo" } as unknown as LocationRef
const model = { providerID: "p", modelID: "m" } as unknown as ModelRef
const daybreak = "dawn" as unknown as ModelDaybreak

function recordingClient(failOn?: string) {
  const calls: string[] = []
  const record = (name: string) => async () => {
    calls.push(name)
    if (name === failOn) throw new Error(`${name} failed`)
    return { id: "ses_landing" }
  }
  const api = {
    session: {
      create: record("create"),
      daybreak: { set: record("daybreak") },
      autonomy: {
        set: (input: { payload: Record<string, unknown> }) => record(Object.keys(input.payload).join("+"))(),
      },
    },
  } as unknown as YCodingClient
  return { api, calls }
}

test("establishing a landing goal Session persists categories and Daybreak before the goal admits work", async () => {
  const { api, calls } = recordingClient()
  await establishLandingSession({
    api,
    id: "ses_landing",
    location,
    agent: "build",
    model,
    daybreak,
    autonomy: { permissions: "auto", guardrails: "manual", answers: "yolo", goal: "ship" },
  })
  expect(calls).toEqual(["create", "daybreak", "permissions+guardrails+answers", "goal"])
})

test("a failed category write stops the landing Session before the goal is requested", async () => {
  const { api, calls } = recordingClient("permissions+guardrails+answers")
  await expect(
    establishLandingSession({
      api,
      id: "ses_landing",
      location,
      agent: "build",
      model,
      autonomy: { permissions: "manual", guardrails: "auto", answers: "auto", goal: "ship" },
    }),
  ).rejects.toThrow("permissions+guardrails+answers failed")
  expect(calls).toEqual(["create", "permissions+guardrails+answers"])
})

test("a failed Daybreak write stops the landing Session before any autonomy write", async () => {
  const { api, calls } = recordingClient("daybreak")
  await expect(
    establishLandingSession({
      api,
      id: "ses_landing",
      location,
      agent: "build",
      model,
      daybreak,
      autonomy: { ...manual, guardrails: "auto", goal: "ship" },
    }),
  ).rejects.toThrow("daybreak failed")
  expect(calls).toEqual(["create", "daybreak"])
})
