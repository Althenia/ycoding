import { expect, test } from "bun:test"
import { mountMicrophoneAccess } from "../companion/microphone.js"

function fixture(getUserMedia) {
  const nodes = new Map(
    ["status", "allow", "settings"].map((id) => [
      id,
      {
        textContent: "",
        disabled: false,
        hidden: true,
        events: {},
        addEventListener(type, listener) {
          this.events[type] = listener
        },
      },
    ]),
  )
  const requested = []
  const settings = []
  const mounted = mountMicrophoneAccess(
    { getElementById: (id) => nodes.get(id) },
    {
      getUserMedia: async (constraints) => {
        requested.push(constraints)
        return getUserMedia()
      },
    },
    () => settings.push("opened"),
  )
  return { nodes, requested, settings, mounted }
}

test("the access page requests the microphone with echo cancellation and releases it immediately", async () => {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  const f = fixture(async () => ({ getTracks: () => [track] }))
  await f.mounted.request()
  expect(f.requested).toEqual([{ audio: { echoCancellation: true }, video: false }])
  expect(track.stopped).toBe(true)
  expect(f.nodes.get("status").textContent).toContain("Microphone allowed")
  expect(f.nodes.get("allow").disabled).toBe(true)
})

test("a dismissed or blocked request stays retryable and explains the recovery", async () => {
  let deny = true
  const f = fixture(async () => {
    if (deny) throw new DOMException("Permission denied", "NotAllowedError")
    return { getTracks: () => [] }
  })
  await f.mounted.request()
  expect(f.nodes.get("status").textContent).toContain("was not allowed")
  expect(f.nodes.get("allow").disabled).toBe(false)
  expect(f.nodes.get("settings").hidden).toBe(false)
  await f.nodes.get("settings").events.click()
  expect(f.settings).toEqual(["opened"])
  deny = false
  await f.nodes.get("allow").events.click()
  expect(f.nodes.get("status").textContent).toContain("Microphone allowed")
  expect(f.nodes.get("settings").hidden).toBe(true)
})
