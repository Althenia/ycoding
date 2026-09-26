import { describe, expect, test } from "bun:test"
import { REMOTE_SCENARIOS, remoteScenario } from "./remote-scenarios"

describe("remote product-state scenarios", () => {
  test("defines product states on the handoff viewport matrix with unique IDs", () => {
    expect(REMOTE_SCENARIOS).toHaveLength(24)
    expect(new Set(REMOTE_SCENARIOS.map((scenario) => scenario.id)).size).toBe(24)
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("conversation-workspace")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("session-list")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("conversation-tool-terminal-output")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("activity-pending-decisions")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("permission-guardrail-hard-review-form-requests")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("empty-backend")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("selected-machine-offline")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("signed-out")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("devices-enrollment")
    expect(REMOTE_SCENARIOS.map((scenario) => scenario.name)).toContain("autonomy-goal-notification-settings")
  })

  test("selects the conversation workspace and account/connectivity states by product name and viewport", () => {
    expect(remoteScenario(new URLSearchParams("scenario=conversation-workspace-390"))).toMatchObject({
      view: "chat",
      openControl: "device",
      expectedText: expect.arrayContaining(["Session bound to Studio Mac in auth.", "Select Active Machine"]),
    })
    expect(remoteScenario(new URLSearchParams("scenario=empty-backend-1440"))).toMatchObject({ account: "ok", connection: "open", emptyBackend: true })
    expect(remoteScenario(new URLSearchParams("scenario=selected-machine-offline-768"))).toMatchObject({ account: "ok", connection: "offline" })
    expect(remoteScenario(new URLSearchParams("scenario=signed-out-390"))).toMatchObject({ account: "signedout" })
  })

  test("provides conversation, review, enrollment, and autonomy wire data", () => {
    const conversation = remoteScenario(new URLSearchParams("scenario=conversation-tool-terminal-output-768"))!
    expect(JSON.stringify(conversation.messages)).toContain("Add defensive timeout handling")
    expect(JSON.stringify(conversation.messages)).toContain("write_file_patch")

    const decisions = remoteScenario(new URLSearchParams("scenario=permission-guardrail-hard-review-form-requests-390"))!
    expect(decisions.permissions).toHaveLength(1)
    expect(decisions.guardrails.some((request) => request.hardReview)).toBe(true)
    expect(decisions.forms[0]?.fields[0]?.type).toBe("string")

    const devices = remoteScenario(new URLSearchParams("scenario=devices-enrollment-1440"))!
    expect(devices.devices.map((device) => [device.name, device.status, device.online])).toEqual([
      ["Studio Mac", "active", true],
      ["Workstation-Box", "active", false],
      ["Legacy-MacBook", "revoked", false],
    ])
    expect(devices.openControl).toBe("enrollment")

    expect(remoteScenario(new URLSearchParams("scenario=autonomy-goal-notification-settings-1440"))).toMatchObject({ theme: "dark", autonomy: { yolo: 2 } })
    expect(remoteScenario(new URLSearchParams("scenario=autonomy-goal-notification-settings-768"))).toMatchObject({ theme: "light", autonomy: { yolo: 1 } })
    expect(remoteScenario(new URLSearchParams("scenario=autonomy-goal-notification-settings-390"))).toMatchObject({ theme: "dark", autonomy: { yolo: 2 } })
  })

  test("rejects incomplete, unsupported product names, and widths outside the scenario matrix", () => {
    expect(remoteScenario(new URLSearchParams())).toBeUndefined()
    expect(remoteScenario(new URLSearchParams("scenario=conversation-workspace"))).toBeUndefined()
    expect(remoteScenario(new URLSearchParams("scenario=unknown-state-390"))).toBeUndefined()
    expect(remoteScenario(new URLSearchParams("scenario=conversation-workspace-320"))).toBeUndefined()
  })
})
