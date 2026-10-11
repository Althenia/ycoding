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
import { modelVariantIDs } from "../util/model"

export type DialogModelSelection = {
  providerID: string
  modelID: string
  variant?: string
  profile?: string
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
  profile?: string
}): DialogModelSelection | undefined {
  const selection = {
    providerID: input.providerID,
    modelID: input.modelID,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    ...("profile" in input ? { profile: input.profile } : {}),
  }
  if (input.variant) return selection
  if (input.currentVariant && input.variants.includes(input.currentVariant)) {
    return { ...selection, variant: input.currentVariant }
  }
  if (input.variants.length) return
  return selection
}

export function DialogModel(props: {
  providerID?: string
  sessionID?: string
  order?: readonly { providerID: string; modelID: string }[]
  onComplete?: (result: DialogModelResult) => void
}) {
  const local = useLocal()
  const data = useData()
  const dialog = useDialog()
  const { theme } = useTheme().contextual("elevated")
  const [query, setQuery] = createSignal("")
  let settled = false
  let selectingProfile = false
  let selectingVariant = false
  onCleanup(() => {
    if (settled || selectingProfile || selectingVariant) return
    props.onComplete?.({ type: "cancelled" })
  })

  const connected = useConnected()
  const selectionLocation = createMemo(() => props.sessionID ? data.session.get(props.sessionID)?.location ?? data.location.default() : data.location.default())
  const providers = createMemo(() => new Map((data.location.provider.list(selectionLocation()) ?? []).map((item) => [item.id, item])))
  const models = createMemo(() => data.location.model.list(selectionLocation()) ?? [])

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
            value: { providerID: model.providerID, modelID: model.id, ...(item.profile === undefined ? {} : { profile: item.profile }) },
            title: model.name,
            releaseDate: model.time.released,
            description: `${provider?.name ?? model.providerID} · ${item.profile ?? "provider default"}`,
            category,
            footer: model.enabled ? formatContext(model.limit.context) : "Unavailable",
            onSelect: () => {
              onSelect(model.providerID, model.id, item.profile, true)
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
          const profileAvailable = (model.profiles?.length ?? 0) > 0
          const selectable = model.enabled || profileAvailable
          return {
            value: { providerID: model.providerID, modelID: model.id },
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            enabled: selectable,
            title: model.name,
            releaseDate: model.time.released,
            description: model.family
              ? `${model.family}${model.enabled && model.capabilities.tools ? " · tools" : ""}`
              : favorites.some((item) => item.providerID === model.providerID && item.modelID === model.id)
                ? "(Favorite)"
                : model.capabilities.tools
                  ? "tools"
                  : undefined,
            category: connected() ? provider?.name ?? model.providerID : undefined,
            categoryView:
              selectable || !connected() ? undefined : (
                <box height={1}>
                  <text fg={theme.text.feedback.info.default} attributes={TextAttributes.BOLD}>
                    {provider?.name ?? model.providerID}
                  </text>
                </box>
              ),
            footer: model.enabled ? formatContext(model.limit.context) : profileAvailable ? "Profiles" : "Unavailable",
            state: model.enabled ? ("connected" as const) : profileAvailable ? undefined : ("disabled" as const),
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

  function onSelect(providerID: string, modelID: string, preferredProfile?: string, explicitProfile = false) {
    const model = models().find((item) => item.providerID === providerID && item.id === modelID)
    if (!model) return
    const selected = local.model.current()
    const currentProfile = selected?.providerID === providerID ? selected.profile : undefined
    const profile = explicitProfile ? preferredProfile : currentProfile
    if (model.profiles?.length || profile !== undefined || explicitProfile) {
      selectingProfile = true
      dialog.replace(() => (
        <DialogModelProfile
          profiles={model.profiles ?? []}
          selected={profile}
          providerDefaultAvailable={model.enabled}
          onCancel={() => props.onComplete?.({ type: "cancelled" })}
          onSelect={(value) => finishSelection(providerID, modelID, value, true)}
        />
      ))
      return
    }
    finishSelection(providerID, modelID)
  }

  function finishSelection(providerID: string, modelID: string, profile?: string, explicitProfile = false) {
    const info = models().find((model) => model.providerID === providerID && model.id === modelID)
    const variants = [...modelVariantIDs({ model: info, profile })]
    const profileSelection = explicitProfile ? { profile } : {}
    const currentVariant = local.model.variant.current({ providerID, modelID, ...profileSelection })
    const selection = completeModelSelection({
      providerID,
      modelID,
      variants,
      currentVariant,
      ...profileSelection,
    })
    if (selection) {
      settled = true
      if (props.onComplete) props.onComplete({ type: "selected", selection })
      else void local.model.select(selection, { sessionID: props.sessionID })
      dialog.clear()
      return
    }
    if (currentVariant !== undefined && !variants.includes(currentVariant) && !props.onComplete)
      void local.model.select({ providerID, modelID, ...profileSelection }, { sessionID: props.sessionID })
    selectingVariant = true
    dialog.replace(() => (
      <DialogVariant
        variants={variants}
        current={currentVariant}
        onSelect={(variant) => {
          const selected = completeModelSelection({ providerID, modelID, variants, variant, ...profileSelection })
          if (!selected) return
          settled = true
          if (props.onComplete) props.onComplete({ type: "selected", selection: selected })
          else void local.model.select(selected, { sessionID: props.sessionID })
          dialog.clear()
        }}
        onCancel={() => props.onComplete?.({ type: "cancelled" })}
        onClear={() => {
          const selected = completeModelSelection({ providerID, modelID, variants, ...profileSelection })
          if (!selected) return
          settled = true
          if (props.onComplete) props.onComplete({ type: "selected", selection: selected })
          else void local.model.select({ ...selected, variant: undefined }, { sessionID: props.sessionID })
          dialog.clear()
        }}
      />
    ))
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
          onTrigger: (option) => local.model.toggleFavorite(option.value),
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

function DialogModelProfile(props: {
  readonly profiles: readonly { readonly name: string; readonly active: boolean }[]
  readonly selected?: string
  readonly providerDefaultAvailable: boolean
  readonly onSelect: (profile?: string) => void
  readonly onCancel: () => void
}) {
  const options = createMemo(() => [
    {
      title: "Use provider default",
      value: undefined,
      description: "Use the provider's current default profile",
      disabled: !props.providerDefaultAvailable,
    },
    ...(props.selected !== undefined && !props.profiles.some((profile) => profile.name === props.selected)
      ? [{ title: `Unavailable: ${props.selected}`, value: props.selected, description: "No longer offered for this model" }]
      : []),
    ...props.profiles.map((profile) => ({
      title: profile.name,
      value: profile.name,
      description: profile.active ? "Provider default" : undefined,
    })),
  ])
  let settled = false
  onCleanup(() => { if (!settled) props.onCancel() })
  return <DialogSelect<string | undefined>
    title="Provider profile"
    options={options()}
    current={props.selected}
    focusCurrent
    onSelect={(option) => { settled = true; props.onSelect(option.value) }}
  />
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
