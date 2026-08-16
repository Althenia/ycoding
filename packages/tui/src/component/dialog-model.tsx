import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogIntegration } from "./dialog-integration"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"

export type DialogModelSelection = {
  providerID: string
  modelID: string
  variant?: string
}

export type DialogModelResult =
  | { type: "selected"; selection: DialogModelSelection }
  | { type: "cancelled" }

export function completeModelSelection(input: {
  providerID: string
  modelID: string
  variants: string[]
  currentVariant?: string
  variant?: string
}): DialogModelSelection | undefined {
  if (input.variant) return { providerID: input.providerID, modelID: input.modelID, variant: input.variant }
  if (input.currentVariant && input.variants.includes(input.currentVariant)) {
    return { providerID: input.providerID, modelID: input.modelID, variant: input.currentVariant }
  }
  if (input.variants.length) return
  return { providerID: input.providerID, modelID: input.modelID }
}

export function DialogModel(props: {
  providerID?: string
  order?: readonly { providerID: string; modelID: string }[]
  onComplete?: (result: DialogModelResult) => void
}) {
  const local = useLocal()
  const data = useData()
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const [query, setQuery] = createSignal("")
  let settled = false
  let selectingVariant = false
  onCleanup(() => {
    if (settled || selectingVariant) return
    props.onComplete?.({ type: "cancelled" })
  })

  const connected = useConnected()
  const providers = createMemo(() => new Map((data.location.provider.list() ?? []).map((item) => [item.id, item])))
  const models = createMemo(() => data.location.model.list() ?? [])

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const model = models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        const provider = providers().get(model.providerID)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: provider?.name ?? model.providerID,
            category,
            footer: model.enabled ? formatContext(model.limit.context) : "Unavailable",
            onSelect: () => {
              onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const sortedModelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          return {
            value: { providerID: model.providerID, modelID: model.id },
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            enabled: model.enabled,
            title: model.name,
            releaseDate: model.time.released,
            description: model.family
              ? `${model.family}${model.enabled && model.capabilities.tools ? " · tools" : ""}`
              : favorites.some((item) => item.providerID === model.providerID && item.modelID === model.id)
                ? "(Favorite)"
                : model.capabilities.tools
                  ? "tools"
                  : undefined,
            category: connected() ? (provider?.name ?? model.providerID) : undefined,
            categoryView:
              model.enabled || !connected() ? undefined : (
                <box height={1}>
                  <text fg={themeV2.text.feedback.info.default} attributes={TextAttributes.BOLD}>
                    {provider?.name ?? model.providerID}
                  </text>
                </box>
              ),
            footer: model.enabled ? formatContext(model.limit.context) : "Unavailable",
            state: model.enabled ? ("connected" as const) : ("disabled" as const),
            onSelect() {
              onSelect(model.providerID, model.id)
            },
          }
        })
        .filter((option) => {
          if (!showSections) return true
          if (
            favorites.some(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          )
            return false
          if (
            recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
          )
            return false
          return true
        }),
    )
    const order = props.order
    const modelOptions = order
      ? sortedModelOptions.toSorted((a, b) => {
          const index = (option: typeof a) =>
            order.findIndex(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          const left = index(a)
          const right = index(b)
          if (left === -1 && right === -1) return 0
          if (left === -1) return 1
          if (right === -1) return -1
          return left - right
        })
      : sortedModelOptions

    if (needle) {
      return fuzzysort.go(needle, modelOptions, { keys: ["title", "category"] }).map((item) => item.obj)
    }

    return [...favoriteOptions, ...recentOptions, ...modelOptions]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    if (props.onComplete) {
      const variants = models()
        .find((model) => model.providerID === providerID && model.id === modelID)
        ?.variants.map((variant) => variant.id) ?? []
      const selection = completeModelSelection({
        providerID,
        modelID,
        variants,
        currentVariant: local.model.variant.current(),
      })
      if (selection) {
        settled = true
        props.onComplete({ type: "selected", selection })
        dialog.clear()
        return
      }
      selectingVariant = true
      dialog.replace(() => (
        <DialogVariant
          variants={variants}
          onSelect={(variant) => {
            const selection = completeModelSelection({ providerID, modelID, variants, variant })
            if (!selection) return
            settled = true
            props.onComplete?.({ type: "selected", selection })
            dialog.clear()
          }}
          onCancel={() => props.onComplete?.({ type: "cancelled" })}
        />
      ))
      return
    }
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect integration" : "View all integrations",
          selection: "none",
          onTrigger() {
            dialog.replace(() => (
              <DialogIntegration
                onConnected={(providerID) =>
                  dialog.replace(() => <DialogModel providerID={providerID} onComplete={props.onComplete} />)
                }
              />
            ))
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
      focusCurrent={false}
    />
  )
}

export function sortModelOptions<
  T extends { providerID?: string; providerName?: string; releaseDate: string | number; title: string; enabled?: boolean },
>(options: T[]) {
  return options.toSorted((a, b) => {
    const availability = Number(a.enabled === false) - Number(b.enabled === false)
    if (availability !== 0) return availability

    const provider =
      Number(a.providerID !== "opencode") - Number(b.providerID !== "opencode") // YCODING_EXTERNAL_OPENCODE
    if (provider !== 0) return provider

    const name = (a.providerName ?? "").localeCompare(b.providerName ?? "")
    if (name !== 0) return name

    const release = Number(b.releaseDate) - Number(a.releaseDate)
    if (release !== 0) return release

    return a.title.localeCompare(b.title)
  })
}

function formatContext(tokens: number) {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}m`
  if (tokens >= 1_000) return `${tokens / 1_000}k`
  return String(tokens)
}
