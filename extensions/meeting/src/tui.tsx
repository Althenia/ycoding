/** @jsxImportSource @opentui/solid */
import { Plugin } from "@ycoding-ai/plugin/tui"
import type { KeymapCommand } from "@ycoding-ai/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import { clearTimeout, setTimeout } from "node:timers"
import { useTheme } from "@ycoding-ai/tui/context/theme"
import { createEffect, createSignal, For, on, onCleanup, onMount } from "solid-js"
import { connectControl } from "./discovery"
import type { MeetingView } from "./types"
import {
  configCommand,
  displayValue,
  isMeetingView,
  meetingCommands,
  meetingTranscript,
  parseMeetingCommand,
} from "./view"

type Control = (input: unknown) => Promise<unknown>
export type MeetingContext = {
  readonly keymap: Pick<Plugin.Context["keymap"], "layer">
  readonly ui: { readonly router: Pick<Plugin.Context["ui"]["router"], "current" | "navigate"> }
}

export function MeetingPage(props: {
  context: MeetingContext
  control: Control
  initialCommand?: string
  commandID?: number
  sourceSessionID?: string
}) {
  const { theme } = useTheme()
  const [view, setView] = createSignal<MeetingView>()
  const [selected, setSelected] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [downloadConfirmation, setDownloadConfirmation] = createSignal("")
  let generation = 0
  let mounted = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let polling = false
  let latest: MeetingView | undefined
  let lastCommandID: number | undefined

  const publish = (value: unknown, expected: number) => {
    if (!mounted || generation !== expected) return false
    if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
      setError(value.error.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "))
      setLoading(false)
      return false
    }
    if (!isMeetingView(value)) {
      setError("Meeting controller returned an invalid view.")
      setLoading(false)
      return false
    }
    latest = value
    setView(value)
    setSelected(value.meeting?.id ?? value.meetings[0]?.id ?? "")
    setError("")
    setLoading(false)
    return true
  }

  const refresh = async (
    action: "status" | "summary" | "plan" | "transcript" | "knowledge-review" | "models" | "config" = "status",
  ) => {
    const expected = generation
    setLoading((current) => current && !view())
    try {
      publish(await props.control({ action, ...(selected() ? { meetingID: selected() } : {}) }), expected)
    } catch (reason) {
      if (mounted && generation === expected) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      }
    }
  }

  const run = async (input: unknown, expected = generation) => {
    setLoading((current) => current && !view())
    setError("")
    try {
      const result = await props.control(input)
      const valid = publish(result, expected)
      if (valid) setNotice("")
      return valid
    } catch (reason) {
      if (mounted && generation === expected) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      }
      return false
    }
  }

  const selectMeeting = (meetingID: string) => {
    if (meetingID === selected()) return
    setSelected(meetingID)
    setDownloadConfirmation("")
    const expected = ++generation
    setLoading(true)
    void run({ action: "select", meetingID }, expected)
  }

  const onMeetingRoute = () => {
    const current = props.context.ui.router.current()
    return current.type === "plugin" && current.name === "meeting"
  }

  const command = async (input: string) => {
    const { command: action, args } = parseMeetingCommand(input)
    if (!action || !(meetingCommands as readonly string[]).includes(action)) return extendedCommand(input)
    const meetingID = args[0] || selected() || undefined
    const expected = generation
    if (action === "start") {
      if (
        await run(
          {
            action: "start",
            ...(args[0] || props.sourceSessionID ? { sessionID: args[0] ?? props.sourceSessionID } : {}),
            ...(args.length > 1 ? { title: args.slice(1).join(" ") } : {}),
          },
          expected,
        )
      )
        setNotice("Capture is armed. Recording starts only after the Chrome click and consent.")
      return
    }
    if (
      action === "stop" ||
      action === "status" ||
      action === "summary" ||
      action === "plan" ||
      action === "transcript" ||
      action === "knowledge-review" ||
      action === "models" ||
      action === "config"
    ) {
      const value = { action, ...(meetingID ? { meetingID } : {}) }
      if (action === "models" || action === "config") {
        try {
          if (!publish(await props.control(value), expected)) return
          setNotice(
            action === "models"
              ? "Models are shown from controller state; use /meeting model-select <model> or /meeting model-install <model> confirm-download."
              : `Configuration is shown from controller state; configure with ${configCommand(view()?.config ?? {})}.`,
          )
        } catch (reason) {
          if (mounted && generation === expected) {
            setError(reason instanceof Error ? reason.message : String(reason))
            setLoading(false)
          }
        }
        return
      }
      await run(value, expected)
      return
    }
    if (action === "retry" || action === "reconcile") {
      await run({ action, ...(meetingID ? { meetingID } : {}) }, expected)
      return
    }
  }

  const extendedCommand = async (input: string) => {
    const [action, ...args] = input.trim().split(/\s+/).filter(Boolean)
    const meetingID = selected()
    const expected = generation
    if (action === "approve" || action === "reject") {
      const [proposalID, confirmation] = args
      const needsReview = !latest
      if (needsReview) await refresh("knowledge-review")
      const proposal = latest?.proposals.find((item) => item.id === proposalID && item.meetingID === meetingID)
      if (!proposal || proposal.status !== "pending") {
        setNotice("Open knowledge review and select a pending proposal before deciding.")
        return
      }
      if (needsReview || confirmation !== "confirm") {
        setNotice(
          `Review ${proposal.target}: ${proposal.explanation}. Then run /meeting ${action} ${proposalID} confirm.`,
        )
        return
      }
      await run({ action, proposalID, meetingID }, expected)
      return
    }
    if (action === "confirm" || action === "reject-finding") {
      const [findingID, confirmation] = args
      const needsReview = !latest
      if (needsReview) await refresh()
      const finding = latest?.findings.find((item) => item.id === findingID && item.meetingID === meetingID)
      if (!finding || finding.status !== "unconfirmed") {
        setNotice("Review the unconfirmed finding in this Meeting before deciding.")
        return
      }
      if (needsReview || confirmation !== "confirm") {
        setNotice(`Review finding: ${finding.summary}. Then run /meeting ${action} ${findingID} confirm.`)
        return
      }
      await run({ action, findingID, meetingID }, expected)
      return
    }
    if (action === "correct") {
      const [segmentID, ...text] = args
      if (segmentID && text.length) await run({ action, segmentID, text: text.join(" "), meetingID }, expected)
      else setNotice("Usage: /meeting correct <segmentID> <corrected text>")
      return
    }
    if (action === "delete") {
      const [deleteID, confirmation] = args
      if (!deleteID || confirmation !== "DELETE") {
        setNotice("Delete requires /meeting delete <meetingID> DELETE.")
        return
      }
      await run({ action, meetingID: deleteID, confirmed: true }, expected)
      return
    }
    if (action === "configure") {
      try {
        await run({ action, config: JSON.parse(args.join(" ")) as unknown }, expected)
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Configuration must be valid JSON.")
      }
      return
    }
    if (action === "model-select" && args[0]) {
      await run({ action, model: args[0] }, expected)
      return
    }
    if (action === "model-install" && args[0]) {
      if (args[1] !== "confirm-download") {
        try {
          const inventory = await props.control({ action: "models" })
          if (!publish(inventory, expected)) return
          setDownloadConfirmation(args[0])
          setNotice(
            `Review the model inventory above. Download ${args[0]} only by running /meeting model-install ${args[0]} confirm-download.`,
          )
        } catch (reason) {
          if (mounted && generation === expected) {
            setError(reason instanceof Error ? reason.message : String(reason))
            setLoading(false)
          }
        }
        return
      }
      if (downloadConfirmation() !== args[0]) {
        setNotice("Review the model inventory and request its download confirmation before installing.")
        return
      }
      setDownloadConfirmation("")
      await run({ action, model: args[0], authorized: true }, expected)
      return
    }
    setNotice(
      "Use /meeting approve|reject|confirm|reject-finding|correct|delete|configure|model-select|model-install ….",
    )
  }

  const commands: KeymapCommand[] = [
    {
      id: "meeting.previous",
      title: "Previous Meeting",
      group: "Meeting",
      bind: "up",
      enabled: onMeetingRoute,
      run() {
        const meetings = view()?.meetings ?? []
        const index = meetings.findIndex((item) => item.id === selected())
        if (meetings.length) selectMeeting(meetings[Math.max(0, index - 1)].id)
      },
    },
    {
      id: "meeting.next",
      title: "Next Meeting",
      group: "Meeting",
      bind: "down",
      enabled: onMeetingRoute,
      run() {
        const meetings = view()?.meetings ?? []
        const index = meetings.findIndex((item) => item.id === selected())
        if (meetings.length) selectMeeting(meetings[Math.min(meetings.length - 1, index + 1)].id)
      },
    },
    {
      id: "meeting.refresh",
      title: "Refresh Meeting Intelligence",
      group: "Meeting",
      bind: "ctrl+r",
      enabled: onMeetingRoute,
      run() {
        void refresh()
      },
    },
    {
      id: "meeting.back",
      title: "Leave Meeting Intelligence",
      group: "Meeting",
      bind: "escape",
      enabled: onMeetingRoute,
      run() {
        props.context.ui.router.navigate({ type: "home" })
      },
    },
  ]
  props.context.keymap.layer(() => ({ commands }))

  const poll = async () => {
    if (!mounted || polling) return
    polling = true
    await refresh()
    polling = false
    if (mounted) pollTimer = setTimeout(poll, 2000)
  }

  onMount(() => {
    mounted = true
    if (!props.initialCommand) void poll()
  })
  createEffect(
    on(
      () => props.commandID,
      (id) => {
        const input = props.initialCommand
        if (id === undefined || !input || id === lastCommandID) return
        lastCommandID = id
        void command(input).finally(() => {
          if (mounted && !pollTimer) pollTimer = setTimeout(poll, 2000)
        })
      },
    ),
  )
  onCleanup(() => {
    mounted = false
    if (pollTimer) clearTimeout(pollTimer)
  })

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" height={1}>
        <text fg={theme.text.action.primary.default} attributes={TextAttributes.BOLD}>
          Meeting Intelligence
        </text>
        <box flexGrow={1} />
        <text fg={theme.text.subdued}>
          {loading() ? "loading" : displayValue(view()?.meeting?.title ?? "no Meeting selected")}
        </text>
      </box>
      {error() ? <text fg={theme.text.feedback.error.default}>✗ {displayValue(error())}</text> : null}
      {notice() ? <text fg={theme.text.feedback.warning.default}>! {displayValue(notice())}</text> : null}
      {view() ? (
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <text fg={theme.text.feedback.info.default}>Meetings</text>
          <For each={view()?.meetings.slice(0, 100) ?? []}>
            {(meeting) => (
              <text fg={meeting.id === selected() ? theme.text.action.primary.default : theme.text.default}>
                {meeting.id === selected() ? "› " : "  "}
                {displayValue(meeting.title)} · {meeting.status} · {displayValue(meeting.id)}
              </text>
            )}
          </For>
          <text fg={theme.text.feedback.info.default}>Capture and health</text>
          <text>
            Health: {view()?.health.status} · {displayValue(view()?.health.provider)}/
            {displayValue(view()?.health.model)} · {displayValue(view()?.health.device)}
          </text>
          {view()?.health.warning ? (
            <text fg={theme.text.feedback.warning.default}>! {displayValue(view()?.health.warning)}</text>
          ) : null}
          {view()?.health.error ? (
            <text fg={theme.text.feedback.error.default}>✗ {displayValue(view()?.health.error)}</text>
          ) : null}
          <text>
            Audio backlog: {view()?.audio.backlog} · buffered {view()?.audio.bufferedSeconds}s · processed{" "}
            {view()?.audio.processedSeconds}s
          </text>
          {view()?.audio.sources ? (
            <text>
              Audio sources: remote {view()?.audio.sources?.remote} · microphone {view()?.audio.sources?.microphone}
            </text>
          ) : null}
          {view()?.audio.error ? (
            <text fg={theme.text.feedback.error.default}>✗ {displayValue(view()?.audio.error)}</text>
          ) : null}
          <text>
            Analysis: {view()?.analysis.status}
            {view()?.analysis.latencyMs === undefined ? "" : ` · ${view()?.analysis.latencyMs}ms`}
          </text>
          {view()?.analysis.error ? (
            <text fg={theme.text.feedback.error.default}>✗ {displayValue(view()?.analysis.error)}</text>
          ) : null}
          {view()?.pairing ? (
            <text fg={theme.text.feedback.warning.default}>
              Pair Chrome: {view()?.pairing?.code} · {view()?.pairing?.url}
            </text>
          ) : null}
          <text fg={theme.text.feedback.info.default}>Transcript · original and corrected text</text>
          <For each={meetingTranscript(view()!)}>
            {(segment) => (
              <box flexDirection="column">
                <text fg={theme.text.subdued}>
                  {segment.source} · {displayValue(segment.speaker)} · {segment.state}
                </text>
                <text>Original: {displayValue(segment.original)}</text>
                <text fg={segment.correctedChanged ? theme.text.action.primary.default : theme.text.subdued}>
                  Corrected: {displayValue(segment.corrected)}
                </text>
              </box>
            )}
          </For>
          <text fg={theme.text.feedback.info.default}>Summary</text>
          <text>{displayValue(view()?.summary?.summary ?? "No summary returned.")}</text>
          <text fg={theme.text.feedback.info.default}>Decisions, proposals, and actions</text>
          <For each={view()?.findings.slice(0, 100) ?? []}>
            {(finding) => (
              <text>
                {finding.kind} · {finding.status} · {displayValue(finding.summary)} · {displayValue(finding.id)}
              </text>
            )}
          </For>
          <text fg={theme.text.feedback.info.default}>Plan · {view()?.plan?.status ?? "unavailable"}</text>
          {view()?.plan ? (
            <text fg={theme.text.subdued}>
              Proposed only; repository components and feasibility require inspection.
            </text>
          ) : null}
          {view()?.plan?.status === "rejected" ? (
            <text fg={theme.text.feedback.warning.default}>
              Plan is not current; reconfirm findings and regenerate this plan.
            </text>
          ) : null}
          <text>{displayValue(view()?.plan?.content ?? "No plan returned.")}</text>
          <text fg={theme.text.feedback.info.default}>
            Knowledge review · existing / suggested / evidence / revision
          </text>
          <For each={view()?.proposals.slice(0, 100) ?? []}>
            {(proposal) => (
              <box flexDirection="column">
                <text>
                  {proposal.status}
                  {proposal.status === "manual" ? " · manual review; no writer is available" : ""} ·{" "}
                  {displayValue(proposal.server)}/{displayValue(proposal.target)} · {displayValue(proposal.id)}
                </text>
                <text>Existing: {displayValue(proposal.existingContent)}</text>
                <text>Suggested: {displayValue(proposal.suggestedContent)}</text>
                <text>
                  Evidence: {displayValue(proposal.sourceSegmentIds.join(", "))} · revision{" "}
                  {displayValue(proposal.expectedRevision)}
                </text>
                <text>{displayValue(proposal.explanation)}</text>
              </box>
            )}
          </For>
          <text fg={theme.text.feedback.info.default}>Configuration</text>
          <For each={Object.entries(view()?.config ?? {})}>
            {([key, value]) => (
              <text>
                {displayValue(key)}: {displayValue(value)}
              </text>
            )}
          </For>
          <text fg={theme.text.subdued}>Change config: {displayValue(configCommand(view()?.config ?? {}))}</text>
          <text fg={theme.text.feedback.info.default}>Models</text>
          <text>{displayValue((view() as (MeetingView & { models?: unknown }) | undefined)?.models)}</text>
          <text fg={theme.text.subdued}>
            Select model with /meeting model-select &lt;model&gt;; review download details before /meeting model-install
            &lt;model&gt; confirm-download.
          </text>
          <text fg={theme.text.subdued}>
            ↑↓ select Meeting · ctrl+r refresh · /meeting retry · /meeting reconcile · start only arms capture; Chrome
            click and consent start recording
          </text>
        </scrollbox>
      ) : loading() ? (
        <text fg={theme.text.subdued}>Loading Meeting state…</text>
      ) : (
        <text fg={theme.text.feedback.error.default}>No Meeting state is available.</text>
      )}
    </box>
  )
}

export function MeetingCommands(props: { context: MeetingContext }) {
  let commandID = 0
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "meeting.command",
        title: "Meeting Intelligence",
        description: "Control and review Meeting Intelligence",
        group: "Meeting",
        bind: false,
        slash: { name: "meeting", arguments: true },
        run(input = "") {
          const current = props.context.ui.router.current()
          const sourceSessionID =
            current.type === "session"
              ? current.sessionID
              : current.type === "plugin" && typeof current.data?.sourceSessionID === "string"
                ? current.data.sourceSessionID
                : undefined
          props.context.ui.router.navigate({
            type: "plugin",
            name: "meeting",
            data: { command: input, commandID: ++commandID, sourceSessionID },
          })
        },
      },
      {
        id: "meeting.open",
        title: "Open Meeting Intelligence",
        group: "Meeting",
        palette: true,
        run() {
          const current = props.context.ui.router.current()
          props.context.ui.router.navigate({
            type: "plugin",
            name: "meeting",
            data: { sourceSessionID: current.type === "session" ? current.sessionID : undefined },
          })
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "ycoding.meeting",
  setup(context) {
    const controller = connectControl(context.location?.directory ?? process.cwd())
    context.ui.router.register({
      name: "meeting",
      render: ({ data }) => (
        <MeetingPage
          context={context}
          control={async (input) => (await controller)(input)}
          initialCommand={typeof data?.command === "string" ? data.command : undefined}
          commandID={typeof data?.commandID === "number" ? data.commandID : undefined}
          sourceSessionID={typeof data?.sourceSessionID === "string" ? data.sourceSessionID : undefined}
        />
      ),
    })
    context.ui.slot("app", () => <MeetingCommands context={context} />)
  },
})
