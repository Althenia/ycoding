import { describe, expect, test } from "bun:test"
import { STITCH_REMOTE_SCENARIOS, stitchRemoteScenario } from "./stitch-remote-data"

describe("Stitch remote fixture scenarios", () => {
  test("declares one explicit scenario for every approved R01-R08 specimen", () => {
    expect(STITCH_REMOTE_SCENARIOS).toHaveLength(24)
    expect(new Set(STITCH_REMOTE_SCENARIOS.map((scenario) => scenario.id)).size).toBe(24)
    for (const family of ["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08"] as const) {
      for (const specimen of [1440, 768, 390] as const) {
        expect(stitchRemoteScenario(new URLSearchParams(`stitch=${family}&specimen=${specimen}`))?.id).toBe(`${family}-${specimen}`)
      }
    }
  })

  test("keeps viewport-specific source states rather than one generic fixture", () => {
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r01&specimen=390"))).toMatchObject({
      view: "chat",
      openControl: "device",
      expectedText: expect.arrayContaining(["Session bound to Studio Mac in auth.", "Select Active Device"]),
    })
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r06&specimen=1440"))).toMatchObject({ account: "ok", connection: "open", emptyBackend: true })
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r06&specimen=768"))).toMatchObject({ account: "ok", connection: "offline" })
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r06&specimen=390"))).toMatchObject({ account: "signedout" })
  })

  test("matches conversation, decision, device, and settings source facts with native wire data", () => {
    const conversation = stitchRemoteScenario(new URLSearchParams("stitch=r03&specimen=768"))!
    expect(JSON.stringify(conversation.messages)).toContain("Add defensive timeout handling")
    expect(JSON.stringify(conversation.messages)).toContain("write_file_patch")

    const decisions = stitchRemoteScenario(new URLSearchParams("stitch=r05&specimen=390"))!
    expect(decisions.permissions).toHaveLength(1)
    expect(decisions.guardrails.some((request) => request.hardReview)).toBe(true)
    expect(decisions.forms[0]?.fields[0]?.type).toBe("string")

    const devices = stitchRemoteScenario(new URLSearchParams("stitch=r07&specimen=1440"))!
    expect(devices.devices.map((device) => [device.name, device.status, device.online])).toEqual([
      ["Studio Mac", "active", true],
      ["Workstation-Box", "active", false],
      ["Legacy-MacBook", "revoked", false],
    ])
    expect(devices.openControl).toBe("enrollment")

    expect(stitchRemoteScenario(new URLSearchParams("stitch=r08&specimen=1440"))).toMatchObject({ theme: "dark", autonomy: { yolo: 2 } })
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r08&specimen=768"))).toMatchObject({ theme: "light", autonomy: { yolo: 1 } })
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r08&specimen=390"))).toMatchObject({ theme: "dark", autonomy: { yolo: 2 } })
  })

  test("rejects partial, unsupported, and non-Stitch queries", () => {
    expect(stitchRemoteScenario(new URLSearchParams())).toBeUndefined()
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r01"))).toBeUndefined()
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r09&specimen=390"))).toBeUndefined()
    expect(stitchRemoteScenario(new URLSearchParams("stitch=r01&specimen=320"))).toBeUndefined()
  })
})
