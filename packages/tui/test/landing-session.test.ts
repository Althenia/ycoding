import { expect, test } from "bun:test"
import type { LocationRef, ModelDaybreak, ModelRef, YCodingClient } from "@ycoding-ai/client"
import { establishLandingSession, landingAutonomyPayloads } from "../src/util/landing-session"

test("landing autonomy sends one toggle per request and keeps flags independent", () => {
  expect(landingAutonomyPayloads(undefined)).toEqual([])
  expect(landingAutonomyPayloads({ yolo: false })).toEqual([])
  expect(landingAutonomyPayloads({ yolo: true })).toEqual([{ yolo: true }])
  expect(landingAutonomyPayloads({ yolo: false, autoPermission: true })).toEqual([{ autoPermission: true }])
  expect(
    landingAutonomyPayloads({ yolo: true, autoPermission: true, autoGuardrail: true, autoAnswer: true }),
  ).toEqual([{ yolo: true }, { autoPermission: true }, { autoGuardrail: true }, { autoAnswer: true }])
})

test("landing goal carries only its optional yolo toggle in the goal request", () => {
  expect(landingAutonomyPayloads({ yolo: false, goal: "ship" })).toEqual([{ goal: "ship" }])
  expect(landingAutonomyPayloads({ yolo: true, goal: "ship", autoGuardrail: true })).toEqual([
    { autoGuardrail: true },
    { yolo: true, goal: "ship" },
  ])
})

test("landing goal activation follows every independent flag", () => {
  expect(
    landingAutonomyPayloads({ yolo: false, goal: "ship", autoPermission: true, autoGuardrail: true, autoAnswer: true }),
  ).toEqual([{ autoPermission: true }, { autoGuardrail: true }, { autoAnswer: true }, { goal: "ship" }])
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

test("establishing a landing goal Session persists flags and Daybreak before the goal admits work", async () => {
  const { api, calls } = recordingClient()
  await establishLandingSession({
    api,
    id: "ses_landing",
    location,
    agent: "build",
    model,
    daybreak,
    autonomy: { yolo: true, goal: "ship", autoPermission: true, autoAnswer: true },
  })
  expect(calls).toEqual(["create", "daybreak", "autoPermission", "autoAnswer", "yolo+goal"])
})

test("a failed flag write stops the landing Session before the goal is requested", async () => {
  const { api, calls } = recordingClient("autoGuardrail")
  await expect(
    establishLandingSession({
      api,
      id: "ses_landing",
      location,
      agent: "build",
      model,
      autonomy: { yolo: false, goal: "ship", autoGuardrail: true, autoAnswer: true },
    }),
  ).rejects.toThrow("autoGuardrail failed")
  expect(calls).toEqual(["create", "autoGuardrail"])
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
      autonomy: { yolo: false, goal: "ship" },
    }),
  ).rejects.toThrow("daybreak failed")
  expect(calls).toEqual(["create", "daybreak"])
})
