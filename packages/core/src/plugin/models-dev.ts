import { define } from "./catalog-host"
import { Effect, Stream } from "effect"
import { EventRuntime } from "../event"
import { ModelsDev } from "../models-dev"
import { Catalog } from "../catalog"
import { Integration } from "../integration"

export const registerModelsDev = (catalog: Catalog.Interface, integrations: Pick<Integration.Interface, "transform" | "reload">, modelsDev: Pick<ModelsDev.Interface, "get">) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const loaded = { data: yield* modelsDev.get() }
    yield* integrations.transform((integrations) => {
      for (const provider of loaded.data) {
        if (provider.environment.length === 0) continue
        const integrationID = Integration.ID.make(provider.info.id)
        integrations.update(integrationID, (integration) => (integration.name = provider.info.name))
        integrations.method.update({
          integrationID,
          method: { type: "key" },
        })
        integrations.method.update({
          integrationID,
          method: { type: "env", names: [...provider.environment] },
        })
      }
    })
    yield* catalog.transform((catalog) => {
      for (const provider of loaded.data) {
        catalog.provider.update(provider.info.id, (draft) => {
          Object.assign(draft, provider.info)
          draft.integrationID = Integration.ID.make(provider.info.id)
        })
        for (const model of provider.models) {
          catalog.model.update(provider.info.id, model.id, (draft) => Object.assign(draft, model))
        }
      }
    })
    yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() =>
        modelsDev.get().pipe(
          Effect.tap((data) => Effect.sync(() => (loaded.data = data))),
          Effect.andThen(integrations.reload()),
          Effect.andThen(catalog.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })

export const ModelsDevPlugin = define({
  id: "ycoding.models-dev",
  effect: Effect.fn(function* () {
    yield* registerModelsDev(yield* Catalog.Service, yield* Integration.Service, yield* ModelsDev.Service)
  }),
})
