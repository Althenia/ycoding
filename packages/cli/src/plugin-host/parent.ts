export * as PluginParent from "./parent"

import type { ChildProcess } from "node:child_process"
import { Duplex } from "node:stream"
// ast-grep-ignore: no-star-import
import * as EffectRuntime from "effect"
import { Codec } from "./codec"
import { PluginContext } from "./context"
import { PluginHost } from "./host"
import { PluginSDK } from "./sdk"

export const extraStdio = ["pipe", "pipe"] as const
export const descriptorArguments = ["--plugin-parent-fd", "3", "--plugin-parent-cleanup-fd", "4"] as const
export type Manifest = ReadonlyArray<{ readonly id: string; readonly version: number }>
export type Attachment = {
  readonly manifest: Manifest
  readonly attach: (child: ChildProcess) => void
  readonly run: () => Promise<void>
  readonly retire: () => void
  readonly close: () => Promise<void>
  readonly join: () => Promise<void>
}

export function make(plugins: ReadonlyArray<unknown>): Attachment {
  PluginSDK.initialize(EffectRuntime)
  const registry = new Map<string, { readonly plugin: unknown; readonly version: number }>()
  plugins.forEach((plugin, index) => {
    const definition = PluginContext.definition(plugin)
    if (!definition.id || definition.id.length > 256 || /[\u0000-\u001f]/.test(definition.id)) throw new Error("Invalid parent plugin identity")
    registry.set(definition.id, { plugin, version: index + 1 })
  })
  const manifest = Object.freeze([...registry].map(([id, entry]) => Object.freeze({ id, version: entry.version })))
  const generations = new Map<string, { readonly input: Input; readonly task: Promise<void>; hello: boolean }>()
  const seen = new Set<string>()
  const errors: unknown[] = []
  const completed = Promise.withResolvers<void>()
  void completed.promise.catch(() => undefined)
  let data: Duplex | undefined
  let lease: Duplex | undefined
  let writes = Promise.resolve()
  let reading: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let retired = false
  let attached = false

  const send = (frame: Codec.Message) => {
    const bytes = Codec.frame(Codec.encode("ParentFrame", frame))
    writes = writes.then(() => new Promise<void>((resolve, reject) => {
      if (!data || data.destroyed || !data.writable) return reject(new Error("Parent data channel is closed"))
      data.write(bytes, (error) => error ? reject(error) : resolve())
    }))
    void writes.catch((error) => { errors.push(error); void close().catch(() => undefined) })
    return writes
  }
  const settle = () => {
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Parent attachment and cleanup failed")
  }
  const retire = () => {
    if (retired) return
    retired = true
    if (attached) void send({ retire: {} }).catch(() => undefined)
    for (const [generation, entry] of generations) {
      if (entry.hello) entry.input.push(Codec.frame(Codec.encode("HostFrame", { generation, shutdown: {} })))
      else entry.input.end()
    }
  }
  const close = (): Promise<void> => closing ??= (async () => {
    retire()
    while (generations.size) await Promise.allSettled([...generations.values()].map((entry) => entry.task))
    try { await writes } catch (error) { errors.push(error) }
    if (lease) {
      try {
        await new Promise<void>((resolve, reject) => {
          if (lease!.destroyed) return reject(new Error("Parent cleanup lease ended before cleanup joined"))
          lease!.end((error?: Error | null) => error ? reject(error) : resolve())
        })
      } catch (error) { errors.push(error); lease.destroy() }
    }
    settle()
  })()

  const open = (value: Codec.Message) => {
    const generation = String(value.generation)
    const registered = registry.get(String(value.id))
    if (retired || !generation || seen.has(generation) || !registered || value.version !== registered.version) throw new Error("Parent generation binding rejected")
    seen.add(generation)
    const input = new Input()
    const task = Promise.resolve().then(async () => {
      let failure: unknown
      try {
        const code = await PluginHost.serve({
          input,
          write: async (bytes) => {
            const frames = new Codec.FrameReader().push(bytes)
            if (frames.length !== 1) throw new Error("Invalid parent child frame")
            const child = Codec.decode("ChildFrame", frames[0]!)
            if (child.generation !== generation) throw new Error("Foreign parent generation output")
            await send({ data: { generation, payload: frames[0] } })
          },
        }, async () => registered.plugin)
        if (code !== 0) throw new Error("Parent generation failed before joined shutdown")
      } catch (error) { failure = error; errors.push(error) }
      try { await send({ closed: { generation, ...(failure === undefined ? {} : { failure: Codec.text(describe(failure)) }) } }) }
      catch (error) { errors.push(error) }
      finally { input.end(); generations.delete(generation) }
    })
    generations.set(generation, { input, task, hello: false })
    void task.catch((error) => { errors.push(error); void close().catch(() => undefined) })
  }

  return {
    manifest,
    attach(child) {
      if (attached) throw new Error("Parent attachment already adopted")
      const channel = child.stdio[3]
      const cleanup = child.stdio[4]
      if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0 || !(channel instanceof Duplex) || !(cleanup instanceof Duplex) || channel === cleanup || !channel.readable || !channel.writable || !cleanup.writable)
        throw new Error("Parent attachment requires distinct real duplex data and cleanup lease resources")
      attached = true
      data = channel
      lease = cleanup
      lease.on("error", (error) => { errors.push(error); void close().catch(() => undefined) })
      const reader = new Codec.FrameReader()
      reading = (async () => {
        try {
          await send({ manifest: { pid: child.pid, plugins: manifest } })
          for await (const chunk of channel) {
            for (const payload of reader.push(chunk)) {
              const frame = Codec.decode("ParentFrame", payload)
              if (frame.open) open(frame.open as Codec.Message)
              else if (frame.data) {
                const value = frame.data as Codec.Message
                const generation = String(value.generation)
                const entry = generations.get(generation)
                if (!entry) throw new Error("Unknown parent generation")
                const body = Codec.decode("HostFrame", value.payload as Uint8Array)
                if (body.generation !== generation) throw new Error("Foreign parent generation input")
                if (body.hello) entry.hello = true
                entry.input.push(Codec.frame(value.payload as Uint8Array))
              } else if (frame.shutdown) void close().catch(() => undefined)
              else if (frame.retire) retire()
              else throw new Error("Invalid native parent control frame")
            }
          }
          reader.finish()
          if (!retired) throw new Error("Parent data channel ended before retirement")
        } catch (error) { errors.push(error) }
        finally {
          for (const entry of generations.values()) entry.input.end()
          try { await close() } catch (error) { if (!errors.includes(error)) errors.push(error) }
        }
        settle()
      })()
      void reading.then(completed.resolve, completed.reject)
    },
    run: () => completed.promise,
    retire,
    close,
    async join() {
      if (!attached) return
      try { await reading } finally { data?.destroy(); lease?.destroy() }
      settle()
    },
  }
}

class Input implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = []
  private readers: Array<(value: IteratorResult<Uint8Array>) => void> = []
  private ended = false
  push(chunk: Uint8Array) {
    if (this.ended) throw new Error("Parent generation input is closed")
    const reader = this.readers.shift()
    if (reader) reader({ done: false, value: chunk })
    else this.chunks.push(chunk)
  }
  end() {
    this.ended = true
    this.readers.splice(0).forEach((reader) => reader({ done: true, value: undefined }))
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.chunks.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.readers.push(resolve))
      },
      return: async () => { this.end(); return { done: true, value: undefined } },
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(describe)].join("\n")
  return error instanceof Error ? error.message : String(error)
}
