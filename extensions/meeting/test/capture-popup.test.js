import { expect, test } from "bun:test"
import { mountPopup } from "../companion/popup.js"

function fixture({ denyMicrophone = false, respond = undefined, microphoneResult = undefined } = {}) {
  const nodes = new Map(
    [
      "status",
      "error",
      "pairing",
      "capture",
      "url",
      "code",
      "pair",
      "start",
      "stop",
      "forget",
      "consent",
      "microphone",
    ].map((id) => [
      id,
      {
        value: "",
        checked: false,
        hidden: false,
        disabled: false,
        textContent: "",
        dataset: {},
        events: {},
        addEventListener(type, listener) {
          this.events[type] = listener
        },
      },
    ]),
  )
  const calls = []
  const requested = []
  const track = {
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  const mounted = mountPopup(
    { getElementById: (id) => nodes.get(id) },
    {
      sendMessage: async (message) => {
        calls.push(message)
        return respond
          ? respond(message)
          : {
              phase: message.type === "start" ? "capturing" : "ready",
              paired: true,
              microphone: message.type === "start" && message.microphone === true,
            }
      },
    },
    {
      getUserMedia: async (constraints) => {
        requested.push(constraints)
        if (denyMicrophone) throw new Error("denied")
        return microphoneResult ?? { getTracks: () => [track] }
      },
    },
  )
  const dispatch = async (id, type) => {
    await nodes.get(id).events[type]({ preventDefault() {} })
  }
  return { nodes, calls, requested, track, mounted, dispatch }
}

test("popup clears one-use code, requires consent and explicit mic choice, displays capture and actionable errors", async () => {
  const f = fixture()
  f.nodes.get("url").value = "http://127.0.0.1:1234"
  f.nodes.get("code").value = "one-use-secret"
  await f.dispatch("pairing", "submit")
  expect(f.calls[0]).toEqual({ type: "pair", url: "http://127.0.0.1:1234", code: "one-use-secret" })
  expect(f.nodes.get("code").value).toBe("")
  await f.dispatch("capture", "submit")
  expect(f.calls).toHaveLength(1)
  expect(f.nodes.get("error").textContent).toContain("consent")
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  await f.dispatch("capture", "submit")
  expect(f.calls.at(-1)).toEqual({ type: "start", consent: true, microphone: true })
  expect(f.requested[0].audio.echoCancellation).toBe(true)
  expect(f.track.stopped).toBe(true)
  expect(f.nodes.get("status").textContent).toBe("Capturing")
  expect(f.nodes.get("stop").disabled).toBe(false)
  expect(f.nodes.get("microphone").disabled).toBe(true)
  await f.dispatch("stop", "click")
  expect(f.calls.at(-1)).toEqual({ type: "stop" })
  f.mounted.render({ phase: "error", reason: "queue_overflow", paired: true })
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("error").textContent).toContain("overflowed")
  expect(f.nodes.get("error").textContent).toContain("stopped")
  expect(f.nodes.get("error").hidden).toBe(false)
  f.mounted.render({ phase: "error", reason: "audio_processor_failed", paired: true })
  expect(f.nodes.get("error").textContent).toContain("audio processor")
  f.mounted.render({ phase: "ready", reason: undefined, paired: true })
  expect(f.nodes.get("error").hidden).toBe(true)
})

test("popup microphone denial prevents start and Stop stays available while starting or reconnecting", async () => {
  const f = fixture({ denyMicrophone: true })
  f.mounted.render({ phase: "ready", paired: true })
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  await f.dispatch("capture", "submit")
  expect(f.calls.filter((message) => message.type === "start")).toHaveLength(0)
  expect(f.nodes.get("error").textContent).toContain("Microphone permission was denied")
  await f.mounted.refresh()
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("error").textContent).toContain("Microphone permission was denied")
  f.mounted.render({ phase: "starting", paired: true })
  expect(f.nodes.get("stop").disabled).toBe(false)
  expect(f.nodes.get("start").disabled).toBe(true)
  f.mounted.render({ phase: "reconnecting", paired: true })
  expect(f.nodes.get("status").textContent).toContain("Reconnecting")
  expect(f.nodes.get("stop").disabled).toBe(false)
  f.mounted.render({ phase: "error", reason: "pairing_expired", paired: false })
  expect(f.nodes.get("pairing").hidden).toBe(false)
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("error").textContent).toContain("fresh one-use code")
})

test("reopened capture reflects actual consent and microphone state without starting another recording", () => {
  const f = fixture()
  f.mounted.render({ phase: "capturing", paired: true, microphone: true })
  expect(f.nodes.get("consent").checked).toBe(true)
  expect(f.nodes.get("microphone").checked).toBe(true)
  expect(f.nodes.get("microphone").disabled).toBe(true)
  expect(f.calls).toEqual([])
  f.mounted.render({ phase: "ready", paired: true, microphone: false })
  expect(f.nodes.get("consent").checked).toBe(false)
  expect(f.nodes.get("start").disabled).toBe(true)
})

test("an older status reply cannot overwrite a pending Start or its microphone choice", async () => {
  const status = Promise.withResolvers()
  const start = Promise.withResolvers()
  const f = fixture({ respond: (message) => (message.type === "status" ? status.promise : start.promise) })
  f.mounted.render({ phase: "ready", paired: true, microphone: false })
  const refreshing = f.mounted.refresh()
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  const starting = f.dispatch("capture", "submit")
  status.resolve({ phase: "ready", paired: true, microphone: false })
  await refreshing
  expect(f.nodes.get("status").textContent).toBe("Starting")
  expect(f.nodes.get("microphone").checked).toBe(true)
  start.resolve({ phase: "capturing", paired: true, microphone: true })
  await starting
  expect(f.calls.at(-1)).toEqual({ type: "start", consent: true, microphone: true })
})

test("popup polling keeps at most one status request in flight", async () => {
  const status = Promise.withResolvers()
  const f = fixture({ respond: () => status.promise })
  const first = f.mounted.refresh()
  const second = f.mounted.refresh()
  expect(f.calls).toEqual([{ type: "status" }])
  status.resolve({ phase: "ready", paired: true, microphone: false })
  await Promise.all([first, second])
})

test("Stop during microphone permission prevents a late Start and preserves the stopped view", async () => {
  const permission = Promise.withResolvers()
  const f = fixture({ microphoneResult: permission.promise })
  f.mounted.render({ phase: "ready", paired: true, microphone: false })
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  const starting = f.dispatch("capture", "submit")
  await f.dispatch("stop", "click")
  permission.resolve({ getTracks: () => [f.track] })
  await starting
  expect(f.calls).toEqual([{ type: "stop" }])
  expect(f.track.stopped).toBe(true)
  expect(f.nodes.get("status").textContent).toBe("Ready")
  expect(f.nodes.get("consent").checked).toBe(false)
})

test("unavailable capture service is visible and a later successful status read recovers", async () => {
  let unavailable = true
  const f = fixture({
    respond: async () => {
      if (unavailable) throw new Error("No receiving service")
      return { phase: "unpaired", paired: false }
    },
  })
  await expect(f.mounted.refresh()).rejects.toThrow("No receiving service")
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("error").textContent).toContain("Reload")
  unavailable = false
  await f.mounted.refresh()
  expect(f.nodes.get("status").textContent).toBe("Not paired")
  expect(f.nodes.get("error").hidden).toBe(true)
})
