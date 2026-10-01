import { describe, expect, spyOn, test } from "bun:test"
import { RemoteLimits } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerOutcome, type RelayRequestHandler } from "./relay-double"

function gate() {
  return Promise.withResolvers<RelayHandlerOutcome>()
}

async function harness(handler: RelayRequestHandler, now?: () => number, deterministicIDs = true) {
  const relay = await startRelayDouble({ handler, advertisedSessions: ["ses_a", "ses_b"] })
  let ids = 0
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20 }),
    ...(deterministicIDs ? { createMessageID: () => `msg_send_${++ids}` } : {}),
    now,
    batchMs: 0,
  })
  await store.load()
  await waitFor(() => store.state().sessions.length > 0)
  await store.selectSession("ses_a")
  return { store, relay, stop: async () => { store.dispose(); await relay.stop() } }
}

describe("remote Session nonblocking sends", () => {
  test("queued prompt skills travel in one admission without early skill activation or a separate wake", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Review later", delivery: "queue", skills: ["audit", "test"] })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input).toMatchObject({ text: "Review later", delivery: "queue", skills: ["audit", "test"] })
      response.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { response.resolve("default"); await context.stop() }
  })

  test("returning to the original device preserves unadmitted text and attachments for explicit same-ID recovery", async () => {
    const upload = gate()
    let delayed = true
    const context = await harness((request) => request.operation === "session.attachment.upload" ? delayed ? upload.promise
      : { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } } : "default")
    try {
      const files = [{ uri: "data:text/plain;base64,SGk=", name: "note.txt" }]
      await context.store.sendPrompt({ text: "Accepted original", delivery: "steer", files })
      const id = context.store.state().mutations[0]!.id
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.attachment.upload"))
      context.store.connect("dev_other")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().view?.messages.some((message) => message.id === id)).toBe(false)
      await context.store.retryMutation(id)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", aggregateID: "ses_a", seq: 1, data: {
        inputID: id, input: { type: "user", delivery: "steer", data: { text: "Other device's independent history" } },
      } })
      await waitFor(() => context.store.state().view?.messages.some((message) => message.kind === "user" && message.text === "Other device's independent history") === true)
      context.store.connect("dev_1")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      expect(context.store.state().mutations.find((mutation) => mutation.id === id)).toMatchObject({ state: "failed", input: { text: "Accepted original", files } })
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toMatchObject({ text: "Accepted original", state: "pending" })
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      delayed = false
      await context.store.retryMutation(id)
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.id).toBe(id)
      expect(context.store.state().mutations).toEqual([])
    } finally { upload.resolve("default"); await context.stop() }
  })

  test("accepts two drafts immediately with distinct bubbles and IDs while acknowledgements are delayed", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default")
    try {
      const accepted: boolean[] = []
      void context.store.sendPrompt({ text: "First", delivery: "steer" }).then((value) => accepted.push(value))
      void context.store.sendPrompt({ text: "Second", delivery: "queue" }).then((value) => accepted.push(value))
      await waitFor(() => accepted.length === 2)
      expect(accepted).toEqual([true, true])
      expect(context.store.state().view?.messages.filter((message) => message.kind === "user").map((message) => message.text)).toEqual(["First", "Second"])
      expect(new Set(context.store.state().mutations.map((mutation) => mutation.id)).size).toBe(2)
      await waitFor(() => context.relay.requests.filter((request) => request.operation === "session.prompt").length === 2)
      expect(context.store.state().mutations.every((mutation) => mutation.phase === "admitting" && mutation.state === "sending")).toBe(true)
      response.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
    } finally { response.resolve("default"); await context.stop() }
  })

  test("accepts before uploads and model selection, and admits the selected skills only after their acknowledgements", async () => {
    const upload = gate()
    const model = gate()
    const admission = gate()
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") return upload.promise
      if (request.operation === "session.switchModel") return model.promise
      if (request.operation === "session.prompt") return admission.promise
      return "default"
    })
    try {
      const files = [{ uri: "data:text/plain;base64,SGk=", name: "note.txt" }]
      expect(await context.store.sendPrompt({ text: "Use skill", delivery: "steer", files, model: { id: "next", providerID: "openai" }, skills: ["review"] })).toBe(true)
      const root = context.store.state().mutations[0]
      expect(root).toMatchObject({ kind: "prompt", phase: "preparing", input: { files } })
      expect(context.store.state().view?.messages.at(-1)).toMatchObject({ id: root?.id, text: "Use skill", state: "pending" })
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.attachment.upload"))
      expect(context.relay.requests.some((request) => request.operation === "session.switchModel")).toBe(false)
      const uploadID = context.relay.requests.find((request) => request.operation === "session.attachment.upload")?.input?.uploadID
      upload.resolve({ ok: true, value: { uri: `ycoding-upload://${String(uploadID)}` } })
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      expect(context.relay.requests.some((request) => request.operation === "session.skill")).toBe(false)
      model.resolve("default")
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.skills).toEqual(["review"])
      expect(context.relay.requests.some((request) => request.operation === "session.skill")).toBe(false)
      admission.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").every((request) => request.input?.id === root?.id)).toBe(true)
    } finally { upload.resolve("default"); model.resolve("default"); admission.resolve("default"); await context.stop() }
  })

  test("retries a failed admission with stable IDs and selected skills while preserving a newer draft", async () => {
    let fail = true
    const context = await harness((request) => request.operation === "session.prompt" && fail
      ? { ok: false, code: "internal_error", message: "Admission failed" } : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Try skills", delivery: "steer", skills: ["first", "second"] })).toBe(true)
      await waitFor(() => context.store.state().mutations.some((mutation) => mutation.state === "failed"))
      const root = context.store.state().mutations[0]
      expect(root).toMatchObject({ kind: "prompt", phase: "admitting", detail: "Admission failed" })
      context.store.setDraft("ses_a", "Newer draft")
      fail = false
      await context.store.retryMutation(root!.id)
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").map((request) => request.input?.skills)).toEqual([["first", "second"], ["first", "second"]])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").every((request) => request.input?.id === root?.id)).toBe(true)
      expect(context.store.state().drafts.ses_a).toBe("Newer draft")
    } finally { await context.stop() }
  })

  test("an admission event before acknowledgement settles the receipt and suppresses a later unknown result", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Durable first", delivery: "steer" })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      const id = context.store.state().mutations[0]!.id
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", aggregateID: "ses_a", seq: 1, data: {
        inputID: id, input: { type: "user", delivery: "steer", data: { text: "Durable first" } },
      } })
      await waitFor(() => context.store.state().mutations.length === 0)
      context.relay.dropConnections(1012, "restart")
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().mutationToasts).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { response.resolve("default"); await context.stop() }
  })

  test("reconciles an unknown selected-skill admission without replay or a wake", async () => {
    let close = true
    let admittedID: unknown
    const context = await harness((request) => {
      if (request.operation === "session.prompt" && close) {
        close = false
        admittedID = request.input?.id
        return "close"
      }
      if (request.operation === "session.pending.list" && admittedID) return { ok: true, value: { data: [{
        id: admittedID, sessionID: "ses_a", admittedSeq: 2, timeCreated: 2, type: "user", data: { text: "With skill" }, delivery: "steer",
      }] } }
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "With skill", delivery: "steer", skills: ["review"] })).toBe(true)
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { await context.stop() }
  })

  test("unknown standalone skill activation retries only that skill with its original ID", async () => {
    let close = true
    const context = await harness((request) => {
      if (request.operation === "session.skill" && close) { close = false; return "close" }
      return "default"
    })
    try {
      expect(await context.store.activateSkill("review")).toBe(true)
      await waitFor(() => context.store.state().mutations[0]?.state === "unknown")
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      const root = context.store.state().mutations[0]!
      await context.store.retryMutation(root.id)
      const skills = context.relay.requests.filter((request) => request.operation === "session.skill")
      expect(skills).toHaveLength(2)
      expect(skills[0]?.input?.id).toBe(skills[1]?.input?.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally { await context.stop() }
  })

  test("accepts command and standalone skill immediately, with failure owned by their mutations", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.command" || request.operation === "session.skill" ? response.promise : "default")
    try {
      expect(await context.store.runCommand({ command: "build", arguments: "--fast", delivery: "steer" })).toBe(true)
      expect(await context.store.activateSkill("review")).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.skill"))
      expect(context.store.state().view?.messages.at(-1)).toMatchObject({ text: "/build --fast", state: "pending" })
      expect(context.store.state().mutations.map((mutation) => mutation.kind)).toEqual(["command", "skill"])
      response.resolve({ ok: false, code: "internal_error", message: "Rejected" })
      await waitFor(() => context.store.state().mutations.every((mutation) => mutation.state === "failed"))
      expect(context.store.state().mutationToasts?.map((toast) => toast.detail)).toEqual(["Rejected", "Rejected"])
    } finally { response.resolve("default"); await context.stop() }
  })

  test("retains failed upload files and a newer draft, and retries without losing either", async () => {
    let fail = true
    const context = await harness((request) => request.operation === "session.attachment.upload" ? fail
      ? { ok: false, code: "invalid_message", message: "Upload failed" }
      : { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } } : "default")
    try {
      const files = [{ uri: "data:text/plain;base64,SGk=", name: "note.txt" }]
      expect(await context.store.sendPrompt({ text: "Original", delivery: "steer", files })).toBe(true)
      context.store.setDraft("ses_a", "Newer draft")
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      expect(root.input.files).toEqual(files)
      expect(context.store.state().drafts.ses_a).toBe("Newer draft")
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.store.state().drafts.ses_a).toBe("Newer draft")
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.id).toBe(root.id)
    } finally { await context.stop() }
  })

  test("stops after an old Session prerequisite acknowledges and cannot mutate the new Session", async () => {
    const model = gate()
    const context = await harness((request) => request.operation === "session.switchModel" ? model.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Old", delivery: "steer", model: { id: "next", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      await context.store.selectSession("ses_b")
      context.store.setDraft("ses_b", "New Session draft")
      model.resolve("default")
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      expect(context.store.state().view?.messages.some((message) => message.id === context.store.state().mutations[0]?.id)).toBe(false)
      expect(context.store.state().drafts.ses_b).toBe("New Session draft")
      await context.store.retryMutation(context.store.state().mutations[0]!.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
    } finally { model.resolve("default"); await context.stop() }
  })

  test("device replacement hides old send receipts and does not dispatch their prerequisites on the new machine", async () => {
    const model = gate()
    const context = await harness((request) => request.operation === "session.switchModel" ? model.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Old device", delivery: "steer", model: { id: "next", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      context.store.connect("dev_other")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      model.resolve("default")
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().view?.messages.some((message) => message.kind === "user" && message.text === "Old device")).toBe(false)
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
    } finally { model.resolve("default"); await context.stop() }
  })

  test("rejects local invalid and offline sends without optimistic messages or mutations", async () => {
    const context = await harness(() => "default")
    try {
      expect(await context.store.sendPrompt({ text: "", delivery: "steer" })).toBe(false)
      expect(await context.store.sendPrompt({ text: "x".repeat(32_768), delivery: "steer" })).toBe(false)
      expect(await context.store.sendPrompt({ text: "Invalid", delivery: "steer", skills: [" "] })).toBe(false)
      expect(await context.store.sendPrompt({ text: "Invalid", delivery: "steer", skills: Array.from({ length: 201 }, () => "audit") })).toBe(false)
      expect(await context.store.runCommand({ command: "", delivery: "steer" })).toBe(false)
      expect(await context.store.activateSkill(" ")).toBe(false)
      context.relay.dropConnections(1012, "offline")
      await waitFor(() => context.store.state().transport.kind !== "open")
      expect(await context.store.sendPrompt({ text: "Offline", delivery: "steer" })).toBe(false)
      expect(await context.store.runCommand({ command: "build", delivery: "steer" })).toBe(false)
      expect(await context.store.activateSkill("review")).toBe(false)
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().view?.messages).toEqual([])
    } finally { await context.stop() }
  })

  test("serializes selection changes through admission acknowledgement and restores a later draft's chosen model", async () => {
    const admission = gate()
    const context = await harness((request) => {
      if (request.operation === "session.snapshot") return { ok: true, value: { session: { model: { id: "original", providerID: "openai" } }, messages: [], watermark: { type: "log.synced", aggregateID: request.sessionID, seq: 0 } } }
      if (request.operation === "session.prompt" && request.input?.text === "First model") return admission.promise
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "First model", delivery: "steer", model: { id: "next", providerID: "openai" } })).toBe(true)
      expect(await context.store.sendPrompt({ text: "Restore original", delivery: "steer", model: { id: "original", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
      admission.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => ["session.switchModel", "session.prompt"].includes(request.operation)).map((request) => [request.operation, request.input?.model ?? request.input?.text])).toEqual([
        ["session.switchModel", { id: "next", providerID: "openai" }], ["session.prompt", "First model"],
        ["session.switchModel", { id: "original", providerID: "openai" }], ["session.prompt", "Restore original"],
      ])
    } finally { admission.resolve("default"); await context.stop() }
  })

  test("a failed model remains the root retry prerequisite and a completed upload is not repeated", async () => {
    let fail = true
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") return { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } }
      if (request.operation === "session.switchModel" && fail) return { ok: false, code: "invalid_message", message: "Model failed" }
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "Retry model", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }], model: { id: "next", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(1)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(3)
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.id).toBe(root.id)
    } finally { await context.stop() }
  })

  test("retry reasserts a model changed by an unrelated send while keeping skills in the same prompt", async () => {
    let fail = true
    const context = await harness((request) => request.operation === "session.prompt" && request.input?.text === "Original model" && fail
      ? { ok: false, code: "internal_error", message: "Admission failed" } : "default")
    try {
      await context.store.sendPrompt({ text: "Original model", delivery: "steer", model: { id: "first", providerID: "openai" }, skills: ["first", "second"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      await context.store.sendPrompt({ text: "Other model", delivery: "steer", model: { id: "other", providerID: "openai" } })
      await waitFor(() => context.store.state().mutations.length === 1)
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel").map((request) => request.input?.model)).toEqual([
        { id: "first", providerID: "openai" }, { id: "other", providerID: "openai" }, { id: "first", providerID: "openai" },
      ])
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.text === "Original model").every((request) => request.input?.id === root.id)).toBe(true)
    } finally { await context.stop() }
  })

  test("retry after agent drift confirms restoration before re-admitting the same prompt and skills", async () => {
    let fail = true
    const restoredAgent = gate()
    let switches = 0
    let agent = "god"
    const context = await harness((request) => {
      if (request.operation === "session.switchAgent") {
        agent = String(request.input?.agent)
        if (++switches === 3) return restoredAgent.promise
      }
      if (request.operation === "session.snapshot") return { ok: true, value: { session: { agent }, messages: [], watermark: { type: "log.synced", aggregateID: request.sessionID, seq: 0 } } }
      if (request.operation === "session.prompt" && request.input?.text === "Original agent" && fail) return { ok: false, code: "internal_error", message: "Admission failed" }
      return "default"
    })
    try {
      await context.store.sendPrompt({ text: "Original agent", delivery: "steer", agent: "reviewer", skills: ["first", "second"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      await context.store.sendPrompt({ text: "Other agent", delivery: "steer", agent: "builder" })
      await waitFor(() => context.store.state().mutations.length === 1)
      fail = false
      const retry = context.store.retryMutation(root.id)
      await waitFor(() => switches === 3)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchAgent").map((request) => request.input?.agent)).toEqual(["reviewer", "builder", "reviewer"])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.text === "Original agent")).toHaveLength(1)
      restoredAgent.resolve("close")
      await retry
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      expect(context.store.state().mutations[0]?.state).toBe("unknown")
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.text === "Original agent").map((request) => request.input?.id)).toEqual([root.id, root.id])
    } finally { restoredAgent.resolve("default"); await context.stop() }
  })

  test("a following prompt cannot execute ahead of an unacknowledged standalone skill activation", async () => {
    const skill = gate()
    const context = await harness((request) => request.operation === "session.skill" ? skill.promise : "default")
    try {
      expect(await context.store.activateSkill("review")).toBe(true)
      expect(await context.store.sendPrompt({ text: "Following", delivery: "steer" })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.skill"))
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      skill.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { skill.resolve("default"); await context.stop() }
  })

  test("retry restores attachment references lost with the connection while preserving selected skills", async () => {
    let close = true
    const uploads = new Set<string>()
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") {
        const uri = `ycoding-upload://${String(request.input?.uploadID)}`
        uploads.add(uri)
        return { ok: true, value: { uri } }
      }
      if (request.operation === "session.prompt" && close) { close = false; uploads.clear(); return "close" }
      if (request.operation === "session.prompt" && Array.isArray(request.input?.files) && !uploads.has(request.input.files[0]?.uri))
        return { ok: false, code: "invalid_message", message: "Attachment upload is unavailable or incomplete" }
      return "default"
    })
    try {
      await context.store.sendPrompt({ text: "Recover attachments", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }], skills: ["review"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "unknown")
      const root = context.store.state().mutations[0]!
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      await context.store.retryMutation(root.id)
      expect(context.store.state().mutations).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(2)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").map((request) => request.input?.id)).toEqual([root.id, root.id])
    } finally { await context.stop() }
  })

  test("retry refreshes expired attachment references while preserving selected skills", async () => {
    let time = 1_000
    let fail = true
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") return { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } }
      if (request.operation === "session.prompt" && fail) return { ok: false, code: "internal_error", message: "Admission failed" }
      return "default"
    }, () => time)
    try {
      await context.store.sendPrompt({ text: "Expired attachments", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }], skills: ["first", "second"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      time += RemoteLimits.attachmentTtlMs
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(2)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.store.state().mutations).toEqual([])
    } finally { await context.stop() }
  })

  test("parallel production message IDs remain unique when sends share a clock tick and random sample", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default", undefined, false)
    try {
      const clock = spyOn(Date, "now").mockReturnValue(1_000)
      const random = spyOn(Math, "random").mockReturnValue(0)
      const first = context.store.sendPrompt({ text: "First", delivery: "steer" })
      const second = context.store.sendPrompt({ text: "Second", delivery: "steer" })
      clock.mockRestore()
      random.mockRestore()
      expect(await Promise.all([first, second])).toEqual([true, true])
      expect(new Set(context.store.state().mutations.map((mutation) => mutation.id)).size).toBe(2)
      response.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
    } finally { response.resolve("default"); await context.stop() }
  })

  test.each(["dismiss", "logout"] as const)("%s clears an accepted record retained on another device", async (action) => {
    const context = await harness((request) => request.operation === "session.attachment.upload"
      ? { ok: false, code: "invalid_message", message: "Upload failed" } : "default")
    try {
      await context.store.sendPrompt({ text: "Retained until discarded", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const id = context.store.state().mutations[0]!.id
      context.store.connect("dev_other")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      if (action === "dismiss") context.store.dismissMutation(id)
      if (action === "logout") await context.store.logout()
      context.store.connect("dev_1")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      expect(context.store.state().mutations.find((mutation) => mutation.id === id)).toBeUndefined()
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toBeUndefined()
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally { await context.stop() }
  })

  test("disposal clears accepted records before a delayed upload settles", async () => {
    const upload = gate()
    const context = await harness((request) => request.operation === "session.attachment.upload" ? upload.promise : "default")
    try {
      await context.store.sendPrompt({ text: "Dispose safely", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }] })
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.attachment.upload"))
      context.store.dispose()
      upload.resolve("default")
      await waitFor(() => context.store.state().upload === undefined)
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().mutationToasts).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally { upload.resolve("default"); await context.stop() }
  })
})
