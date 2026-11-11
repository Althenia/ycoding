import { YCoding } from "@ycoding-ai/client/promise"
import { Service } from "@ycoding-ai/client/effect/service"
import { Effect, Option } from "effect"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import { MeetingCommand } from "../meeting"
import { Runtime } from "../../framework/runtime"
import { Standalone } from "../../services/standalone"
import { selfCommand } from "../../util/process"

type Control = (input: unknown) => Promise<unknown>

type MeetingFlags = {
  meet?: string
  title?: string
  speechProvider?: string
  speechModel?: string
  openaiProfile?: string
}

export default Runtime.handler(
  MeetingCommand,
  Effect.fn("cli.meeting")(function* (input) {
    const directory = path.resolve(Option.getOrElse(input.directory, () => process.cwd()))
    const { connectControl } = yield* Effect.promise(() => import("@ycoding-ai/meeting/discovery"))
    const flags: MeetingFlags = {
      meet: Option.getOrUndefined(input.meet),
      title: Option.getOrUndefined(input.title),
      speechProvider: Option.getOrUndefined(input.speechProvider),
      speechModel: Option.getOrUndefined(input.speechModel),
      openaiProfile: Option.getOrUndefined(input.openaiProfile),
    }
    const oneShot =
      input.status ||
      input.catchup ||
      Option.isSome(input.ask) ||
      input.summarizeKnowledge ||
      Option.isSome(input.approveProposal) ||
      Option.isSome(input.rejectProposal)
    if (oneShot) {
      if ((Option.isSome(input.approveProposal) || Option.isSome(input.rejectProposal)) && !input.confirm)
        throw new Error("Approving or rejecting a knowledge proposal requires --confirm")
      const attached = yield* Effect.promise(() => reachable(() => connectControl(directory)))
      if (!attached) throw new Error(`No meeting runtime is active for ${directory}`)
      yield* Effect.tryPromise(() => runOneShot(attached, input))
      return
    }
    const attached = yield* Effect.promise(() => reachable(() => connectControl(directory)))
    if (attached) {
      yield* present(attached, input.open, `Using the meeting runtime already running for ${directory}`, flags)
      return
    }

    const endpoint = yield* Standalone.start({ command: [...selfCommand(), "serve", "--meeting"] })
    const client = YCoding.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    yield* Effect.tryPromise(() => client.agent.list({ location: { directory } }))
    const control = yield* Effect.tryPromise(() => controllable(() => connectControl(directory)))
    yield* Effect.addFinalizer(() => Effect.promise(() => finalize(control)))
    yield* present(control, input.open, `Meeting runtime started for ${directory}`, flags)
    process.stdout.write("Press Ctrl+C to stop recording, finalize the meeting and exit.\n")
    yield* Effect.never
  }, Effect.scoped),
)

async function runOneShot(
  control: Control,
  input: {
    status: boolean
    catchup: boolean
    ask: Option.Option<string>
    summarizeKnowledge: boolean
    approveProposal: Option.Option<string>
    rejectProposal: Option.Option<string>
  },
) {
  if (input.status) {
    const output = await command(control, { action: "status" })
    process.stdout.write(`${formatStatus(output)}\n`)
    return
  }
  if (input.catchup) {
    const output = await command(control, { action: "catchup" })
    process.stdout.write(`${formatAnswer(output)}\n`)
    return
  }
  if (Option.isSome(input.ask)) {
    const output = await command(control, { action: "ask", question: input.ask.value })
    process.stdout.write(`${formatAnswer(output)}\n`)
    return
  }
  if (input.summarizeKnowledge) {
    const output = await command(control, { action: "knowledge-summarize" })
    process.stdout.write(`${formatProposals(output)}\n`)
    return
  }
  if (Option.isSome(input.approveProposal)) {
    const output = await command(control, { action: "approve", proposalID: input.approveProposal.value })
    process.stdout.write(`${formatProposals(output)}\n`)
    return
  }
  if (Option.isSome(input.rejectProposal)) {
    const output = await command(control, { action: "reject", proposalID: input.rejectProposal.value })
    process.stdout.write(`${formatProposals(output)}\n`)
    return
  }
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback
}

function formatStatus(output: unknown): string {
  if (!record(output)) return JSON.stringify(output)
  const meeting = record(output.meeting) ? output.meeting : undefined
  const health = record(output.health) ? output.health : undefined
  const lines = [
    meeting
      ? `Meeting: ${textOf(meeting.title ?? meeting.id, "unknown")} (${textOf(meeting.status, "unknown")})`
      : "Meeting: none selected",
  ]
  if (meeting && record(meeting.meet) && typeof meeting.meet.url === "string") lines.push(`Meet: ${meeting.meet.url}`)
  if (health)
    lines.push(`Health: ${textOf(health.status, "unknown")} ${textOf(health.provider)}/${textOf(health.model)}`)
  if (Array.isArray(output.proposals)) lines.push(`Proposals: ${output.proposals.length}`)
  if (Array.isArray(output.segments)) lines.push(`Segments: ${output.segments.length}`)
  return lines.join("\n")
}

function formatAnswer(output: unknown): string {
  if (record(output) && typeof output.answer === "string") return output.answer
  if (record(output) && typeof output.error === "string") return `Error: ${output.error}`
  return formatStatus(output)
}

function formatProposals(output: unknown): string {
  if (!record(output) || !Array.isArray(output.proposals)) return formatStatus(output)
  if (!output.proposals.length) return "Proposals: none"
  return output.proposals
    .map((proposal) =>
      record(proposal)
        ? `Proposal ${textOf(proposal.id)}: ${textOf(proposal.operation)} ${textOf(proposal.server)}/${textOf(proposal.target)} (${textOf(proposal.status)})`
        : JSON.stringify(proposal),
    )
    .join("\n")
}

const present = Effect.fnUntraced(function* (
  control: Control,
  open: boolean,
  heading: string,
  flags: MeetingFlags = {},
) {
  if (flags.speechProvider || flags.speechModel || flags.openaiProfile) {
    const current = yield* Effect.tryPromise(() => command(control, { action: "config" }))
    if (record(current) && record(current.config)) {
      const config = current.config
      const transcription = record(config.transcription) ? config.transcription : {}
      yield* Effect.tryPromise(() =>
        command(control, {
          action: "configure",
          config: {
            ...config,
            transcription: {
              ...transcription,
              ...(flags.speechProvider ? { provider: flags.speechProvider } : {}),
              ...(flags.speechModel ? { model: flags.speechModel } : {}),
              ...(flags.openaiProfile ? { openaiProfile: flags.openaiProfile } : {}),
            },
          },
        }),
      )
    }
  }
  const status = meetingStatus(yield* Effect.tryPromise(() => command(control, { action: "status" })))
  if (!["ready", "recording", "stopping"].includes(status ?? ""))
    yield* Effect.tryPromise(() =>
      command(control, {
        action: "start",
        ...(flags.meet ? { meet: flags.meet } : {}),
        ...(flags.title ? { title: flags.title } : {}),
      }),
    )
  else if (flags.meet) yield* Effect.tryPromise(() => command(control, { action: "set-meet", meet: flags.meet }))
  const url = viewURL(yield* Effect.tryPromise(() => command(control, { action: "view" })))
  const ownerURL = viewURL(yield* Effect.tryPromise(() => command(control, { action: "owner-view" })))
  process.stdout.write(
    [
      heading,
      `Live page: ${url}`,
      `Owner settings: ${ownerURL}`,
      "Keep the owner settings link private; it grants model and connector configuration access.",
      "Start recording from the live page after choosing audio and confirming consent.",
      "",
    ].join("\n"),
  )
  if (!open) return
  const { default: openURL } = yield* Effect.promise(() => import("open"))
  yield* Effect.tryPromise(() => openURL(ownerURL))
})

async function command(control: Control, input: unknown) {
  const output = await control(input)
  if (record(output) && typeof output.error === "string") throw new Error(output.error)
  return output
}

function meetingStatus(output: unknown) {
  if (record(output) && record(output.meeting) && typeof output.meeting.status === "string")
    return output.meeting.status
  return undefined
}

function viewURL(output: unknown) {
  if (record(output) && typeof output.url === "string") return output.url
  throw new Error("The meeting runtime did not return a live page address")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function reachable(connect: () => Promise<Control>) {
  const control = await connect().catch(() => undefined)
  if (!control) return undefined
  return control({ action: "status" }).then(
    () => control,
    () => undefined,
  )
}

async function controllable(connect: () => Promise<Control>) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const control = await reachable(connect)
    if (control) return control
    await setTimeout(250)
  }
  throw new Error("The meeting runtime did not start within 60 seconds; check the YCoding log for plugin errors")
}

async function finalize(control: Control) {
  const status = await command(control, { action: "status" }).then(meetingStatus, () => undefined)
  if (status !== "recording") return
  process.stdout.write("Stopping recording and finalizing the meeting…\n")
  await Promise.race([command(control, { action: "stop" }), setTimeout(120_000)]).catch((error: unknown) => {
    process.stderr.write(`Meeting stop failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}
