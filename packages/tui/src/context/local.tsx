import { createStore } from "solid-js/store"
import { dedupeWith } from "effect/Array"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, createSignal } from "solid-js"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useClient } from "./client"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import {
  createModelPreferenceRepository,
  cycleModelVariant,
  modelPreferenceKey,
  normalizeModelVariant,
  type ModelPreference,
  type ModelPreferenceModel,
} from "../model-preference"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { useData } from "./data"
import { useLocation } from "./location"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

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
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

export const { use: useLocal, provider: LocalProvider, context: LocalContext } = createSimpleContext({
  name: "Local",
  init: () => {
    const data = useData()
    const client = useClient()
    const toast = useToast()
    const { theme, themeV2, mode } = useTheme()
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const location = useLocation()
    const activeLocation = () => location.current ?? data.location.default()

    function isModelValid(model: ModelPreferenceModel) {
      return !!data.location.model
        .list(activeLocation())
        ?.some((item) => item.providerID === model.providerID && item.id === model.modelID)
    }

    function getFirstValidModel(...modelFns: (() => ModelPreferenceModel | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
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
          themeV2.categorical.map((scale) => scale[step]),
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
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
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
      // Explicit selections serialize per Session. The desired target is reactive so the header can
      // show switching progress without claiming a not-yet-committed model is active.
      const selections = new Map<string, { desired: ModelPreferenceModel & { variant?: string }; promise: Promise<void> }>()
      const [pendingTargets, setPendingTargets] = createSignal<Record<string, ModelPreferenceModel & { variant?: string }>>({})
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
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const model = data.location.model.list(activeLocation())?.[0]
        if (!model) return undefined
        return {
          providerID: model.providerID,
          modelID: model.id,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.id],
            () => a?.model && { providerID: a.model.providerID, modelID: a.model.id },
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        pending(sessionID: string) {
          return selections.get(sessionID)
        },
        /** The reactive desired target for a Session, so progress can render while switching. */
        pendingTarget(sessionID: string | undefined) {
          return sessionID ? pendingTargets()[sessionID] : undefined
        },
        async select(
          input: { providerID: string; modelID: string; variant?: string },
          options?: { sessionID?: string },
        ) {
          const target = { providerID: input.providerID, modelID: input.modelID }
          const variant = normalizeModelVariant(input.variant)
          if (!isModelValid(target)) {
            toast.show({
              message: `Model ${target.providerID}/${target.modelID} is not valid`,
              variant: "warning",
              duration: 3000,
            })
            return
          }
          const sessionID = options?.sessionID
          if (!sessionID) {
            // The home screen only records the next-Session preference; no Session API call.
            this.set(target, { recent: true })
            this.variant.set(variant)
            return
          }
          // Capture the agent identity now: an agent switch in this Session while the request is in
          // flight must not apply the completed switch to the newly selected agent's preference.
          const agentID = agent.current()?.id
          if (!agentID) return
          const desired = { ...target, ...(variant === undefined ? {} : { variant }) }
          const previous = selections.get(sessionID)?.promise ?? Promise.resolve()
          const promise = previous
            .catch(() => undefined)
            .then(async () => {
              await client.api.session.switchModel({
                sessionID,
                model: { providerID: target.providerID, id: target.modelID, ...(variant === undefined ? {} : { variant }) },
              })
              if (selections.get(sessionID)?.promise !== promise) return
              // A switch the user navigated away from still applies durably, but it must not
              // overwrite the preference of whichever Session is on screen now.
              if (route.data.type !== "session" || route.data.sessionID !== sessionID) return
              if (agent.current()?.id !== agentID) return
              this.set(target, { recent: true })
              // The variant is part of the durable selection even when it normalizes to the default,
              // so omitting it must clear a stored variant instead of leaving the old one to be
              // captured by the next submission.
              this.variant.set(variant)
            })
            .finally(() => {
              // A newer selection may already have replaced this entry and raised its own desired
              // target. Only this request's own reservation may clear it, or settling the first of
              // several rapid choices would erase the progress of the still-pending later ones.
              if (selections.get(sessionID)?.promise === promise) {
                selections.delete(sessionID)
                clearPendingTarget(sessionID)
              }
            })
          selections.set(sessionID, { desired, promise })
          setPendingTargets((current) => ({ ...current, [sessionID]: desired }))
          return promise
        },
        parsed: createMemo(() => {
          const value = currentModel()
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
            reasoning: (info?.variants?.length ?? 0) !== 0,
          }
        }),
        cycle(direction: 1 | -1) {
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          // Rapid cycling follows the latest desired target, not the last committed preference.
          const current = (sessionID ? selections.get(sessionID)?.desired : undefined) ?? currentModel()
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
          const current = (sessionID ? selections.get(sessionID)?.desired : undefined) ?? currentModel()
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
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
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
            setModelStore("model", a.id, model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            return normalizeModelVariant(modelStore.variant[modelPreferenceKey(m)])
          },
          current() {
            const v = this.selected()
            if (v && this.list().includes(v)) return v
            return undefined
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const info = data.location.model
              .list(activeLocation())
              ?.find((item) => item.providerID === m.providerID && item.id === m.modelID)
            return info?.variants?.map((variant) => variant.id) ?? []
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            setModelStore("variant", modelPreferenceKey(m), normalizeModelVariant(value))
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return Promise.resolve()
            const m = currentModel()
            if (!m) return Promise.resolve()
            const next = cycleModelVariant(this.current(), variants)
            const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
            // Explicit variant cycling is a durable switch for an existing Session, not a local
            // preference edit, so it must await the same selection path as the picker.
            return model.select({ ...m, ...(next === undefined ? {} : { variant: next }) }, { sessionID })
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(
          data.session
            .list()
            .filter((x) => x.parentID === undefined)
            .map((x) => x.id),
        )
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.data.sessionID)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
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
      if (isModelValid({ providerID: value.model.providerID, modelID: value.model.id })) return
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
