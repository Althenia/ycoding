export * as PluginHost from "./host"

import { AsyncLocalStorage } from "node:async_hooks"
import type { Scope } from "effect"
import { Codec } from "./codec"
import { PluginContext } from "./context"
import { PluginTool } from "./tool"
import { runtime } from "./sdk"

export type IO = {
  readonly input: AsyncIterable<Uint8Array>
  readonly write: (bytes: Uint8Array) => Promise<void>
}
export type Launch = {
  readonly target: string
  readonly options: Record<string, unknown>
  readonly cache: string
  readonly modelPackage?: boolean
}
export type Loader = (launch: Launch) => Promise<unknown>

const REVISION = 5
const Stage = {
  agents: 1,
  commands: 2,
  references: 3,
  skills: 4,
  catalog: 5,
  context: 6,
  before: 7,
  after: 8,
  integrations: 10,
} as const
const FailureCode = { rejected: 1, failed: 2, unknown: 3 } as const

type Call = Codec.Message & { readonly invocation: number }
type Invocation = {
  readonly call: Call
  readonly controller: AbortController
  settled: boolean
  cancelled: boolean
  readonly pending: Set<number>
}
type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
type Registered = {
  readonly implementation: number
  readonly name: string
  readonly namespace?: string
  readonly tool: PluginTool.AnyTool
  readonly codemode: boolean
  readonly path?: string
}

export async function serve(io: IO, load: Loader): Promise<number> {
  const reader = new Codec.FrameReader()
  const owner = new AsyncLocalStorage<Invocation>()
  const invocations = new Map<number, Invocation>()
  const pending = new Map<number, Pending>()
  const hooks = new Map<number, { readonly callbacks: Array<(event: any) => unknown>; readonly ready: Promise<void> }>()
  const tools = new Map<string, Registered>()
  const toolRegistrations = new Map<string, Registered[]>()
  const implementations = new Map<number, Registered>()
  const generationController = new AbortController()
  const errors: unknown[] = []
  const authMethods = new Map<number, Record<string, any>>()
  const authorizations = new Map<number, { readonly value: Record<string, any>; readonly scope: Scope.Closeable }>()
  let nextImplementation = 0
  let parent = false
  let generation = ""
  let writes = Promise.resolve()
  let nextRequest = 0
  let ready = false
  let registered = false
  let scope: Scope.Closeable | undefined
  const languageHooks = new Map<string, Array<(event: any) => unknown>>([
    ["sdk", []],
    ["language", []],
  ])
  const languages = new Map<string, LanguageModel>()
  const streams = new Map<number, { controller: AbortController; credit: boolean; waiting?: () => void }>()
  const listeners = new Map<number, { listener: (event: unknown) => void; end: () => void }>()
  let nextSubscription = 0
  let ended = false
  const tasks = new Set<Promise<unknown>>()
  const failed = Promise.withResolvers<number>()
  const admitted = Promise.withResolvers<void>()
  void admitted.promise.catch(() => undefined)

  const send = (body: Codec.Message) => {
    const bytes = Codec.frame(Codec.encode("ChildFrame", { generation, ...body }))
    writes = writes.then(() => io.write(bytes))
    void writes.catch(() => failed.resolve(1))
    return writes
  }

  const track = <A>(task: Promise<A>): Promise<A> => {
    tasks.add(task)
    const settled = () => tasks.delete(task)
    void task.then(settled, settled)
    return task
  }

  const run = <A>(task: Promise<A>): Promise<A> => {
    track(task)
    void task.catch((error: unknown) => {
        errors.push(error)
        failed.resolve(1)
      })
    return task
  }

  const runEffect = <A, E>(effect: import("effect").Effect.Effect<A, E>): Promise<A> =>
    runtime.Effect.runPromise(effect, { signal: owner.getStore()?.controller.signal ?? generationController.signal })

  const call = (operation: string, payload: Codec.Message) =>
    new Promise<unknown>((resolve, reject) => {
      const active = owner.getStore()
      if (ended || generationController.signal.aborted) return reject(new Error("Plugin generation is retired"))
      if (active && (active.settled || active.cancelled)) return reject(new Error("Plugin call owner has ended"))
      const request = ++nextRequest
      pending.set(request, { resolve, reject })
      if (active && !active.settled && !active.cancelled) {
        active.pending.add(request)
        run(send({ host_call: { call: active.call, request, [operation]: payload } }))
        return
      }
      run(send({ plugin_call: { request, [operation]: payload } }))
    })

  const settle = (request: number, outcome: Codec.Message) => {
    const waiter = pending.get(request)
    if (!waiter) return
    pending.delete(request)
    invocations.forEach((invocation) => invocation.pending.delete(request))
    if (outcome.value) return waiter.resolve(Codec.readValue(outcome.value))
    const failure = outcome.failure as Codec.Message
    waiter.reject(
      new Error(
        failure.message === undefined
          ? `Plugin host call ${failure.code === FailureCode.rejected ? "rejected" : failure.code === FailureCode.unknown ? "outcome unknown" : "failed"}`
          : Codec.readText(failure.message),
      ),
    )
  }

  const release = (invocation: Invocation) => {
    invocation.settled = true
    invocations.delete(invocation.call.invocation)
    invocation.pending.forEach((request) => {
      pending.get(request)?.reject(new Error("Plugin host call ended with its owning call"))
      pending.delete(request)
    })
  }

  const update = (add: Codec.Message, remove: string[] = []) => {
    if (ended || generationController.signal.aborted) throw new Error("Plugin generation is retired")
    if (!registered && !parent) return Promise.resolve()
    const request = ++nextRequest
    const reply = new Promise<void>((resolve, reject) => pending.set(request, { resolve: () => resolve(), reject }))
    return run(send({ registration_update: { request, add, remove } }).then(() => reply))
  }

  const declaration = (entry: Registered): Codec.Message => {
    const definition = PluginTool.definition(entry.tool)
    return {
      namespace: entry.namespace ?? "", name: entry.name,
      description: Codec.text(definition.description), input_schema: Codec.value(definition.input), output_schema: Codec.value(definition.output ?? null),
      direct: !entry.codemode, code_mode: entry.codemode,
      permission: PluginTool.permission(entry.tool, entry.namespace === undefined ? entry.name : `${entry.namespace.replaceAll(".", "_")}_${entry.name}`),
      ...(parent ? { implementation: entry.implementation, ...(entry.path === undefined ? {} : { path: Codec.text(entry.path) }) } : {}),
    }
  }

  const register = (stage: number, callback: (event: any) => unknown): PluginContext.Registration => {
    if (ended || generationController.signal.aborted) throw new Error("Plugin generation is retired")
    if (registered && !parent) throw new Error("Plugin registrations after setup are not supported")
    let registration = hooks.get(stage)
    if (!registration) {
      registration = { callbacks: [], ready: update({ transforms: [{ id: `stage-${stage}`, stage }] }) }
      hooks.set(stage, registration)
    }
    const list = registration.callbacks
    list.push(callback)
    return {
      ready: registration.ready,
      dispose: async () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      },
    }
  }

  const registerLanguage = (name: string, callback: (event: any) => unknown): PluginContext.Registration => {
    if (ended || generationController.signal.aborted) throw new Error("Plugin generation is retired")
    if (registered && !parent) throw new Error("Plugin registrations after setup are not supported")
    const list = languageHooks.get(name)
    if (!list) throw new Error(`Unknown AI SDK hook ${name}`)
    list.push(callback)
    languages.clear()
    return {
      ready: Promise.resolve(),
      dispose: async () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
        languages.clear()
      },
    }
  }

  const resolveLanguage = async (pkg: string, model: unknown, options: unknown) => {
    const key = JSON.stringify([pkg, model, options])
    const cached = languages.get(key)
    if (cached) return cached
    const prepared = prepareOptions(model, options)
    const sdk: { model: unknown; package: string; options: unknown; sdk?: unknown } = {
      model,
      package: pkg,
      options: prepared,
    }
    for (const callback of languageHooks.get("sdk") ?? []) await callback(sdk)
    const language: { model: unknown; sdk: unknown; options: unknown; language?: unknown } = {
      model,
      sdk: sdk.sdk,
      options: prepared,
    }
    for (const callback of languageHooks.get("language") ?? []) await callback(language)
    const resolved = language.language ?? defaultLanguage(sdk.sdk, model)
    if (!isLanguageModel(resolved)) return undefined
    languages.set(key, resolved)
    return resolved
  }

  const languageAttempt = async (frame: Codec.Message) => {
    const request = frame.request as number
    const controller = new AbortController()
    const stream = { controller, credit: false, waiting: undefined as (() => void) | undefined }
    if (streams.has(request)) throw new Error("Duplicate plugin language attempt")
    streams.set(request, stream)
    const failed = (code: number, error: unknown) =>
      send({ language_result: { request, failure: { code, message: Codec.text(errorMessage(error)) } } })
    let reader: ReadableStreamDefaultReader<unknown> | undefined
    const abort = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Plugin language stream cancelled")), {
        once: true,
      })
    })
    try {
      const language = await Promise.race([
        track(resolveLanguage(String(frame.package), Codec.readValue(frame.model), Codec.readValue(frame.options))),
        abort,
      ])
      if (!language) return await failed(FailureCode.rejected, "No configured plugin provides this language model")
      const starting = Promise.resolve().then(() =>
        language.doStream({
          ...(Codec.readValue(frame.body) as Record<string, unknown>),
          abortSignal: controller.signal,
        }),
      )
      run(
        starting.then(
          async (result) => {
            if (controller.signal.aborted) await result.stream.cancel()
          },
          () => undefined,
        ),
      )
      const result = await Promise.race([starting, abort])
      reader = result.stream.getReader()
      await send({ language_parts: { request, parts: [] } })
      for (;;) {
        if (!stream.credit)
          await Promise.race([
            new Promise<void>((resolve) => {
              stream.waiting = resolve
            }),
            abort,
          ])
        stream.credit = false
        stream.waiting = undefined
        const next = await Promise.race([reader.read(), abort])
        if (next.done) break
        await send({ language_parts: { request, parts: [Codec.value(next.value)] } })
      }
      await send({ language_result: { request, done: {} } })
    } catch (error) {
      await failed(controller.signal.aborted ? FailureCode.rejected : FailureCode.failed, error)
    } finally {
      streams.delete(request)
      if (reader) {
        await reader.cancel()
        reader.releaseLock()
      }
    }
  }

  const addTool = (name: string, tool: PluginTool.AnyTool, options?: PluginTool.RegisterOptions): PluginContext.Registration => {
    if (ended || generationController.signal.aborted) throw new Error("Plugin generation is retired")
    if (registered && !parent) throw new Error("Plugin registrations after setup are not supported")
    const normalized = PluginTool.normalize(name)
    const key = `${options?.namespace ?? ""}\u0000${normalized}`
    const entry: Registered = {
      implementation: ++nextImplementation,
      name: normalized,
      namespace: options?.namespace,
      tool,
      codemode: options?.codemode ?? true,
      path: options?.paths?.[name],
    }
    tools.set(key, entry)
    const registrations = toolRegistrations.get(key) ?? []
    registrations.push(entry)
    toolRegistrations.set(key, registrations)
    implementations.set(entry.implementation, entry)
    const ready = update({ tools: [declaration(entry)] })
    let disposed = false
    return {
      ready,
      dispose: async () => {
        if (disposed) return
        disposed = true
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
        const visible = registrations.at(-1)
        if (visible) tools.set(key, visible)
        else { tools.delete(key); toolRegistrations.delete(key) }
        if (!ended && !generationController.signal.aborted && parent) await update({}, [`tool:${entry.implementation}`])
      },
    }
  }

  const subscribe = (listener: (event: unknown) => void, end: () => void) => {
    if (ended || generationController.signal.aborted) {
      end()
      return () => undefined
    }
    const id = ++nextSubscription
    listeners.set(id, { listener, end })
    run(send({ subscribe: { id, families: ["*"] } }))
    return () => {
      if (!listeners.delete(id) || ended) return
      run(send({ unsubscribe: { subscription: id } }))
    }
  }

  const endListeners = () => {
    ended = true
    listeners.forEach((entry) => entry.end())
    listeners.clear()
  }

  const ownerEnded = new Error("Plugin setup owner ended")

  const setup = async (launch: Launch) => {
    const definition = PluginContext.definition(await load(launch))
    await send({ declared: { id: Codec.text(definition.id) } })
    await admitted.promise
    scope = runtime.Effect.runSync(runtime.Scope.make())
    const contexts = PluginContext.make({
      parent,
      options: launch.options,
      call,
      register,
      registerLanguage,
      addTool,
      runEffect,
      track,
      subscribe,
      Stage,
    })
    await runEffect(runtime.Scope.provide(scope)(definition.effect(contexts)))
    if (ended) throw ownerEnded
    registered = true
    await send({
      register_tools: {
        tools: parent ? [] : [...tools.values()].map(declaration),
        transforms: parent ? [] : [...hooks.keys()].map((stage) => ({ id: `stage-${stage}`, stage })),
        domains: [],
        subscriptions: [],
        oauth: [],
      },
    })
  }

  const execute = (frame: Codec.Message) => {
    const call = frame.call as Call
    if (invocations.has(call.invocation)) throw new Error("Duplicate plugin invocation")
    const entry = frame.implementation === undefined ? tools.get(`${frame.namespace}\u0000${frame.tool}`) : implementations.get(Number(frame.implementation))
    const invocation: Invocation = {
      call,
      controller: new AbortController(),
      settled: false,
      cancelled: false,
      pending: new Set(),
    }
    invocations.set(call.invocation, invocation)
    run(owner.run(invocation, async () => {
      const exit = entry
        ? await runtime.Effect.runPromiseExit(
            PluginTool.settle(entry.tool, Codec.readValue(frame.input), {
              sessionID: String(call.session_id),
              agent: String(call.agent),
              messageID: String(call.message_id),
              callID: Codec.readText(call.call_id),
              progress: (update) =>
                runtime.Effect.promise(() =>
                  invocation.settled || invocation.cancelled
                    ? Promise.resolve()
                    : send({
                        progress: {
                          call,
                          output: output({ structured: update.structured, content: update.content ?? [] }),
                        },
                      }),
                ),
            }),
            { signal: invocation.controller.signal },
          )
        : runtime.Exit.fail(new PluginTool.Failure(`Unknown plugin tool ${String(frame.tool)}`))
      const cancelled = invocation.cancelled
      release(invocation)
      if (cancelled) return send({ cleanup: { call } })
      if (runtime.Exit.isSuccess(exit)) return send({ result: { call, output: output(exit.value) } })
      return send({
        result: { call, failure: { code: FailureCode.failed, message: Codec.text(failureMessage(exit.cause)) } },
      })
    }))
  }

  const transform = (frame: Codec.Message) => {
    const call = frame.call as Call
    if (invocations.has(call.invocation)) throw new Error("Duplicate plugin invocation")
    const invocation: Invocation = {
      call,
      controller: new AbortController(),
      settled: false,
      cancelled: false,
      pending: new Set(),
    }
    invocations.set(call.invocation, invocation)
    run(owner.run(invocation, async () => {
      const oauth: Codec.Message[] = []
      const outcome = await PluginContext.transform(
        frame.stage as number,
        Codec.readValue(frame.draft),
        call,
        hooks.get(frame.stage as number)?.callbacks ?? [],
        (registration) => {
          const implementation = ++nextImplementation
          authMethods.set(implementation, registration)
          oauth.push({ integration: registration.integrationID, method: Codec.value(registration.method), refresh: typeof registration.refresh === "function", label: typeof registration.label === "function", implementation })
        },
      )
        .then((draft) => ({ draft: Codec.value(draft) }))
        .catch((error: unknown) => ({
          failure: { code: FailureCode.failed, message: Codec.text(errorMessage(error)) },
        }))
      const cancelled = invocation.cancelled
      release(invocation)
      if (cancelled) return send({ cleanup: { call } })
      return send({ transformed: { call, stage: frame.stage, revision: frame.revision, ...outcome, oauth } })
    }))
  }

  const close = async () => {
    if (!scope) return
    const closing = scope
    scope = undefined
    await runtime.Effect.runPromise(runtime.Scope.close(closing, runtime.Exit.void))
  }

  const auth = async (request: Codec.Message) => {
    const id = Number(request.request)
    const effect = (value: unknown) => runtime.Effect.isEffect(value)
      ? value as import("effect").Effect.Effect<any, unknown>
      : runtime.Effect.tryPromise({ try: () => Promise.resolve(value), catch: (error) => error })
    const closeAuthorization = async (id: number) => {
      const authorization = authorizations.get(id)
      if (!authorization) return
      authorizations.delete(id)
      await runtime.Effect.runPromise(runtime.Scope.close(authorization.scope, runtime.Exit.void))
    }
    try {
      const operation = (request.authorize ?? request.refresh ?? request.label) as Codec.Message | undefined
      if (operation) {
        const method = authMethods.get(Number(operation.implementation))
        if (!method || method.integrationID !== operation.integration || method.method.id !== operation.method) throw new Error("Unknown OAuth implementation")
        if (request.authorize) {
          const scope = runtime.Effect.runSync(runtime.Scope.make())
          try {
            const value = await runEffect(runtime.Scope.provide(scope)(effect(method.authorize(Codec.readValue(operation.inputs)))))
            authorizations.set(id, { value, scope })
            await send({ auth_reply: { request: id, authorization: {
              url: Codec.text(value.url), instructions: Codec.text(value.instructions), expires_at: value.expiresAt,
              mode: value.mode === "code" ? 2 : 1, manual_code: typeof value.submitCode === "function",
            } } })
          } catch (error) {
            try { await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void)) }
            catch (cleanup) { throw new AggregateError([error, cleanup], "OAuth authorization and cleanup failed") }
            throw error
          }
        } else if (request.refresh) {
          if (!method.refresh) throw new Error("OAuth refresh unavailable")
          const credential = await runEffect(effect(method.refresh(Codec.readValue(operation.credential))))
          await send({ auth_reply: { request: id, credential: Codec.value(credential) } })
        } else {
          if (!method.label) throw new Error("OAuth label unavailable")
          const label = method.label(Codec.readValue(operation.credential))
          await send({ auth_reply: { request: id, label: Codec.text(label ?? "") } })
        }
        return
      }
      const input = (request.callback ?? request.submit) as Codec.Message | undefined
      const authorization = input && authorizations.get(Number(input.authorization))
      if (!input || !authorization) throw new Error("Unknown OAuth authorization")
      if (request.submit) {
        if (!authorization.value.submitCode) throw new Error("OAuth manual code unavailable")
        await runEffect(effect(authorization.value.submitCode(Codec.readText(input.code))))
        await send({ auth_reply: { request: id, done: {} } })
        return
      }
      try {
        const callback = authorization.value.callback
        const credential = await runEffect(effect(typeof callback === "function" ? callback(Codec.readText(input.code)) : callback))
        await closeAuthorization(Number(input.authorization))
        await send({ auth_reply: { request: id, credential: Codec.value(credential) } })
      } catch (error) {
        try { await closeAuthorization(Number(input.authorization)) }
        catch (cleanup) { throw new AggregateError([error, cleanup], "OAuth callback and cleanup failed") }
        throw error
      }
    } catch (error) {
      await send({ auth_reply: { request: id, failure: { code: FailureCode.failed, message: Codec.text(errorMessage(error)) } } })
    }
  }

  const dispatch = async (frame: Codec.Message): Promise<number | undefined> => {
    if (!ready) {
      const hello = frame.hello as Codec.Message | undefined
      const plugin = hello?.plugin as Codec.Message | undefined
      if (!hello || hello.revision !== REVISION || !plugin) return 1
      generation = String(hello.generation)
      if (frame.generation !== generation) throw new Error("Foreign plugin generation")
      parent = hello.parent_plugin === true
      ready = true
      await send({ ready: { revision: REVISION, identity: hello.identity, generation } })
      const options = Codec.readValue(plugin.options)
      const failed = await setup({
        target: Codec.readText(plugin.target),
        options:
          options && typeof options === "object" && !Array.isArray(options) ? (options as Record<string, unknown>) : {},
        cache: Codec.readText(plugin.cache),
        modelPackage: plugin.model_package === true,
      }).then(
        () => undefined,
        (error: unknown) => {
          if (error === ownerEnded) return undefined
          errors.push(error)
          return 1
        },
      )
      return failed
    }
    if (frame.generation !== generation) return 1
    if (frame.setup) admitted.resolve()
    if (frame.execute) execute(frame.execute as Codec.Message)
    if (frame.transform) transform(frame.transform as Codec.Message)
    if (frame.language_resolve) {
      const resolve = frame.language_resolve as Codec.Message
      run(
        resolveLanguage(String(resolve.package), Codec.readValue(resolve.model), Codec.readValue(resolve.options))
          .then((language) => ({ handled: language !== undefined }))
          .catch((error: unknown) => ({
            handled: false,
            failure: { code: FailureCode.failed, message: Codec.text(errorMessage(error)) },
          }))
          .then((outcome) => ended ? undefined : send({ language_resolved: { request: resolve.request, ...outcome } })),
      )
    }
    if (frame.language_attempt) run(languageAttempt(frame.language_attempt as Codec.Message))
    if (frame.language_cancel)
      streams.get((frame.language_cancel as Codec.Message).request as number)?.controller.abort()
    if (frame.language_credit) {
      const stream = streams.get((frame.language_credit as Codec.Message).request as number)
      if (stream) {
        if (stream.credit) throw new Error("Duplicate plugin language credit")
        stream.credit = true
        stream.waiting?.()
      }
    }
    if (frame.cancel) {
      const invocation = invocations.get(((frame.cancel as Codec.Message).call as Call).invocation)
      if (invocation) {
        invocation.cancelled = true
        invocation.controller.abort()
      }
    }
    if (frame.host_reply) {
      const reply = frame.host_reply as Codec.Message
      settle(reply.request as number, reply)
    }
    if (frame.plugin_reply) {
      const reply = frame.plugin_reply as Codec.Message
      settle(reply.request as number, reply)
    }
    if (frame.registration_reply) {
      const reply = frame.registration_reply as Codec.Message
      const waiter = pending.get(Number(reply.request))
      if (!waiter) throw new Error("Unknown registration reply")
      pending.delete(Number(reply.request))
      if (reply.failure) waiter.reject(new Error(Codec.readText((reply.failure as Codec.Message).message)))
      else waiter.resolve(undefined)
    }
    if (frame.release) {
      for (const id of (frame.release as Codec.Message).implementations as number[]) {
        implementations.delete(id)
        authMethods.delete(id)
      }
    }
    if (frame.auth) {
      if (!parent) throw new Error("Module OAuth callbacks are not supported")
      run(auth(frame.auth as Codec.Message))
    }
    if (frame.event) {
      const event = frame.event as Codec.Message
      await send({ event_receipt: { delivery: event.delivery } })
      listeners.get(event.subscription as number)?.listener(Codec.readValue(event.envelope))
    }
    if (frame.shutdown) {
      return 0
    }
    return undefined
  }

  // Setup awaits replies to its own SDK calls, so host frames keep flowing while it runs.
  const iterator = io.input[Symbol.asyncIterator]()
  let reading: Promise<IteratorResult<Uint8Array>> | undefined
  let starting: Promise<number | undefined> | undefined
  let status: number | undefined
  try {
  receive: for (;;) {
    reading ??= iterator.next()
    const event = await Promise.race([
      failed.promise.then((code) => ({ code })),
      starting
        ? Promise.race([reading.then((read) => ({ read })), starting.then((code) => ({ code }))])
        : reading.then((read) => ({ read })),
    ])
    if ("code" in event) {
      starting = undefined
      if (event.code === undefined) continue
      status = event.code
      break
    }
    reading = undefined
    if (event.read.done) { reader.finish(); status = 1; break }
    for (const payload of reader.push(event.read.value)) {
      const frame = Codec.decode("HostFrame", payload)
      if (!ready) {
        starting = dispatch(frame)
        continue
      }
      const next = await dispatch(frame)
      if (next === undefined) continue
      status = next
      break receive
    }
  }
  } catch (error) { errors.push(error); status = 1 }
  endListeners()
  admitted.reject(ownerEnded)
  generationController.abort()
  invocations.forEach((invocation) => { invocation.cancelled = true; invocation.controller.abort() })
  streams.forEach((stream) => stream.controller.abort())
  pending.forEach((waiter) => waiter.reject(new Error("Plugin host channel closed")))
  pending.clear()
  if (starting) await starting.catch((error) => errors.push(error))
  while (tasks.size) await Promise.allSettled([...tasks])
  for (const authorization of authorizations.values()) {
    try { await runtime.Effect.runPromise(runtime.Scope.close(authorization.scope, runtime.Exit.void)) }
    catch (error) { errors.push(error) }
  }
  authorizations.clear()
  try { await close() } catch (error) { errors.push(error) }
  if (status === 0 && !errors.length) {
    try { await send({ stopped: {} }) } catch (error) { errors.push(error) }
  }
  try { await writes } catch (error) { errors.push(error) }
  if (reading) {
    void reading.catch(() => undefined)
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  } else {
    try { await iterator.return?.() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Plugin generation and cleanup failed")
  return status ?? 1
}

type LanguageModel = {
  readonly doStream: (options: Record<string, unknown>) => Promise<{ readonly stream: ReadableStream<unknown> }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function prepareOptions(model: unknown, configuration: unknown) {
  const info = isRecord(model) ? model : {}
  const options: Record<string, unknown> = {
    name: info.providerID,
    ...(isRecord(configuration) ? configuration : {}),
    headers: info.headers,
    body: info.body,
  }
  options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      isRecord(info.headers)
        ? Object.entries(info.headers).map(([name, value]) => {
            if (typeof value !== "string") throw new Error("Catalog request headers must be strings")
            return [name, value]
          })
        : undefined,
    )
    if (input instanceof Request) input.headers.forEach((value, name) => headers.set(name, value))
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    const body =
      init?.body ?? (input instanceof Request && info.body !== undefined ? await input.clone().text() : undefined)
    const decoded =
      typeof body === "string" && isRecord(info.body)
        ? runtime.Schema.decodeUnknownOption(runtime.Schema.UnknownFromJsonString)(body)
        : runtime.Option.none()
    return fetch(input, {
      ...init,
      headers,
      ...(body === undefined
        ? {}
        : {
            body:
              runtime.Option.isSome(decoded) && isRecord(decoded.value) && isRecord(info.body)
                ? JSON.stringify(mergeBody(decoded.value, info.body))
                : body,
          }),
    })
  }
  return options
}

function mergeBody(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(overlay).map(([name, value]) => [
      name,
      isRecord(base[name]) && isRecord(value) ? mergeBody(base[name], value) : value,
    ]),
  ])
}

function isLanguageModel(value: unknown): value is LanguageModel {
  return !!value && typeof value === "object" && "doStream" in value && typeof value.doStream === "function"
}

function defaultLanguage(sdk: unknown, model: unknown) {
  if (
    !sdk ||
    (typeof sdk !== "object" && typeof sdk !== "function") ||
    !("languageModel" in sdk) ||
    typeof sdk.languageModel !== "function"
  )
    return undefined
  const info = isRecord(model) ? model : {}
  return sdk.languageModel(String(info.modelID ?? info.id))
}

function output(value: { readonly structured: unknown; readonly content: ReadonlyArray<any> }) {
  return {
    structured: Codec.value(value.structured ?? null),
    content: value.content.map((item) =>
      item.type === "text"
        ? { text: Codec.text(item.text) }
        : item.type === "file" && "uri" in item
          ? {
              file: {
                uri: Codec.text(item.uri),
                mime: Codec.text(item.mime),
                ...(item.name ? { name: Codec.text(item.name) } : {}),
              },
            }
          : {
              file: {
                uri: Codec.text(`data:${item.mime};base64,${item.data}`),
                mime: Codec.text(item.mime),
                ...(item.name ? { name: Codec.text(item.name) } : {}),
              },
            },
    ),
  }
}

function failureMessage(cause: unknown) {
  const failure = (cause as any)?.failures?.[0] ?? (cause as any)?.reasons?.[0]
  const error = failure?.error ?? failure?.defect ?? failure
  return errorMessage(error ?? cause)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
