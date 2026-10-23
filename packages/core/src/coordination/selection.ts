export * as CoordinationDispatchSelection from "./selection"

import type { Coordination } from "@ycoding-ai/schema/coordination"
import type { Session } from "@ycoding-ai/schema/session"
import { eq } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Database } from "../database/database"
import { Node, makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import type { Location } from "../location"
import type { CatalogModel } from "../model"
import { AbsolutePath } from "../schema"
import { SessionTable } from "../session/sql"

export class InvalidSelectionError extends Schema.TaggedErrorClass<InvalidSelectionError>()(
  "Coordination.InvalidSelectionError",
  { message: Schema.String },
) {}

export function check(input: {
  readonly agent: Agent.Info | undefined
  readonly model: CatalogModel.Info | undefined
  readonly selection: Coordination.DispatchSelection
}): string | undefined {
  if (!input.agent) return `Coordination dispatch agent ${input.selection.agent} is not configured`
  if (input.agent.hidden || input.agent.id === "btw")
    return `Coordination dispatch agent ${input.selection.agent} is not selectable`
  if (!input.model)
    return `Coordination dispatch model ${input.selection.model.providerID}/${input.selection.model.id} is not configured`
  if (!input.model.enabled)
    return `Coordination dispatch model ${input.selection.model.providerID}/${input.selection.model.id} is not enabled`
  const profile =
    input.selection.model.profile === undefined
      ? undefined
      : input.model.profiles?.find((entry) => entry.name === input.selection.model.profile)
  if (input.selection.model.profile !== undefined && input.model.profiles !== undefined && profile === undefined)
    return `Coordination dispatch model profile ${input.selection.model.profile} is not advertised`
  const advertised = profile?.variants ?? input.model.variants.map((variant) => variant.id)
  if (advertised.length === 0) {
    if (input.selection.model.variant !== undefined)
      return `Coordination dispatch model ${input.selection.model.id} advertises no variants; omit the variant`
    return undefined
  }
  if (input.selection.model.variant === undefined)
    return `Coordination dispatch model ${input.selection.model.id} requires an explicit advertised variant`
  if (!advertised.includes(input.selection.model.variant))
    return `Coordination dispatch variant ${input.selection.model.variant} is not advertised for model ${input.selection.model.id}`
  return undefined
}

export function make(options: {
  readonly db: Database.Interface["db"]
  readonly locations: { readonly get: (location: Location.Ref) => Layer.Layer<Agent.Service | Catalog.Service> }
}): Interface {
  return {
    validate: Effect.fn("CoordinationDispatchSelection.validate")(function* (
      targetSessionID: Session.ID,
      selection: Coordination.DispatchSelection,
    ) {
      const row = yield* options.db
        .select({ directory: SessionTable.directory, workspace_id: SessionTable.workspace_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, targetSessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row)
        return yield* new InvalidSelectionError({ message: `Coordination dispatch target Session ${targetSessionID} does not exist` })
      const location = {
        directory: AbsolutePath.make(row.directory),
        ...(row.workspace_id === null ? {} : { workspaceID: row.workspace_id }),
      }
      const problem = yield* Effect.gen(function* () {
        const agents = yield* Agent.Service
        const catalog = yield* Catalog.Service
        const agent = yield* agents.get(selection.agent)
        const model = yield* catalog.model.get(selection.model.providerID, selection.model.id, selection.model.profile)
        return check({ agent, model, selection })
      }).pipe(
        Effect.provide(options.locations.get(location)),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.succeed("Coordination dispatch selection could not be validated at the target Location"),
        ),
      )
      if (problem !== undefined) return yield* new InvalidSelectionError({ message: problem })
    }),
  }
}

export interface Interface {
  readonly validate: (
    targetSessionID: Session.ID,
    selection: Coordination.DispatchSelection,
  ) => Effect.Effect<void, InvalidSelectionError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/CoordinationDispatchSelection") {}

export const layerWith = (validate: Interface["validate"]) => Layer.succeed(Service, Service.of({ validate }))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const locations = yield* LocationServiceMap.Service
    return Service.of(make({ db: database.db, locations }))
  }),
)

export const node: Node.GlobalNode<Service> = makeGlobalNode({ service: Service, layer, deps: [Database.node, LocationServiceMap.node] })
