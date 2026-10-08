import { createStore } from "solid-js/store"
import { dedupeWith } from "effect/Array"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, createSignal } from "solid-js"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { RGBA } from "@opentui/core"
import { rm } from "fs/promises"
import { readJson } from "../util/persistence"
import { errorMessage } from "../util/error"
import { modelVariantIDs, parse } from "../util/model"
import { useClient } from "./client"
import {
  createModelPreferenceRepository,
  cycleModelVariant,
  modelPreferenceKey,
  type ModelPreference,
  type ModelPreferenceModel,
} from "../model-preference"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { useData } from "./data"
import { useLocation } from "./location"

export function recentModels(model: ModelPreferenceModel, recent: ModelPreferenceModel[]) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = modelPreferenceKey(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID, ...(item.profile === undefined ? {} : { profile: item.profile }) }))
}

export const {
  use: useLocal,
  provider: LocalProvider,
  context: LocalContext,
} = createSimpleContext({
  name: "Local",
  init: () => {
    const data = useData()
    const client = useClient()
    const toast = useToast()
    const { theme, mode } = useTheme()
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const location = useLocation()
    const activeLocation = () => location.current ?? data.location.default()

    function isModelValid(model: ModelPreferenceModel) {
      const info = data.location.model
        .list(activeLocation())
        ?.find((item) => item.providerID === model.providerID && item.id === model.modelID)
      if (!info) return false
      if (model.profile !== undefined) return info.profiles?.some((profile) => profile.name === model.profile) === true
      return info.enabled
    }

    function getFirstValidModel(...modelFns: (() => (ModelPreferenceModel & { variant?: string }) | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (model.profile !== undefined || isModelValid(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(() =>
        (data.location.agent.list(activeLocation()) ?? []).filter(
          (agent) => agent.mode !== "subagent" && !agent.hidden && agent.id !== "btw",
        ),
      )
      const visibleAgents = createMemo(() =>
        (data.location.agent.list(activeLocation()) ?? []).filter((agent) => !agent.hidden),
      )
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => {
        const step = mode() === "light" ? 800 : 200
        return dedupeWith(
          theme.categorical.map((scale) => scale[step]),
          (first, second) => first.equals(second),
        )
      })
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((agent) => agent.id === agentStore.current) ?? agents().at(0)
        },
        set(id: string) {
          if (!agents().some((agent) => agent.id === id))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${id}`,
              duration: 3000,
            })
          setAgentStore("current", id)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((agent) => agent.id === current.id) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.id)
          })
        },
        color(id: string) {
          const index = visibleAgents().findIndex((agent) => agent.id === id)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            if (color === "primary") return theme.text.action.primary.selected
            if (color === "secondary") return theme.categorical[0][mode() === "light" ? 800 : 200]
            if (color === "accent") return theme.hue.accent[mode() === "light" ? 800 : 200]
            if (color === "success") return theme.text.feedback.success.default
            if (color === "warning") return theme.text.feedback.warning.default
            if (color === "error") return theme.text.feedback.error.default
            if (color === "info") return theme.text.feedback.info.default
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<
        ModelPreference & {
          ready: boolean
          model: Record<string, ModelPreferenceModel>
        }
      >({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const repository = createModelPreferenceRepository(path.join(paths.state, "model.json"))
      const state = {
        pending: false,
      }
      // Existing Sessions keep desired model choices local until their next prompt can switch and
      // admit atomically. The target is Session-scoped so navigation cannot retarget another draft.
      const [pendingTargets, setPendingTargets] = createSignal<
        Record<string, ModelPreferenceModel & { variant?: string }>
      >({})
      const clearPendingTarget = (sessionID: string) =>
        setPendingTargets((current) => {
          if (!(sessionID in current)) return current
          const next = { ...current }
          delete next[sessionID]
          return next
        })

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void repository
          .patch({
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            variant: modelStore.variant,
          })
          .catch(() => undefined)
      }

      repository
        .load()
        .then((value) => {
          setModelStore("recent", value.recent)
          setModelStore("favorite", value.favorite)
          setModelStore("variant", value.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const model = parse(args.model)
          if (model && isModelValid(model)) return model
        }

        const recent = modelStore.recent.find((item) => item.profile !== undefined || isModelValid(item))
        if (recent) return recent
        const configured = data.location.model.default(activeLocation())
        return configured && {
          providerID: configured.providerID,
          modelID: configured.id,
          ...(configured.profile === undefined ? {} : { profile: configured.profile }),
          ...(configured.variant === undefined ? {} : { variant: configured.variant }),
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.id],
            () => a?.model && {
              providerID: a.model.providerID,
              modelID: a.model.id,
              ...(a.model.profile === undefined ? {} : { profile: a.model.profile }),
              ...(a.model.variant === undefined ? {} : { variant: a.model.variant }),
            },
            fallbackModel,
          ) ?? undefined
        )
      })

      const selection = () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        const pending = sessionID ? pendingTargets()[sessionID] : undefined
        if (pending) return pending
        const saved = sessionID ? data.session.get(sessionID)?.model : undefined
        if (saved) return { providerID: saved.providerID, modelID: saved.id, variant: saved.variant, ...(saved.profile === undefined ? {} : { profile: saved.profile }) }
        const configured = agent.current()?.model
        const value = sessionID
          ? getFirstValidModel(
              () => configured && {
                providerID: configured.providerID,
                modelID: configured.id,
                ...(configured.profile === undefined ? {} : { profile: configured.profile }),
                ...(configured.variant === undefined ? {} : { variant: configured.variant }),
              },
              fallbackModel,
            )
          : currentModel()
        if (!value) return undefined
        return { ...value, variant: modelStore.variant[modelPreferenceKey(value)] ?? value.variant }
      }
      const selectedModel = () => {
        const value = selection()
        return value && { providerID: value.providerID, modelID: value.modelID, ...(value.profile === undefined ? {} : { profile: value.profile }) }
      }

      event.on("session.deleted", (evt) => clearPendingTarget(evt.data.sessionID))

      return {
        current: selectedModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        pendingTarget(sessionID: string | undefined) {
          return sessionID ? pendingTargets()[sessionID] : undefined
        },
        async select(
          input: ModelPreferenceModel & { variant?: string },
          options?: { sessionID?: string },
        ) {
          const target = { providerID: input.providerID, modelID: input.modelID }
          const info = data.location.model
            .list(activeLocation())
            ?.find((item) => item.providerID === target.providerID && item.id === target.modelID)
          if (!info) {
            toast.show({
              message: `Model ${target.providerID}/${target.modelID} is not valid`,
              variant: "warning",
              duration: 3000,
            })
            return
          }
          const prior = selection()
          const sameProvider = prior?.providerID === target.providerID
          const sameModel = sameProvider && prior.modelID === target.modelID
          const profileExplicit = "profile" in input
          const profile = profileExplicit
            ? input.profile
            : sameProvider && prior.profile !== undefined
              ? prior.profile
              : undefined
          const profileAvailable =
            profile === undefined
              ? info.enabled
              : info.profiles?.some((item) => item.name === profile) === true
          if (!profileAvailable && !(profile !== undefined && sameProvider && prior?.profile === profile)) {
            toast.show({
              message: profile === undefined
                ? `Model ${target.providerID}/${target.modelID} is unavailable for the provider default`
                : `Profile ${profile} is unavailable for ${target.providerID}/${target.modelID}`,
              variant: "warning",
              duration: 3000,
            })
            return
          }
          const explicit = "variant" in input
          const requested = input.variant
          if (explicit && requested !== undefined && !modelVariantIDs({ model: info, profile }).includes(requested)) {
            toast.show({
              message: `Variant ${requested} is not available for ${target.providerID}/${target.modelID}`,
              variant: "warning",
              duration: 3000,
            })
            return
          }
          const sameSelection = sameModel && prior.profile === profile
          const remembered =
            sameSelection
              ? prior.variant
              : modelStore.variant[modelPreferenceKey({ ...target, ...(profile === undefined ? {} : { profile }) })]
          const variant = explicit ? requested : remembered
          if (prior) {
            setModelStore("variant", modelPreferenceKey(prior), prior.variant)
          }
          const desired = { ...target, ...(profile === undefined ? {} : { profile }), ...(variant === undefined ? {} : { variant }) }
          setModelStore("variant", modelPreferenceKey(desired), variant)
          const sessionID = options?.sessionID
          if (!sessionID) {
            // The home screen only records the next-Session preference; no Session API call.
            this.set(desired, { recent: true })
            return
          }
          setPendingTargets((current) => ({ ...current, [sessionID]: desired }))
          save()
        },
        commitPending(sessionID: string, model: { providerID: string; id: string; variant?: string; profile?: string }) {
          const pending = pendingTargets()[sessionID]
          if (!pending) return
          if (pending.providerID !== model.providerID || pending.modelID !== model.id) return
          if (pending.variant !== model.variant) return
          if (pending.profile !== model.profile) return
          setModelStore("recent", recentModels(pending, modelStore.recent))
          save()
          clearPendingTarget(sessionID)
        },
        parsed: createMemo(() => {
          const value = selectedModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = data.location.provider.list(activeLocation())?.find((item) => item.id === value.providerID)
          const info = data.location.model
            .list(activeLocation())
            ?.find((item) => item.providerID === value.providerID && item.id === value.modelID)
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: modelVariantIDs({ model: info, profile: value.profile }).length !== 0,
          }
        }),
        cycle(direction: 1 | -1) {
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          // Rapid cycling follows the latest desired target, not the last committed preference.
          const current = selectedModel()
          if (!current) return Promise.resolve()
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return Promise.resolve()
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return Promise.resolve()
          if (!agent.current()) return Promise.resolve()
          return this.select(val, { sessionID })
        },
        cycleFavorite(direction: 1 | -1) {
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return Promise.resolve()
          }
          // Rapid cycling follows the latest desired target, not the last committed preference.
          const current = selectedModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return Promise.resolve()
          if (!agent.current()) return Promise.resolve()
          return this.select(next, { sessionID })
        },
        set(model: ModelPreferenceModel & { variant?: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            setModelStore("model", a.id, { providerID: model.providerID, modelID: model.modelID, ...(model.profile === undefined ? {} : { profile: model.profile }) })
            if (model.variant !== undefined) setModelStore("variant", modelPreferenceKey(model), model.variant)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: ModelPreferenceModel) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const key = modelPreferenceKey(model)
            const exists = modelStore.favorite.some((item) => modelPreferenceKey(item) === key)
            const next = exists
              ? modelStore.favorite.filter((item) => modelPreferenceKey(item) !== key)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((item) => ({ providerID: item.providerID, modelID: item.modelID, ...(item.profile === undefined ? {} : { profile: item.profile }) })),
            )
            save()
          })
        },
        variant: {
          selected() {
            return selection()?.variant
          },
          current(model?: ModelPreferenceModel) {
            if (!model) return this.selected()
            const selected = selection()
            if (selected?.providerID === model.providerID && selected.modelID === model.modelID && selected.profile === model.profile)
              return selected.variant
            return modelStore.variant[modelPreferenceKey(model)]
          },
          list() {
            const m = selectedModel()
            if (!m) return []
            const info = data.location.model
              .list(activeLocation())
              ?.find((item) => item.providerID === m.providerID && item.id === m.modelID)
            return [...modelVariantIDs({ model: info, profile: m.profile })]
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return Promise.resolve()
            const m = selectedModel()
            if (!m) return Promise.resolve()
            const next = cycleModelVariant(this.current(), variants)
            const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
            return model.select({ ...m, variant: next }, { sessionID })
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const pinned = createMemo(() =>
        data.session
          .list()
          .filter((x) => x.parentID === undefined && x.time.pinned !== undefined)
          .toSorted((a, b) => a.time.pinned! - b.time.pinned! || a.id.localeCompare(b.id))
          .map((x) => x.id),
      )
      const slots = createMemo(() => pinned().slice(0, 9))

      const legacyPins = path.join(paths.state, "session.json")
      void readJson<unknown>(legacyPins)
        .then(async (value) => {
          const stored: unknown = value && typeof value === "object" ? Reflect.get(value, "pinned") : undefined
          const ids = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []
          let complete = true
          for (const sessionID of ids) {
            const imported = await client.api.session.pin({ sessionID }).then(
              () => true,
              (error: unknown) =>
                typeof error === "object" && error !== null && Reflect.get(error, "_tag") === "SessionNotFoundError",
            )
            complete = complete && imported
          }
          if (complete) await rm(legacyPins, { force: true })
        })
        .catch(() => {})

      return {
        pinned,
        slots,
        togglePin(sessionID: string) {
          const request =
            data.session.get(sessionID)?.time.pinned === undefined
              ? client.api.session.pin({ sessionID })
              : client.api.session.unpin({ sessionID })
          void request.catch((error) => {
            toast.show({
              message: `Failed to update pin: ${errorMessage(error)}`,
              variant: "error",
              duration: 5000,
            })
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid({ providerID: value.model.providerID, modelID: value.model.id, ...(value.model.profile === undefined ? {} : { profile: value.model.profile }) })) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.id}'s configured model ${value.model.providerID}/${value.model.id} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      session,
    }
    return result
  },
})
