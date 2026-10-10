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

export default Runtime.handler(
  MeetingCommand,
  Effect.fn("cli.meeting")(function* (input) {
    const directory = path.resolve(Option.getOrElse(input.directory, () => process.cwd()))
    const { connectControl } = yield* Effect.promise(() => import("@ycoding-ai/meeting/discovery"))
    const attached = yield* Effect.promise(() => reachable(() => connectControl(directory)))
    if (attached)
      return yield* present(attached, input.open, `Using the meeting runtime already running for ${directory}`)

    const endpoint = yield* Standalone.start({ command: [...selfCommand(), "serve", "--meeting"] })
    const client = YCoding.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    yield* Effect.tryPromise(() => client.agent.list({ location: { directory } }))
    const control = yield* Effect.tryPromise(() => controllable(() => connectControl(directory)))
    yield* Effect.addFinalizer(() => Effect.promise(() => finalize(control)))
    yield* present(control, input.open, `Meeting runtime started for ${directory}`)
    process.stdout.write("Press Ctrl+C to stop recording, finalize the meeting and exit.\n")
    return yield* Effect.never
  }, Effect.scoped),
)

const present = Effect.fnUntraced(function* (control: Control, open: boolean, heading: string) {
  const status = meetingStatus(yield* Effect.tryPromise(() => command(control, { action: "status" })))
  if (!["ready", "recording", "stopping"].includes(status ?? ""))
    yield* Effect.tryPromise(() => command(control, { action: "start" }))
  const url = viewURL(yield* Effect.tryPromise(() => command(control, { action: "view" })))
  process.stdout.write(
    [
      heading,
      `Live page: ${url}`,
      "Pair YCoding Meet capture from the live page, then start recording from the extension on your Meet tab.",
      "",
    ].join("\n"),
  )
  if (!open) return
  const { default: openURL } = yield* Effect.promise(() => import("open"))
  yield* Effect.tryPromise(() => openURL(url))
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
