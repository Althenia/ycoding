import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import type {
  LocationRef,
  ProjectArtifactArtifactDetails,
  ProjectArtifactApiConfirmationPreview,
  ProjectArtifactApiListItem,
  ProjectArtifactApiTrashSummary,
  ProjectArtifactMetrics,
  ProjectArtifactPromotionPreview,
  ProjectArtifactVersion,
} from "@ycoding-ai/client"
import { useClient } from "../context/client"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import {
  artifactActions,
  artifactKindLabel,
  artifactLoadStatus,
  definitionContent,
  filterArtifacts,
  promotionPreviewLines,
  confirmationPreviewLines,
  shadowEligible,
  type ArtifactKind,
  type ArtifactScope,
  type ArtifactStage,
} from "../util/project-artifacts"

type ArtifactListItem = ProjectArtifactApiListItem
type TrashListItem = ProjectArtifactApiTrashSummary
type ArtifactConfirmation =
  | "remove"
  | { type: "promotion"; preview: ProjectArtifactPromotionPreview }
  | { type: "fork"; preview: ProjectArtifactApiConfirmationPreview }
  | { type: "shadow"; preview: ProjectArtifactApiConfirmationPreview }

export type DialogProjectArtifactsProps = {
  location?: LocationRef
}

export function DialogProjectArtifacts(props: DialogProjectArtifactsProps) {
  const client = useClient()
  const dialog = useDialog()
  const { themeV2 } = useTheme()
  const [scope, setScope] = createSignal<ArtifactScope>("project")
  const [stage, setStage] = createSignal<ArtifactStage | "all">("all")
  const [selected, setSelected] = createSignal<ArtifactListItem>()
  const [loadError, setLoadError] = createSignal<unknown>()
  onMount(() => dialog.setSize("large"))

  const [artifacts, { refetch }] = createResource<
    ArtifactListItem[],
    { scope: ArtifactScope; stage: ArtifactStage | "all" }
  >(
    () => ({ scope: scope(), stage: stage() }),
    async (filter, info) => {
      try {
        const data = await client.api.projectArtifact.artifact.list({
          location: props.location,
          scope: filter.scope,
          stage: filter.scope === "trash" || filter.stage === "all" ? undefined : filter.stage,
        })
        setLoadError(undefined)
        return data
      } catch (error) {
        setLoadError(error)
        return info.value ?? []
      }
    },
  )

  const visible = createMemo(() =>
    filterArtifacts(artifacts() ?? [], { scope: scope(), kind: "all", stage: stage() }),
  )
  const options = createMemo<DialogSelectOption<ArtifactListItem>[]>(() =>
    visible().map((artifact) => {
      const status = isTrashArtifact(artifact) ? undefined : artifactLoadStatus(artifact.stage)
      const secondLine = !isTrashArtifact(artifact) && artifact.kind !== "skill"
      return {
        title: artifact.name,
        titleView: secondLine ? (
          <span style={{ fg: status?.loaded === false ? themeV2.text.subdued : themeV2.text.default }}>{`\n${artifact.name}`}</span>
        ) : status?.loaded === false ? (
          <span style={{ fg: themeV2.text.subdued }}>{artifact.name}</span>
        ) : undefined,
        description: artifact.description,
        footer:
          status === undefined ? undefined : status.loaded ? (
            <span style={{ fg: themeV2.text.action.primary.focused }}>{secondLine ? `\n${status.label}` : status.label}</span>
          ) : (
            <span style={{ fg: themeV2.text.subdued }}>{secondLine ? `\n${status.label}` : status.label}</span>
          ),
        state: secondLine ? undefined : status === undefined ? undefined : status.loaded ? "connected" : "disabled",
        gutter:
          secondLine && status
            ? () => (
                <text fg={status.loaded ? themeV2.text.feedback.success.default : themeV2.text.subdued}>
                  {status.loaded ? "\n✓" : "\n○"}
                </text>
              )
            : undefined,
        category: isTrashArtifact(artifact) ? "Trash" : artifact.kind === "plugin" ? "Plugins" : artifactKindLabel(artifact.kind),
        value: artifact,
        details: undefined,
        onSelect: () => {
          setSelected(artifact)
        },
      }
    }),
  )
  const labels = createMemo(() => ({
    scope: scope() === "trash" ? "Trash" : title(scope()),
    stage: stage() === "all" ? "All" : title(stage()),
  }))

  const changeScope = (direction: 1 | -1) => {
    const scopes: ArtifactScope[] = ["project", "global", "trash"]
    const current = scopes.indexOf(scope())
    setScope(scopes[(current + direction + scopes.length) % scopes.length])
  }
  const changeStage = () => {
    if (scope() === "trash") return
    const values: Array<ArtifactStage | "all"> = ["all", "trial", "active", "degraded", "disabled", "quarantine"]
    setStage(values[(values.indexOf(stage()) + 1) % values.length])
  }

  return (
    <Show
      when={selected()}
      fallback={
        <DialogSelect
          title="Project artifacts"
          options={options()}
          renderFilter={!artifacts.loading && !loadError()}
          locked={artifacts.loading || Boolean(loadError())}
          bindings={[
            {
              bind: "tab",
              title: "Next artifact scope",
              group: "Dialog",
              run: () => changeScope(1),
            },
            {
              bind: "shift+tab",
              title: "Previous artifact scope",
              group: "Dialog",
              run: () => changeScope(-1),
            },
            {
              bind: "s",
              title: "Change artifact stage filter",
              group: "Dialog",
              run: changeStage,
            },
            {
              bind: "r",
              title: "Retry loading project artifacts",
              group: "Dialog",
              run: () => {
                void refetch()
              },
            },
          ]}
          footer={
            <text fg={themeV2.text.subdued}>
              {labels().scope}
              <Show when={scope() !== "trash"}> · {labels().stage}</Show>
            </text>
          }
          emptyView={
            <Switch
              fallback={
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.subdued}>No project artifacts</text>
                </box>
              }
            >
              <Match when={loadError()}>
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.feedback.error.default} attributes={TextAttributes.BOLD}>
                    Could not load project artifacts
                  </text>
                  <text fg={themeV2.text.subdued} wrapMode="word">
                    {errorMessage(loadError())}
                  </text>
                </box>
              </Match>
              <Match when={artifacts.loading}>
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.subdued}>Loading project artifacts…</text>
                </box>
              </Match>
            </Switch>
          }
          noMatchView={
            <box paddingLeft={4} paddingRight={4} paddingTop={1}>
              <text fg={themeV2.text.subdued}>No matching project artifacts</text>
            </box>
          }
        />
      }
    >
      {(artifact) => selectedView(artifact(), props.location, () => setSelected(), () => refetch())}
    </Show>
  )
}

function selectedView(
  artifact: ArtifactListItem | undefined,
  location: LocationRef | undefined,
  onBack: () => void,
  onChanged: () => unknown,
) {
  if (!artifact) return
  if (isTrashArtifact(artifact)) {
    return <DialogProjectArtifactTrash artifact={artifact} location={location} onBack={onBack} onChanged={onChanged} />
  }
  return (
    <DialogProjectArtifactDetails
      scope={artifact.scope.type}
      kind={artifact.kind}
      id={artifact.id}
      location={location}
      onBack={onBack}
      onChanged={onChanged}
    />
  )
}

function DialogProjectArtifactTrash(props: {
  artifact: TrashListItem
  location?: LocationRef
  onBack: () => void
  onChanged: () => unknown
}) {
  const client = useClient()
  const toast = useToast()
  const [working, setWorking] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const trash = () => props.artifact

  const restore = async () => {
    if (working()) return
    setWorking(true)
    try {
      await client.api.projectArtifact.artifact.restore({ location: props.location, deletionID: trash().deletionID })
      await props.onChanged()
      toast.show({ message: `Restored ${trash().id}`, variant: "success", duration: 3000 })
      props.onBack()
    } catch (error) {
      toast.show({ message: `Failed to restore ${trash().id}: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    } finally {
      setWorking(false)
      setConfirming(false)
    }
  }

  return (
    <Show
      when={confirming()}
      fallback={
        <DialogSelect
          title={`Trash: ${trash().id}`}
          options={[]}
          renderFilter={false}
          locked
          bindings={[
            { bind: "escape", title: "Back to project artifacts", group: "Dialog", run: props.onBack },
            {
              bind: "r",
              title: "Restore artifact",
              group: "Dialog",
              run: () => setConfirming(true),
            },
          ]}
          emptyView={
            <ArtifactLines
              lines={[
                `Scope: ${title(trash().scope.type)}`,
                `Kind: ${artifactKindLabel(trash().kind)}`,
                `ID: ${trash().id}`,
                `Prior stage: ${title(trash().priorStage)}`,
                `Prior version: ${trash().priorVersionID}`,
                `Deleted: ${new Date(trash().deletedAt).toLocaleString()}`,
                `Purge after: ${new Date(trash().purgeAfter).toLocaleString()}`,
              ]}
            />
          }
        />
      }
    >
      <ArtifactConfirmation
        title={`Restore ${trash().id}?`}
        message="Restore this trashed artifact to its prior stage."
        working={working()}
        onBack={() => setConfirming(false)}
        onConfirm={restore}
      />
    </Show>
  )
}

function DialogProjectArtifactDetails(props: {
  scope: "project" | "global"
  kind: ArtifactKind
  id: string
  location?: LocationRef
  onBack: () => void
  onChanged: () => unknown
}) {
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme()
  const [loadError, setLoadError] = createSignal<unknown>()
  const [working, setWorking] = createSignal(false)
  const [selectedVersion, setSelectedVersion] = createSignal<ProjectArtifactVersion>()
  const [confirmation, setConfirmation] = createSignal<ArtifactConfirmation>()

  const [loaded, { refetch }] = createResource(
    () => ({ scope: props.scope, kind: props.kind, id: props.id }),
    async (identity) => {
      try {
        const details = await client.api.projectArtifact.artifact.get({ ...identity, location: props.location })
        const metrics = await client.api.projectArtifact.artifact.metrics({ ...identity, location: props.location })
        setLoadError(undefined)
        return { details, metrics }
      } catch (error) {
        setLoadError(error)
        return undefined
      }
    },
  )
  const data = () => loaded()
  const actions = createMemo(() => {
    const current = data()
    if (!current) return artifactActions({ scope: props.scope, kind: props.kind, stage: "quarantine", versions: 0 })
    return artifactActions({
      scope: props.scope,
      kind: current.details.artifact.kind,
      stage: current.details.artifact.stage,
      versions: current.details.versions.length,
      shadowable: shadowEligible({
        scope: props.scope,
        kind: current.details.artifact.kind,
        id: current.details.artifact.id,
        diagnostics: current.details.diagnostics,
      }),
    })
  })
  const versions = createMemo<DialogSelectOption<ProjectArtifactVersion>[]>(() => {
    const current = data()
    if (!current) return []
    return current.details.versions.map((version) => ({
      title: version.id === current.details.currentVersion.id ? `Current · ${version.id}` : version.id,
      description: `${title(version.state)} · ${version.contentDigest}`,
      value: version,
      details:
        version.id === current.details.currentVersion.id
          ? detailLines(current.details, current.metrics)
          : [`Created: ${new Date(version.timeCreated).toLocaleString()}`],
      detailsWrap: version.id === current.details.currentVersion.id,
    }))
  })

  const identity = () => {
    const current = data()
    if (!current) return
    return {
      scope: props.scope,
      kind: current.details.artifact.kind,
      id: current.details.artifact.id,
      location: props.location,
      expectedRevision: current.details.artifact.revision,
      expectedVersionID: current.details.currentVersion.id,
      expectedDigest: current.details.currentVersion.contentDigest,
    }
  }
  const mutate = async (name: string, run: (input: NonNullable<ReturnType<typeof identity>>) => Promise<unknown>) => {
    const current = identity()
    if (!current || working()) return false
    setWorking(true)
    try {
      await run(current)
      await Promise.all([refetch(), props.onChanged()])
      toast.show({ message: `${name} ${current.id}`, variant: "success", duration: 3000 })
      return true
    } catch (error) {
      toast.show({ message: `Failed to ${name.toLowerCase()} ${current.id}: ${errorMessage(error)}`, variant: "error", duration: 5000 })
      return false
    } finally {
      setWorking(false)
    }
  }
  const toggle = () => {
    if (actions().enable) {
      void mutate("Enabled", (input) => client.api.projectArtifact.artifact.enable(input))
      return
    }
    if (actions().disable) void mutate("Disabled", (input) => client.api.projectArtifact.artifact.disable(input))
  }
  const revert = () => {
    const target = selectedVersion()
    const current = data()
    if (!target || !current || target.id === current.details.currentVersion.id || !actions().revert) return
    void mutate("Reverted", (input) => client.api.projectArtifact.artifact.revert({ ...input, targetVersionID: target.id }))
  }
  const previewPromotion = async () => {
    const current = identity()
    if (!current || !actions().promote || working()) return
    setWorking(true)
    try {
      const preview = await client.api.projectArtifact.artifact.promotion.preview(current)
      setConfirmation({ type: "promotion", preview })
    } catch (error) {
      toast.show({ message: `Failed to preview promotion: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    } finally {
      setWorking(false)
    }
  }
  const previewFork = async () => {
    const current = identity()
    if (!current || !actions().fork || working()) return
    setWorking(true)
    try {
      setConfirmation({ type: "fork", preview: await client.api.projectArtifact.artifact.fork.preview(current) })
    } catch (error) {
      toast.show({ message: `Failed to preview fork: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    } finally {
      setWorking(false)
    }
  }
  const previewShadow = async () => {
    const current = identity()
    if (!current || !actions().shadow || working()) return
    setWorking(true)
    try {
      setConfirmation({ type: "shadow", preview: await client.api.projectArtifact.artifact.shadow.preview(current) })
    } catch (error) {
      toast.show({ message: `Failed to preview shadowing: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    } finally {
      setWorking(false)
    }
  }
  const confirm = () => {
    const preview = confirmation()
    if (!preview || preview === "remove") return
    if (preview.type === "promotion" && preview.preview.collision) return
    const current = data()
    if (!current) return
    const run = preview.type === "promotion"
      ? () =>
          client.api.projectArtifact.artifact.promotion.confirm({
            location: props.location,
            kind: current.details.artifact.kind,
            id: current.details.artifact.id,
            token: preview.preview.token,
          })
      : preview.type === "fork"
        ? () =>
          client.api.projectArtifact.artifact.fork.confirm({
            location: props.location,
            kind: current.details.artifact.kind,
            id: current.details.artifact.id,
            token: preview.preview.token,
          })
        : () =>
            client.api.projectArtifact.artifact.shadow.confirm({
              location: props.location,
              kind: current.details.artifact.kind,
              id: current.details.artifact.id,
              token: preview.preview.token,
            })
    void (async () => {
      setWorking(true)
      try {
        await run()
        await Promise.all([refetch(), props.onChanged()])
        toast.show({
          message: preview.type === "shadow" ? "Artifact shadowing enabled" : "Artifact copy created",
          variant: "success",
          duration: 3000,
        })
        setConfirmation()
      } catch (error) {
        toast.show({ message: `Failed to confirm copy: ${errorMessage(error)}`, variant: "error", duration: 5000 })
      } finally {
        setWorking(false)
      }
    })()
  }

  return (
    <Show
      when={confirmation()}
      fallback={
        <DialogSelect
          title={`Artifact: ${props.id}`}
          options={versions()}
          renderFilter={false}
          locked={!data() || Boolean(loadError()) || working()}
          current={data()?.details.currentVersion}
          onMove={(option) => setSelectedVersion(option.value)}
          bindings={[
            { bind: "escape", title: "Back to project artifacts", group: "Dialog", run: props.onBack },
            { bind: "space", title: "Enable or disable artifact", group: "Dialog", run: toggle },
            {
              bind: "x",
              title: "Remove artifact to trash",
              group: "Dialog",
              run: () => actions().remove && setConfirmation("remove"),
            },
            {
              bind: "r",
              title: loadError() ? "Retry loading artifact details" : "Revert to selected version",
              group: "Dialog",
              run: () => {
                if (loadError()) {
                  void refetch()
                  return
                }
                revert()
              },
            },
            { bind: "p", title: "Preview promotion to global", group: "Dialog", run: () => void previewPromotion() },
            { bind: "f", title: "Preview fork to project", group: "Dialog", run: () => void previewFork() },
            ...(actions().shadow
              ? [{ bind: "h", title: "Preview project shadowing", group: "Dialog", run: () => void previewShadow() }]
              : []),
            { bind: "m", title: "Refresh artifact metrics", group: "Dialog", run: () => void refetch() },
          ]}
          emptyView={
            <Switch
              fallback={
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.subdued}>No versions available</text>
                </box>
              }
            >
              <Match when={loadError()}>
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.feedback.error.default} attributes={TextAttributes.BOLD}>
                    Could not load artifact details
                  </text>
                  <text fg={themeV2.text.subdued} wrapMode="word">
                    {errorMessage(loadError())}
                  </text>
                </box>
              </Match>
              <Match when={loaded.loading}>
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.subdued}>Loading artifact details…</text>
                </box>
              </Match>
            </Switch>
          }
        />
      }
    >
      {(value) => (
        <Show
          when={value() === "remove"}
          fallback={
            confirmationView(value(), working(), () => setConfirmation(), confirm)
          }
        >
          <ArtifactConfirmation
            title={`Remove ${props.id}?`}
            message="Move this artifact to trash for 30 days."
            working={working()}
            onBack={() => setConfirmation()}
            onConfirm={() => {
              void mutate("Removed", (input) => client.api.projectArtifact.artifact.remove(input)).then((removed) => {
                setConfirmation()
                if (removed) props.onBack()
              })
            }}
          />
        </Show>
      )}
    </Show>
  )
}

function confirmationView(
  confirmation: ArtifactConfirmation | undefined,
  working: boolean,
  onBack: () => void,
  onConfirm: () => void,
) {
  if (!confirmation || confirmation === "remove") return
  return <ArtifactPreview confirmation={confirmation} working={working} onBack={onBack} onConfirm={onConfirm} />
}

function ArtifactPreview(props: {
  confirmation: Exclude<ArtifactConfirmation, "remove">
  working: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const promotion = () => props.confirmation.type === "promotion"
  const shadow = () => props.confirmation.type === "shadow"
  const blocked = () => props.confirmation.type === "promotion" && props.confirmation.preview.collision !== undefined
  const lines = createMemo(() =>
    props.confirmation.type === "promotion"
      ? promotionPreviewLines(props.confirmation.preview)
      : shadow()
        ? [...confirmationPreviewLines(props.confirmation.preview), "Project shadowing requires confirmation."]
        : confirmationPreviewLines(props.confirmation.preview),
  )
  return (
    <DialogSelect
      title={promotion() ? "Promotion preview" : shadow() ? "Shadow preview" : "Fork preview"}
      options={[]}
      renderFilter={false}
      locked
      bindings={[
        { bind: "escape", title: "Back to artifact details", group: "Dialog", run: props.onBack },
        {
          bind: "return",
          title: blocked() ? "Promotion blocked by collision" : shadow() ? "Confirm project shadowing" : "Confirm artifact copy",
          group: "Dialog",
          run: () => {
            if (!blocked() && !props.working) props.onConfirm()
          },
        },
      ]}
      emptyView={<ArtifactLines lines={lines()} />}
    />
  )
}

function ArtifactConfirmation(props: {
  title: string
  message: string
  working: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const { themeV2 } = useTheme()
  return (
    <DialogSelect
      title={props.title}
      options={[]}
      renderFilter={false}
      locked
      bindings={[
        { bind: "escape", title: "Cancel artifact action", group: "Dialog", run: props.onBack },
        {
          bind: "return",
          title: "Confirm artifact action",
          group: "Dialog",
          run: () => {
            if (!props.working) props.onConfirm()
          },
        },
      ]}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={themeV2.text.subdued} wrapMode="word">
            {props.message}
          </text>
        </box>
      }
    />
  )
}

function ArtifactLines(props: { lines: ReadonlyArray<string> }) {
  const { themeV2 } = useTheme()
  return (
    <box paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="column">
      <For each={props.lines}>
        {(line) => (
          <text fg={themeV2.text.subdued} wrapMode="word">
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

function detailLines(details: ProjectArtifactArtifactDetails, metrics: ProjectArtifactMetrics) {
  return [
    `Scope: ${title(details.artifact.scope.type)}`,
    `Kind: ${artifactKindLabel(details.artifact.kind)}`,
    `ID: ${details.artifact.id}`,
    `Stage: ${title(details.artifact.stage)}`,
    `Revision: ${details.artifact.revision}`,
    `Current version: ${details.currentVersion.id}`,
    `Digest: ${details.currentVersion.contentDigest}`,
    `Definition:\n${definitionContent(details.definition)}`,
    `Metrics: score ${metrics.score} · samples ${metrics.confidence.sampleCount} · confidence ${metrics.confidence.lowerBound}–${metrics.confidence.upperBound}`,
    `Last used: ${metrics.lastUsedAt === undefined ? "never" : new Date(metrics.lastUsedAt).toLocaleString()}`,
    ...(details.diagnostics.length ? details.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic.message}`) : ["Diagnostics: none"]),
  ]
}

function title(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function isTrashArtifact(artifact: ArtifactListItem): artifact is TrashListItem {
  return "deletionID" in artifact
}
