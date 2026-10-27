import { expect, test } from "bun:test"
import { Projection } from "@ycoding-ai/core/dots/native-projection"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createRemoteControlAppServer } from "../src/remote-control/app-server"
import { createRemoteControlBackend } from "../src/remote-control/backend"
import { nativeHost, requestBackend, rootSnapshot } from "./remote-control-fixture"

async function fixture(initial: Projection.Stage<unknown>) {
  let stage = initial
  let ordinal = 0
  const candidate = (): NativeDots.NativeRequest => ({ id: `stage_${ordinal}`, threadID: "ses_root", turnID: "turn", itemID: "item", questions: stage.questions, handle: {} as NativeDots.Candidate })
  let request: NativeDots.NativeRequest | undefined = candidate()
  const saved: unknown[] = []
  let cancelled = 0
  const sent: Record<string, unknown>[] = []
  const host = nativeHost({ ...requestBackend, createThread: async () => rootSnapshot({ id: "ses_root", directory: "/synthetic" }),
    getThread: async () => rootSnapshot({ id: "ses_root", directory: "/synthetic" }), listThreads: async () => [],
    prompt: async () => ({ messageID: "message" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined })
  const connection = await host.attach({ profile: "fixture", credentialID: "credential", accountID: "account", accountGeneration: 1, environmentID: "env", connectionID: "connection", isCurrent: () => true })
  const channel: NativeDots.Channel = { ...connection.channel({ clientID: "client", streamID: "stream" }),
    pending: async () => request ? [request] : [],
    settle: async (handle, answers) => {
      if (handle !== request?.handle) throw Error("Stale candidate")
      const result = stage.read(answers)
      if (result.type === "next") { stage = result.stage; ordinal++; request = candidate(); return }
      if (result.type === "cancel") cancelled++
      else saved.push(result.value)
      request = undefined
    },
  }
  const server = createRemoteControlAppServer({ backend: createRemoteControlBackend({ channel, profile: "fixture" }), codexHome: "/synthetic", requestScope: "scope", send: (text) => sent.push(JSON.parse(text)) })
  await server.handle(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
  await server.handle(JSON.stringify({ method: "initialized" }))
  await server.handle(JSON.stringify({ id: 2, method: "thread/read", params: { threadId: "ses_root" } }))
  return { server, sent, saved, cancelled: () => cancelled,
    answer: async (values: Record<string, string>) => {
      const answer = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { answers: [value] }]))
      const response = await server.handle(JSON.stringify({ id: request?.id, result: { answers: answer } }))
      return response === undefined ? undefined : JSON.parse(response)
    },
  }
}

test("real native form decoder accepts action-only cancellation and the wire normalizes free-input options", async () => {
  const f = await fixture(Projection.form("Required", [{ type: "string", key: "name", required: true }]))
  expect((f.sent[0]!.params as { questions: Projection.InputQuestion[] }).questions[0]!.options).toEqual([])
  expect(await f.answer({ action: "Cancel request" })).toBeUndefined()
  expect(f.cancelled()).toBe(1)
  expect(f.saved).toEqual([])
  f.server.retire()
})

test("real native form decoder accepts action-only optional skip", async () => {
  const f = await fixture(Projection.form("Optional", [{ type: "string", key: "note" }]))
  expect(await f.answer({ action: "Skip field" })).toBeUndefined()
  expect(f.saved).toEqual([{}])
  f.server.retire()
})

test("real native multiselect decoder accepts action-only Finish after explicit selected values", async () => {
  const f = await fixture(Projection.form("Selection", [{ type: "multiselect", key: "selection", required: true, custom: true, options: [{ value: "a", label: "Alpha" }] }]))
  expect(await f.answer({ "option:0": "Select", action: "Custom answer" })).toBeUndefined()
  expect(await f.answer({ value: "custom", action: "Add value" })).toBeUndefined()
  expect(await f.answer({ action: "Finish" })).toBeUndefined()
  expect(f.saved).toEqual([{ selection: ["a", "custom"] }])
  expect(f.sent.filter((item) => item.method === "item/tool/requestUserInput")).toHaveLength(3)
  f.server.retire()
})

test("missing required Continue answer remains pending and can only settle after a valid explicit answer", async () => {
  const f = await fixture(Projection.form("Required", [{ type: "string", key: "name", required: true }]))
  expect((await f.answer({ action: "Continue" })).error).toBeDefined()
  expect(f.saved).toEqual([])
  expect(f.cancelled()).toBe(0)
  expect(f.sent.some((message) => message.method === "serverRequest/resolved")).toBe(false)
  expect(await f.answer({ action: "Continue", value: "name" })).toBeUndefined()
  expect(f.saved).toEqual([{ name: "name" }])
  f.server.retire()
})

test("controller error leaves the real native candidate pending rather than fabricating settlement", async () => {
  const f = await fixture(Projection.form("Required", [{ type: "string", key: "name", required: true }]))
  const response = await f.server.handle(JSON.stringify({ id: "stage_0", error: { code: -1, message: "Dismissed" } }))
  expect(JSON.parse(response!).error).toBeDefined()
  expect(f.sent.some((message) => message.method === "serverRequest/resolved")).toBe(false)
  expect(f.saved).toEqual([])
  expect(await f.answer({ action: "Cancel request" })).toBeUndefined()
  expect(f.cancelled()).toBe(1)
  f.server.retire()
})
