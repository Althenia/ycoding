import { expect, test } from "bun:test"
import { mountPopup } from "../companion/popup.js"

function fixture({ respond, microphoneState = "granted" } = {}) {
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
  const opened = []
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
      state: async () => microphoneState,
      openAccessPage: async () => {
        opened.push("access")
      },
    },
  )
  const dispatch = async (id, type) => {
    await nodes.get(id).events[type]({ preventDefault() {} })
  }
  return { nodes, calls, opened, mounted, dispatch }
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
  expect(f.opened).toEqual([])
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

test("a blocked microphone opens the access page instead of starting, and Stop stays available while starting or reconnecting", async () => {
  const f = fixture({ microphoneState: "denied" })
  f.mounted.render({ phase: "ready", paired: true })
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  await f.dispatch("capture", "submit")
  expect(f.calls.filter((message) => message.type === "start")).toHaveLength(0)
  expect(f.opened).toEqual(["access"])
  expect(f.nodes.get("error").textContent).toContain("Allow the microphone in the YCoding tab")
  await f.mounted.refresh()
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("error").textContent).toContain("Allow the microphone in the YCoding tab")
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

test("a microphone that was never granted opens the extension access page instead of starting", async () => {
  const f = fixture({ microphoneState: "prompt" })
  f.mounted.render({ phase: "ready", paired: true })
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  await f.dispatch("capture", "submit")
  expect(f.calls.filter((message) => message.type === "start")).toHaveLength(0)
  expect(f.opened).toEqual(["access"])
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("error").textContent).toContain("Allow the microphone in the YCoding tab")
  f.nodes.get("microphone").checked = false
  f.nodes.get("consent").checked = true
  await f.dispatch("capture", "submit")
  expect(f.calls.at(-1)).toEqual({ type: "start", consent: true, microphone: false })
  expect(f.opened).toEqual(["access"])
})

test("Stop during the microphone permission check prevents a late Start and preserves the stopped view", async () => {
  const permission = Promise.withResolvers()
  const f = fixture({ microphoneState: permission.promise })
  f.mounted.render({ phase: "ready", paired: true, microphone: false })
  f.nodes.get("consent").checked = true
  f.nodes.get("microphone").checked = true
  const starting = f.dispatch("capture", "submit")
  await f.dispatch("stop", "click")
  permission.resolve("granted")
  await starting
  expect(f.calls).toEqual([{ type: "stop" }])
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

test("inference failure explains saved evidence and retry without a generic cancellation", async () => {
  const f = fixture({ respond: () => ({ phase: "error", reason: "inference_failed", paired: true }) })
  await f.mounted.refresh()
  expect(f.nodes.get("error").textContent).toContain("Speech recognition failed")
  expect(f.nodes.get("error").textContent).toContain("transcript so far is saved")
  expect(f.nodes.get("error").textContent).toContain("Retry failed audio")
  expect(f.nodes.get("error").textContent).toContain("/meeting retry")
  expect(f.nodes.get("error").textContent).toContain("press Start again")
})

test("a failed Start clears consent before the next capture attempt", async () => {
  const f = fixture({ respond: () => ({ error: "inference_failed" }) })
  f.mounted.render({ phase: "ready", paired: true })
  f.nodes.get("consent").checked = true
  await f.dispatch("capture", "submit")
  expect(f.nodes.get("status").textContent).toBe("Error")
  expect(f.nodes.get("consent").checked).toBe(false)
  expect(f.nodes.get("start").disabled).toBe(true)
})
