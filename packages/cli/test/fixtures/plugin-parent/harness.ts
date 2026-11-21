import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import type { PluginDefinition } from "@ycoding-ai/plugin"
import { afterAll, beforeAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Codec } from "../../../src/plugin-host/codec"
import { PluginHost } from "../../../src/plugin-host/host"
import { PluginLoader } from "../../../src/plugin-host/loader"

export type Context = Parameters<Plugin["effect"]>[0]
export type Frame = Record<string, unknown>
export type Request = { readonly operation: string; readonly payload: Frame; readonly owner: "plugin" | "call" }
export type Reply = { readonly value: unknown } | { readonly failure: { readonly code: number; readonly message: string } }
export type Outcome = { readonly code: number } | { readonly error: unknown }

let cache = ""

beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "ycoding-parent-sdk-"))
  await PluginLoader.load({
    target: path.resolve(import.meta.dir, "../plugin-host/promise-plugin.ts"),
    options: {},
    cache,
  })
}, 30_000)

afterAll(async () => {
  if (cache) await rm(cache, { recursive: true, force: true })
})

export function object(value: unknown): Frame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Frame
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array")
  return value
}

export function call(invocation: number) {
  return {
    invocation,
    session_id: "ses_parent_fixture",
    message_id: "msg_parent_fixture",
    call_id: Codec.text(`call_parent_${invocation}`),
    agent: "build",
  }
}

export function failures(value: unknown): string {
  if (value instanceof AggregateError) return [value.message, ...value.errors.map(failures)].join("\n")
  if (value instanceof Error) return [value.message, failures(value.cause)].join("\n")
  return value === undefined ? "" : String(value)
}

async function bounded<A>(promise: Promise<A>, milliseconds: number, message: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

export async function checked(body: () => Promise<void>, ...cleanup: Array<() => unknown>) {
  const errors: unknown[] = []
  try { await bounded(body(), 2_000, "Parent fixture body deadline exceeded") }
  catch (error) { errors.push(error) }
  for (const operation of cleanup) {
    try { await bounded(Promise.resolve().then(operation), 750, "Parent fixture cleanup deadline exceeded") }
    catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "Parent fixture failed")
}

export function start(
  plugin: Plugin | PluginDefinition,
  options: {
    readonly reply?: (request: Request) => Reply | undefined
    readonly admit?: boolean
    readonly write?: (frame: Frame) => Promise<void>
    readonly options?: Record<string, unknown>
  } = {},
) {
  const chunks: Uint8Array[] = []
  const readers: Array<(value: IteratorResult<Uint8Array>) => void> = []
  const observers = new Set<() => void>()
  const frames: Frame[] = []
  const requests: Request[] = []
  const reader = new Codec.FrameReader()
  let ended = false
  let returned = 0
  const generation = "ext_parent_fixture"
  const sendBytes = (bytes: Uint8Array) => {
    if (ended) throw new Error("Fixture input is closed")
    const next = readers.shift()
    if (next) next({ done: false, value: bytes })
    else chunks.push(bytes)
  }
  const send = (body: Frame, target = generation) => sendBytes(Codec.frame(Codec.encode("HostFrame", { generation: target, ...body })))
  const end = () => {
    ended = true
    readers.splice(0).forEach((resolve) => resolve({ done: true, value: undefined }))
  }
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const chunk = chunks.shift()
        if (chunk) return Promise.resolve({ done: false as const, value: chunk })
        if (ended) return Promise.resolve({ done: true as const, value: undefined })
        return new Promise<IteratorResult<Uint8Array>>((resolve) => readers.push(resolve))
      },
      return: async () => {
        returned++
        end()
        return { done: true as const, value: undefined }
      },
    }),
  }
  const write = async (bytes: Uint8Array) => {
    for (const payload of reader.push(bytes)) {
      const frame = Codec.decode("ChildFrame", payload)
      frames.push(frame)
      observers.forEach((notify) => notify())
      if (options.write) await options.write(frame)
      if (frame.declared && options.admit !== false) send({ setup: {} })
      if (frame.registration_update) {
        const update = object(frame.registration_update)
        send({ registration_reply: { request: update.request, done: {} } })
      }
      for (const [key, owner] of [["plugin_call", "plugin"], ["host_call", "call"]] as const) {
        if (!frame[key]) continue
        const request = object(frame[key])
        const operation = Object.keys(request).find((name) => name !== "request" && name !== "call")
        if (!operation) throw new Error("Missing serialized SDK operation")
        const captured: Request = { operation, payload: object(request[operation]), owner }
        requests.push(captured)
        const reply = options.reply?.(captured)
        if (!reply) continue
        const outcome = "value" in reply
          ? { value: Codec.value(reply.value) }
          : { failure: { code: reply.failure.code, message: Codec.text(reply.failure.message) } }
        send({
          [owner === "plugin" ? "plugin_reply" : "host_reply"]: {
            request: request.request,
            ...(owner === "call" ? { call: request.call } : {}),
            ...outcome,
          },
        })
      }
    }
  }
  const run = PluginHost.serve({ input, write }, async () => plugin)
  const outcome: Promise<Outcome> = run.then((code) => ({ code }), (error: unknown) => ({ error }))
  const next = async (key: string, matches: (value: Frame) => boolean = () => true, from = 0): Promise<Frame> => {
    for (;;) {
      const found = frames.slice(from).find((frame) => frame[key] !== undefined && matches(object(frame[key])))
      if (found) return object(found[key])
      let notify: () => void = () => undefined
      const changed = new Promise<void>((resolve) => {
        notify = resolve
        observers.add(notify)
      })
      try {
        await bounded(Promise.race([
          changed,
          outcome.then((exit) => {
            if (frames.slice(from).some((frame) => frame[key] !== undefined && matches(object(frame[key])))) return
            throw new Error(`Host ended before ${key}: ${"code" in exit ? exit.code : failures(exit.error)}`)
          }),
        ]), 1_500, `Host frame deadline exceeded: ${key}`)
      } finally {
        observers.delete(notify)
      }
    }
  }
  send({
    hello: {
      revision: 5,
      identity: plugin.id,
      generation,
      grants: [],
      registration_order: 0,
      parent_plugin: true,
      plugin: { target: Codec.text("parent:fixture"), options: Codec.value(options.options ?? {}), cache: Codec.text(cache) },
    },
  })
  return {
    frames,
    requests,
    outcome,
    send,
    sendBytes,
    end,
    next,
    returned: () => returned,
    ready: () => next("register_tools"),
    async stop() {
      try {
        if (!ended) send({ shutdown: {} })
        return await bounded(outcome, 750, "Host settlement deadline exceeded")
      } finally { end() }
    },
    registrations() {
      return frames.flatMap((frame) => {
        if (frame.register_tools) return [object(frame.register_tools)]
        const update = frame.registration_update ? object(frame.registration_update) : undefined
        return update && update.add ? [object(update.add)] : []
      })
    },
    async transform(stage: number, draft: unknown, invocation = 1) {
      const registration = this.registrations()
        .flatMap((item) => array(item.transforms ?? []))
        .map(object)
        .findLast((item) => item.stage === stage)
      if (!registration) throw new Error(`No live transform for stage ${stage}`)
      send({ transform: { call: call(invocation), registration: registration.id, stage, revision: 1, draft: Codec.value(draft) } })
      return next("transformed", (item) => object(item.call).invocation === invocation)
    },
    async execute(name: string, invocation = 1, input: unknown = {}, implementation?: unknown, namespace = "") {
      send({ execute: { call: call(invocation), namespace, tool: name, input: Codec.value(input), ...(implementation === undefined ? {} : { implementation }) } })
      return next("result", (item) => object(item.call).invocation === invocation)
    },
    tools() {
      return this.registrations().flatMap((item) => array(item.tools ?? [])).map(object)
    },
  }
}
