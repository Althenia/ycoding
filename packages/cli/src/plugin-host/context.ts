export * as PluginContext from "./context"

import { ascending } from "@ycoding-ai/schema/identifier"
import type { Effect, Scope } from "effect"
import { Codec } from "./codec"
import { PluginTool } from "./tool"
import { runtime } from "./sdk"

type Callback = (event: any) => unknown
type Stages = {
  readonly agents: number
  readonly commands: number
  readonly references: number
  readonly skills: number
  readonly catalog: number
  readonly context: number
  readonly before: number
  readonly after: number
  readonly integrations: number
}
export type Registration = {
  readonly ready: Promise<void>
  readonly dispose: () => Promise<void>
}
export type Host = {
  readonly parent: boolean
  readonly options: Record<string, unknown>
  readonly call: (operation: string, payload: Codec.Message) => Promise<unknown>
  readonly register: (stage: number, callback: Callback) => Registration
  readonly registerLanguage: (name: string, callback: Callback) => Registration
  readonly addTool: (name: string, tool: PluginTool.AnyTool, options?: PluginTool.RegisterOptions) => Registration
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
  readonly track: <A>(task: Promise<A>) => Promise<A>
  readonly subscribe: (listener: (event: unknown) => void, end: () => void) => () => void
  readonly Stage: Stages
}
export type Definition = {
  readonly id: string
  readonly effect: (contexts: Contexts) => Effect.Effect<void, never, Scope.Scope>
}
type Contexts = { readonly effect: Record<string, unknown>; readonly promise: Record<string, unknown> }

export function definition(value: unknown): Definition {
  const plugin = value as Record<string, unknown> | undefined
  if (plugin && typeof plugin.id === "string" && typeof plugin.effect === "function") {
    const effect = plugin.effect as (context: unknown) => Effect.Effect<void, never, Scope.Scope>
    return { id: plugin.id, effect: (contexts) => effect.call(plugin, contexts.effect) }
  }
  if (plugin && typeof plugin.id === "string" && typeof plugin.setup === "function") {
    const setup = plugin.setup as (context: unknown) => unknown
    return {
      id: plugin.id,
      effect: (contexts) =>
        runtime.Effect.uninterruptible(runtime.Effect.gen(function* () {
          const cleanup = yield* runtime.Effect.promise(() => Promise.resolve(setup.call(plugin, contexts.promise)))
          if (typeof cleanup !== "function") return
          yield* runtime.Effect.addFinalizer(() => runtime.Effect.promise(() => Promise.resolve(cleanup())))
        })),
    }
  }
  throw new Error("Invalid plugin export. Export Plugin.define({ id, setup }) or Plugin.define({ id, effect }).")
}

const unsupported = (name: string) => () =>
  Promise.reject(new Error(`Plugin API ${name} is not supported by this runtime`))

export function make(host: Host): Contexts {
  const stage = host.Stage
  const promiseRegistration = async (registration: Registration) => {
    try { await registration.ready }
    catch (error) {
      try { await registration.dispose() }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Plugin registration and cleanup failed") }
      throw error
    }
    return { dispose: registration.dispose }
  }
  const effectRegistration = (register: () => Registration) =>
    runtime.Effect.acquireRelease(
      runtime.Effect.sync(register),
      (registration) => runtime.Effect.promise(registration.dispose),
    ).pipe(
      runtime.Effect.tap((registration) => runtime.Effect.promise(() => registration.ready)),
      runtime.Effect.map((registration) => ({ dispose: runtime.Effect.promise(registration.dispose) })),
    )
  const batchRegistration = (registrations: Registration[]): Registration => ({
    ready: Promise.all(registrations.map((registration) => registration.ready)).then(() => undefined),
    dispose: () => Promise.all(registrations.map((registration) => registration.dispose())).then(() => undefined),
  })
  const promiseTransform = (stageID: number) => async (callback: (draft: any) => void) =>
    promiseRegistration(host.register(stageID, callback))
  const effectTransform = (stageID: number) => (callback: (draft: any) => void) =>
    effectRegistration(() => host.register(stageID, callback))
  const hookStage = (name: string) => {
    if (name === "execute.before") return stage.before
    if (name === "execute.after") return stage.after
    if (name === "context") return stage.context
    throw new Error(`Unknown plugin hook ${name}`)
  }
  const sdk = {
    mcp: {
      servers: () => host.call("servers", {}),
      tools: () =>
        host.call("tools", {}).then((tools) =>
          (tools as any[]).map((tool) => ({
            server: tool.server,
            name: tool.definition?.name,
            codemode: tool.codemode,
            description: tool.definition?.description,
            inputSchema: tool.definition?.inputSchema,
            outputSchema: tool.definition?.outputSchema,
          })),
        ),
      readResource: (input: { server: string; uri: string }) =>
        host.call("read_resource", { server: input.server, uri: input.uri }).then((value) => value ?? undefined),
      callTool: (input: { server: string; name: string; args?: Record<string, unknown> }) =>
        host
          .call("call_tool", { server: input.server, name: input.name, args: Codec.value(input.args ?? {}) })
          .then((value: any) => ({ server: input.server, tool: input.name, ...value })),
    },
    session: {
      get: (input: { sessionID: string }) => host.call("session_get", { session: input.sessionID }),
      prompt: (input: any) =>
        host.call("session_prompt", {
          session: input.sessionID,
          message: input.id ?? `msg_${ascending()}`,
          input: Codec.value(
            pending("user", input, {
              text: input.text,
              files: input.files,
              agents: input.agents,
              metadata: input.metadata,
            }),
          ),
          resume: input.resume ?? undefined,
        }),
      interrupt: (input: { sessionID: string }) => host.call("session_interrupt", { session: input.sessionID }),
      create: (input: any = {}) => {
        if (!host.parent && input.location !== undefined)
          return Promise.reject(new Error("Plugin sessions are placed in the plugin's own Location"))
        return host.call("session_create", {
          session: input.id ?? undefined,
          parent: input.parentID ?? undefined,
          agent: input.agent === undefined ? undefined : Codec.text(input.agent),
          model: input.model === undefined ? undefined : Codec.value(input.model),
          title: input.title === undefined ? undefined : Codec.text(input.title),
          permission_ceiling: input.permission === undefined ? undefined : Codec.value(input.permission),
          location: input.location === undefined ? undefined : Codec.value(input.location),
        })
      },
      generate: (input: { sessionID: string; prompt: string }) =>
        host.call("session_generate", { session: input.sessionID, prompt: Codec.text(input.prompt) }),
      command: (input: any) =>
        host.call("session_command", {
          session: input.sessionID,
          message: input.id ?? `msg_${ascending()}`,
          command: Codec.text(input.command),
          arguments: Codec.text(input.arguments ?? ""),
          input: Codec.value(
            pending("user", input, {
              text: input.text ?? "",
              files: input.files,
              agents: input.agents,
              metadata: input.metadata,
            }),
          ),
          agent: input.agent === undefined ? undefined : Codec.text(input.agent),
          model: input.model === undefined ? undefined : Codec.value(input.model),
          resume: input.resume ?? undefined,
        }),
      synthetic: (input: any) =>
        host.call("session_synthetic", {
          session: input.sessionID,
          message: input.id ?? `msg_${ascending()}`,
          input: Codec.value(
            pending("synthetic", input, { text: input.text, description: input.description, metadata: input.metadata }),
          ),
          resume: input.resume ?? undefined,
        }),
    },
  }
  const list = (operation: string) => (_input?: any) => host.call(operation, {})
  const reload = (operation: string) => () => host.call(operation, {}).then(() => undefined)
  const reads = (listOperation: string, reloadOperation: string) => ({
    list: list(listOperation),
    reload: reload(reloadOperation),
  })
  const subscribeEvents = (): AsyncIterable<unknown> => {
    const queue: unknown[] = []
    let waiting: ((result: IteratorResult<unknown>) => void) | undefined
    let done = false
    let dispose: (() => void) | undefined
    const finish = () => {
      if (done) return
      done = true
      const parked = waiting
      waiting = undefined
      parked?.({ done: true, value: undefined })
    }
    const start = () => {
      if (dispose || done) return
      dispose = host.subscribe((event) => {
        if (done) return
        if (waiting) {
          const parked = waiting
          waiting = undefined
          parked({ done: false, value: event })
          return
        }
        if (queue.length >= 128) queue.shift()
        queue.push(event)
      }, finish)
    }
    const iterator: AsyncIterator<unknown> = {
      next: () => {
        start()
        const queued = queue.shift()
        if (queued !== undefined) return Promise.resolve({ done: false as const, value: queued })
        if (done) return Promise.resolve({ done: true as const, value: undefined })
        return new Promise((resolve) => {
          waiting = resolve
        })
      },
      return: () => {
        const cancel = dispose
        dispose = undefined
        finish()
        cancel?.()
        return Promise.resolve({ done: true as const, value: undefined })
      },
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }
  const promise = {
    options: host.options,
    agent: {
      list: (input?: any) =>
        host.call("agents_list", {
          directory: input?.location?.directory === undefined ? undefined : Codec.text(input.location.directory),
          workspace: input?.location?.workspace === undefined ? undefined : Codec.text(input.location.workspace),
        }),
      reload: reload("agent_reload"),
      get: (id: string) => host.call("agent_get", { id }).then((value) => value ?? undefined),
      transform: promiseTransform(stage.agents),
    },
    aisdk: {
      hook: async (name: string, callback: Callback) => promiseRegistration(host.registerLanguage(name, callback)),
    },
    catalog: {
      provider: {
        list: list("providers_list"),
        get: (input: any) => host.call("provider_get", { id: typeof input === "string" ? input : input.providerID }),
      },
      model: {
        list: list("models_list"),
        get: (providerID: string, modelID: string) =>
          host.call("model_get", { provider: providerID, model: modelID }).then((value) => value ?? undefined),
        default: (_input?: any) =>
          host.call("model_default", {}).then((result: any) => ({ ...result, data: result?.data ?? null })),
      },
      reload: reload("catalog_reload"),
      transform: promiseTransform(stage.catalog),
    },
    command: { ...reads("commands_list", "command_reload"), transform: promiseTransform(stage.commands) },
    event: { subscribe: subscribeEvents },
    integration: {
      list: list("integrations_list"),
      get: (input: { integrationID: string }) => host.call("integration_get", { id: input.integrationID }),
      reload: unsupported("integration.reload"),
      transform: unsupported("integration.transform"),
      connect: { key: unsupported("integration.connect.key") },
      oauth: {
        connect: unsupported("integration.oauth.connect"),
        status: unsupported("integration.oauth.status"),
        complete: unsupported("integration.oauth.complete"),
        cancel: unsupported("integration.oauth.cancel"),
      },
      command: {
        connect: unsupported("integration.command.connect"),
        status: unsupported("integration.command.status"),
        cancel: unsupported("integration.command.cancel"),
      },
      connection: {
        active: (integrationID: string) =>
          host.call("integration_active", { id: integrationID }).then((value) => value ?? undefined),
        resolve: unsupported("integration.connection.resolve"),
      },
    },
    mcp: sdk.mcp,
    plugin: { list: list("plugins_list") },
    reference: { ...reads("references_list", "reference_reload"), transform: promiseTransform(stage.references) },
    session: {
      ...sdk.session,
      hook: async (name: string, callback: Callback) => promiseRegistration(host.register(hookStage(name), callback)),
    },
    skill: { ...reads("skills_list", "skill_reload"), transform: promiseTransform(stage.skills) },
    tool: {
      transform: async (callback: (draft: any) => void) => {
        const tools: PluginTool.AnyTool[] = []
        callback({ add: (tool: PluginTool.AnyTool) => { tools.push(tool) } })
        return promiseRegistration(batchRegistration(tools.map((tool) => host.addTool(tool.name, PluginTool.fromPromise(tool, host.track), tool.options))))
      },
      hook: async (name: string, callback: Callback) => promiseRegistration(host.register(hookStage(name), callback)),
    },
  }
  if (host.parent) {
    const integration = promise.integration
    Object.assign(integration, {
      reload: reload("integration_reload"),
      transform: promiseTransform(stage.integrations),
      connect: { key: (input: any) => host.call("integration_connect_key", { integration: input.integrationID, key: Codec.text(input.key), label: input.label === undefined ? undefined : Codec.text(input.label) }).then(() => undefined) },
      oauth: {
        connect: (input: any) => host.call("integration_oauth_connect", { integration: input.integrationID, method: input.methodID, inputs: Codec.value(input.inputs ?? {}), label: input.label === undefined ? undefined : Codec.text(input.label) }),
        status: (input: any) => host.call("integration_oauth_status", { integration: input.integrationID, attempt: input.attemptID }),
        complete: (input: any) => host.call("integration_oauth_complete", { integration: input.integrationID, attempt: input.attemptID, code: input.code === undefined ? undefined : Codec.text(input.code) }).then(() => undefined),
        cancel: (input: any) => host.call("integration_oauth_cancel", { integration: input.integrationID, attempt: input.attemptID }).then(() => undefined),
      },
      command: {
        connect: (input: any) => host.call("integration_command_connect", { integration: input.integrationID, method: input.methodID, label: input.label === undefined ? undefined : Codec.text(input.label) }),
        status: (input: any) => host.call("integration_command_status", { integration: input.integrationID, attempt: input.attemptID }),
        cancel: (input: any) => host.call("integration_command_cancel", { integration: input.integrationID, attempt: input.attemptID }).then(() => undefined),
      },
      connection: { ...integration.connection, resolve: (connection: unknown) => host.call("integration_connection_resolve", { connection: Codec.value(connection) }).then((value) => value ?? undefined) },
    })
  }
  const effect = mapEffect(promise) as Record<string, any>
  effect.event = {
    subscribe: () =>
      runtime.Stream.fromAsyncIterable(subscribeEvents(), (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      ),
  }
  effect.tool = {
    transform: (callback: (draft: any) => void) =>
      runtime.Effect.sync(() => {
        callback({
          add: (name: string, tool: PluginTool.AnyTool, options?: PluginTool.RegisterOptions) =>
            host.addTool(name, tool, options),
        })
        return { dispose: runtime.Effect.void }
      }),
    hook: (name: string, callback: (event: any) => Effect.Effect<void>) =>
      effectRegistration(() => host.register(hookStage(name), (event) => host.runEffect(callback(event)))),
  }
  effect.session.hook = (name: string, callback: (event: any) => Effect.Effect<void>) =>
    effectRegistration(() => host.register(hookStage(name), (event) => host.runEffect(callback(event))))
  for (const [domain, stageID] of [
    ["agent", stage.agents],
    ["catalog", stage.catalog],
    ["command", stage.commands],
    ["reference", stage.references],
    ["skill", stage.skills],
  ] as const)
    effect[domain].transform = effectTransform(stageID)
  if (host.parent) {
    effect.integration.transform = effectTransform(stage.integrations)
    effect.tool.transform = (callback: (draft: any) => void) => effectRegistration(() => {
      const tools: Array<{ readonly name: string; readonly tool: PluginTool.AnyTool; readonly options?: PluginTool.RegisterOptions }> = []
      callback({ add: (name: string, tool: PluginTool.AnyTool, options?: PluginTool.RegisterOptions) => { tools.push({ name, tool, options }) } })
      return batchRegistration(tools.map((entry) => host.addTool(entry.name, entry.tool, entry.options)))
    })
  }
  effect.aisdk = {
    hook: (name: string, callback: (event: unknown) => Effect.Effect<void>) =>
      effectRegistration(() => host.registerLanguage(name, (event) => host.runEffect(callback(event)))),
  }
  if (!host.parent) effect.integration.transform = () =>
    runtime.Effect.die(new Error("Plugin API integration.transform is not supported by this runtime"))
  return { effect, promise }
}

function mapEffect(value: unknown): unknown {
  if (typeof value === "function")
    return (...args: unknown[]) => runtime.Effect.promise(() => (value as Function)(...args))
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === "options" ? item : mapEffect(item)]),
  )
}

function pending(type: string, input: any, data: Record<string, unknown>) {
  return {
    type,
    data: Object.fromEntries(Object.entries(data).filter((entry) => entry[1] !== undefined)),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
  }
}

export async function transform(stage: number, draft: any, call: Codec.Message, callbacks: ReadonlyArray<Callback>, oauth?: (registration: Record<string, any>) => void) {
  if (stage === 7) {
    const event = { tool: draft.tool, ...identity(call), input: draft.input }
    for (const callback of callbacks) await callback(event)
    return { tool: draft.tool, input: event.input }
  }
  if (stage === 8) {
    const event = {
      tool: draft.tool,
      ...identity(call),
      input: draft.input,
      result: draft.result,
      output: draft.output,
      ...(draft.outputPaths === undefined ? {} : { outputPaths: draft.outputPaths }),
    }
    for (const callback of callbacks) await callback(event)
    return {
      tool: draft.tool,
      input: draft.input,
      result: event.result,
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(event.outputPaths === undefined ? {} : { outputPaths: event.outputPaths }),
    }
  }
  if (stage === 6) {
    const tools: Record<string, { description: string; input: unknown }> = Object.fromEntries(
      (draft.tools as any[]).map((tool) => [tool.name, { description: tool.description, input: tool.input }]),
    )
    const origins = new Map<unknown, number>()
    const event = {
      sessionID: draft.sessionID,
      agent: draft.agent,
      model: draft.model,
      ...(draft.routeID === undefined ? {} : { routeID: draft.routeID }),
      system: (draft.system as any[]).map((part) => ({ type: "text", ...pluginCache(part) })),
      messages: (draft.messages as any[]).map((message) => {
        const visible = {
          ...(message.id === undefined ? {} : { id: message.id }),
          role: message.role,
          content: (message.content as any[]).map(pluginPart),
          ...(message.volatile ? { volatile: true } : {}),
          ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
          ...(message.native === undefined ? {} : { native: message.native }),
        }
        origins.set(visible, message.origin)
        return visible
      }),
      tools,
    }
    let failures = 0
    for (const callback of callbacks)
      await Promise.resolve()
        .then(() => callback(event))
        .catch(() => {
          failures++
          event.messages.push({
            role: "user",
            content: [{ type: "text", text: "Session context hook failed; its changes may be incomplete." }],
          })
        })
    return {
      sessionID: draft.sessionID,
      agent: draft.agent,
      model: draft.model,
      ...(draft.routeID === undefined ? {} : { routeID: draft.routeID }),
      system: event.system.map((part: any) => {
        const { type, ...value } = part
        return wireCache(value)
      }),
      messages: event.messages.map((message: any) => ({
        ...(origins.has(message) ? { origin: origins.get(message) } : {}),
        id: message.id,
        role: message.role,
        content: Array.isArray(message.content) ? message.content.map(wirePart) : message.content,
        volatile: message.volatile ?? false,
        metadata: message.metadata,
        native: message.native,
      })),
      tools: Object.entries(event.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        input: tool.input,
      })),
      ...(failures === 0 ? {} : { failures }),
    }
  }
  const items = draft.items as any[]
  const state = { items: items.map((item) => item), default: draft.default }
  const domain = domainDraft(stage, state, oauth)
  for (const callback of callbacks) await callback(domain)
  return stage === 5
    ? { items: state.items, ...(state.default === undefined ? {} : { default: state.default }) }
    : stage === 1
      ? { items: state.items, ...(state.default === undefined ? {} : { default: state.default }) }
      : { items: state.items }
}

function pluginPart(part: any) {
  if (part.type !== "media") return { type: part.type, ...pluginCache(part.value) }
  return {
    type: "media",
    mediaType: part.value.mime,
    data: part.value.bytes ? new Uint8Array(Buffer.from(part.value.data, "base64")) : part.value.data,
    ...(part.value.filename === undefined ? {} : { filename: part.value.filename }),
  }
}

function wirePart(part: any) {
  if (part?.type !== "media") {
    const { type, ...value } = part
    return { type, value: wireCache(value) }
  }
  const bytes = part.data instanceof Uint8Array
  return {
    type: "media",
    value: {
      mime: part.mediaType,
      data: bytes ? Buffer.from(part.data).toString("base64") : part.data,
      bytes,
      filename: part.filename,
    },
  }
}

function pluginCache(value: any) {
  if (value?.cache === undefined) return value
  return {
    ...value,
    cache: { type: value.cache.type, ...(value.cache.ttl === undefined ? {} : { ttlSeconds: value.cache.ttl }) },
  }
}

function wireCache(value: any) {
  if (value?.cache === undefined) return value
  return {
    ...value,
    cache: { type: value.cache.type, ...(value.cache.ttlSeconds === undefined ? {} : { ttl: value.cache.ttlSeconds }) },
  }
}

function identity(call: Codec.Message) {
  return {
    sessionID: call.session_id,
    agent: call.agent,
    messageID: call.message_id,
    callID: Codec.readText(call.call_id),
  }
}

function domainDraft(stage: number, state: { items: any[]; default: any }, oauth?: (registration: Record<string, any>) => void) {
  const keyed = (key: string) => ({
    list: () => state.items,
    get: (id: string) => state.items.find((item) => item[key] === id),
    update: (id: string, update: (item: any) => void) => {
      const existing = state.items.find((item) => item[key] === id)
      if (existing) return update(existing)
      const created = { [key]: id }
      update(created)
      state.items.push(created)
    },
    remove: (id: string) => {
      state.items = state.items.filter((item) => item[key] !== id)
    },
  })
  if (stage === 1)
    return {
      ...keyed("id"),
      default: (id: string | undefined) => {
        state.default = id
      },
    }
  if (stage === 2) return keyed("name")
  if (stage === 10) {
    const methods = (id: string) => {
      const item = state.items.find((item) => item.id === id)
      if (!item) throw new Error(`Unknown integration ${id}`)
      return item.methods ??= []
    }
    const same = (a: any, b: any) => a.type === b.type && (a.type === "oauth" || a.type === "command" ? a.id === b.id : a.type !== "env" || JSON.stringify(a.names) === JSON.stringify(b.names))
    return {
      ...keyed("id"),
      method: {
        list: (id: string) => methods(id),
        remove: (id: string, method: any) => { const list = methods(id); const index = list.findIndex((item: any) => same(item, method)); if (index >= 0) list.splice(index, 1) },
        update: (registration: Record<string, any>) => {
          const list = methods(registration.integrationID)
          const index = list.findIndex((item: any) => same(item, registration.method))
          if (index < 0) list.push(registration.method)
          else list[index] = registration.method
          if (registration.method.type === "oauth") oauth?.(registration)
        },
      },
    }
  }
  if (stage === 3)
    return {
      add: (name: string, source: Record<string, unknown>) => {
        state.items = [...state.items.filter((item) => item.name !== name), { ...source, name }]
      },
      remove: (name: string) => {
        state.items = state.items.filter((item) => item.name !== name)
      },
      list: () => state.items.map((item) => [item.name, item] as const),
    }
  if (stage === 4)
    return {
      source: (source: unknown) => {
        state.items.push(source)
      },
      list: () => state.items,
    }
  const record = (providerID: string) => state.items.find((item) => item.provider?.id === providerID)
  return {
    provider: {
      list: () =>
        state.items.map((item) => ({
          provider: item.provider,
          models: new Map(item.models.map((model: any) => [model.id, model])),
        })),
      get: (providerID: string) => {
        const item = record(providerID)
        return item && { provider: item.provider, models: new Map(item.models.map((model: any) => [model.id, model])) }
      },
      update: (providerID: string, update: (provider: any) => void) => {
        const item = record(providerID)
        if (item) return update(item.provider)
        const provider = { id: providerID }
        update(provider)
        state.items.push({ provider, models: [], environment: [] })
      },
      remove: (providerID: string) => {
        state.items = state.items.filter((item) => item.provider?.id !== providerID)
      },
    },
    model: {
      get: (providerID: string, modelID: string) =>
        record(providerID)?.models.find((model: any) => model.id === modelID),
      update: (providerID: string, modelID: string, update: (model: any) => void) => {
        const item = record(providerID)
        if (!item) throw new Error(`Unknown provider ${providerID}`)
        const existing = item.models.find((model: any) => model.id === modelID)
        if (existing) return update(existing)
        const model = { id: modelID, providerID }
        update(model)
        item.models.push(model)
      },
      remove: (providerID: string, modelID: string) => {
        const item = record(providerID)
        if (item) item.models = item.models.filter((model: any) => model.id !== modelID)
      },
      default: {
        get: () =>
          state.default && {
            providerID: state.default.providerID,
            modelID: state.default.id,
            ...(state.default.variant === undefined ? {} : { variant: state.default.variant }),
            ...(state.default.profile === undefined ? {} : { profile: state.default.profile }),
          },
        set: (providerID: string, modelID: string, selection?: { variant?: string; profile?: string }) => {
          state.default = { providerID, id: modelID, ...(selection ?? {}) }
        },
      },
    },
  }
}
