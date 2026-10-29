import { NodeServices } from "@effect/platform-node"
import { createCcaAuthorization, type CcaAuthorization } from "@ycoding-ai/core/cca/authorization"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Context, Effect, Layer, Scope } from "effect"
import path from "node:path"
import { accountHash } from "./state"
import type {
  CcaProofJournalObserver,
  CcaProofJournalRecordInput,
} from "./cca-proof-journal"

export interface CcaTaskRuntimeCredentialPin {
  readonly profile: string
  readonly accountID: string
  readonly accountHash: string
  readonly credentialID: string
  readonly accountGeneration: number
  readonly key: string
}

export interface CreateCcaTaskRuntimeInput {
  readonly root: string
  readonly credentialPin: CcaTaskRuntimeCredentialPin
  readonly global?: Partial<Global.Interface>
  readonly databasePath?: string
  readonly timeoutMs?: number
  readonly onPhase?: CcaProofJournalObserver
}

export interface CcaTaskRuntime {
  readonly sessionID: Session.ID
  readonly location: Location.Ref
  readonly authorization: CcaAuthorization
  readonly close: () => Promise<void>
}

export class CcaTaskRuntimeUnavailableError extends Error {
  constructor() {
    super("CCA task runtime unavailable")
    this.name = "CcaTaskRuntimeUnavailableError"
  }
}

export class CcaTaskRuntimeCloseError extends Error {
  constructor() {
    super("CCA task runtime cleanup failed")
    this.name = "CcaTaskRuntimeCloseError"
  }
}

export function composeCcaTaskCleanup(input: {
  readonly closeExecutor: () => Promise<void>
  readonly runtime: Pick<CcaTaskRuntime, "close">
  readonly onPhase?: CcaProofJournalObserver
}): () => Promise<void> {
  let closing: Promise<void> | undefined
  return () =>
    (closing ??= (async () => {
      let failed = false
      let observerFailed = false
      const observe = (record: CcaProofJournalRecordInput) => {
        try {
          input.onPhase?.(record)
        } catch {
          observerFailed = true
        }
      }
      observe({ phase: "executor-close", event: "started" })
      let executorFailed = false
      try {
        await input.closeExecutor()
      } catch {
        executorFailed = true
      }
      observe({ phase: "executor-close", event: executorFailed ? "failed" : "completed" })
      if (executorFailed) failed = true
      try {
        await input.runtime.close()
      } catch {
        failed = true
      }
      if (observerFailed) failed = true
      if (failed) throw new CcaTaskRuntimeCloseError()
    })())
}

interface ReadyHandle {
  readonly sessionID: Session.ID
  readonly location: Location.Ref
  readonly authorization: CcaAuthorization
}

export async function createCcaTaskRuntime(input: CreateCcaTaskRuntimeInput): Promise<CcaTaskRuntime> {
  let observerFailed = false
  const observe = (record: CcaProofJournalRecordInput) => {
    try {
      input.onPhase?.(record)
    } catch {
      observerFailed = true
    }
  }
  const root = path.resolve(input.root)
  const initialLocation = Location.Ref.make({ directory: AbsolutePath.make(root) })
  const services = AppNodeBuilder.build(
    LayerNode.group([Credential.node, Session.node, LocationServiceMap.node, EventRuntime.node]),
    [
      [
        Global.node,
        Global.layerWith(
          input.global ?? (process.env.YCODING_CONFIG_DIR ? { config: process.env.YCODING_CONFIG_DIR } : {}),
        ),
      ],
      [Database.node, Database.configured({ path: input.databasePath ?? process.env.YCODING_DB })],
    ],
  )

  let readySettled = false
  let resolveReady!: (handle: ReadyHandle) => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<ReadyHandle>((resolve, reject) => {
    resolveReady = (handle) => {
      if (readySettled) return
      readySettled = true
      resolve(handle)
    }
    rejectReady = (error) => {
      if (readySettled) return
      readySettled = true
      reject(error)
    }
  })
  let releaseShutdown!: () => void
  const shutdown = new Promise<void>((resolve) => {
    releaseShutdown = resolve
  })

  const program = Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const context = yield* Layer.buildWithScope(services, scope)
      const sessions = Context.get(context, Session.Service)
      const credentials = Context.get(context, Credential.Service)
      const locations = Context.get(context, LocationServiceMap.Service)
      const events = Context.get(context, EventRuntime.Service)
      const session = yield* sessions.create({ location: initialLocation, title: "CCA task proof" })

      const assertCurrent = (candidateSessionID: Session.ID) =>
        Effect.gen(function* () {
          if (candidateSessionID !== session.id)
            return yield* Effect.fail(new Error("CCA session is not current"))
          const current = yield* sessions.get(candidateSessionID)
          if (
            current.time.archived !== undefined ||
            path.resolve(current.location.directory) !== path.resolve(session.location.directory) ||
            current.location.workspaceID !== session.location.workspaceID
          ) {
            return yield* Effect.fail(new Error("CCA session is not current"))
          }
          const resolved = yield* RemoteControlCredential.resolveStored(credentials, input.credentialPin.profile)
          if (
            resolved === undefined ||
            resolved.key !== input.credentialPin.key ||
            resolved.credentialID !== input.credentialPin.credentialID ||
            resolved.accountGeneration !== input.credentialPin.accountGeneration ||
            resolved.accountID !== input.credentialPin.accountID ||
            accountHash(resolved.accountID) !== input.credentialPin.accountHash
          ) {
            return yield* Effect.fail(new Error("CCA credential is not current"))
          }
        })

      const setup = Effect.gen(function* () {
        const locationContext = yield* locations.contextEffect(session.location, [
          Permission.node,
          SessionGuardrail.node,
          PluginSupervisor.node,
        ])
        const permission = Context.get(locationContext, Permission.Service)
        const guardrail = Context.get(locationContext, SessionGuardrail.Service)
        yield* Context.get(locationContext, PluginSupervisor.Service).flush
        yield* assertCurrent(session.id)
        return createCcaAuthorization({
          sessionID: session.id,
          permission,
          guardrail,
          events,
          assertCurrent,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        })
      })
      const authorization = yield* setup.pipe(
        Effect.onError(() => sessions.remove(session.id).pipe(Effect.ignore)),
      )
      resolveReady({ sessionID: session.id, location: session.location, authorization })
      yield* Effect.promise(() => shutdown)
    }),
  ).pipe(Effect.provide(NodeServices.layer))

  const finished = Effect.runPromise(program)
  void finished.then(
    () => rejectReady(new CcaTaskRuntimeUnavailableError()),
    () => rejectReady(new CcaTaskRuntimeUnavailableError()),
  )

  let handle: ReadyHandle
  try {
    handle = await ready
  } catch {
    releaseShutdown()
    await finished.catch(() => {})
    throw new CcaTaskRuntimeUnavailableError()
  }

  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      let failed = false
      observe({ phase: "authorization-release", event: "started" })
      try {
        await handle.authorization.close()
        observe({ phase: "authorization-release", event: "completed" })
      } catch {
        failed = true
        observe({ phase: "authorization-release", event: "failed" })
      } finally {
        observe({ phase: "runtime-graph-close", event: "started" })
        releaseShutdown()
      }
      try {
        await finished
        observe({ phase: "runtime-graph-close", event: "completed" })
      } catch {
        failed = true
        observe({ phase: "runtime-graph-close", event: "failed" })
      }
      if (observerFailed) failed = true
      if (failed) throw new CcaTaskRuntimeCloseError()
    })())

  return {
    sessionID: handle.sessionID,
    location: handle.location,
    authorization: handle.authorization,
    close,
  }
}
