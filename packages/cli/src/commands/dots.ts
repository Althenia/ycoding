import { Argument, Flag } from "effect/unstable/cli"
import type { Dots } from "@ycoding-ai/schema/dots"
import { Spec } from "../framework/spec"

const server = Flag.string("server").pipe(
  Flag.withDescription("Connect to a server URL instead of the background service"),
  Flag.optional,
)
const thread = Argument.string("thread").pipe(Argument.withDescription("Dot thread ID"))
const page = {
  cursor: Flag.string("cursor").pipe(Flag.withDescription("Continue from a cursor printed by an earlier page"), Flag.optional),
  limit: Flag.integer("limit").pipe(Flag.withDescription("Number of entries to read (1-50)"), Flag.optional),
}

export const DotsCommand = Spec.make("dots", {
  description: "Manage this computer's Dots connection",
  commands: [
    Spec.make("attach", {
      description: "Attach this computer to your Dot",
      params: {
        server: Flag.string("server").pipe(
          Flag.withDescription("Connect to a server URL instead of the background service"),
          Flag.optional,
        ),
        yes: Flag.boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription("Confirm attaching this computer to the Dot without asking"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("detach", {
      description: "Detach this computer from your Dot",
      params: {
        server: Flag.string("server").pipe(
          Flag.withDescription("Connect to a server URL instead of the background service"),
          Flag.optional,
        ),
        yes: Flag.boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription("Confirm detaching this computer from the Dot without asking"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("remove", {
      description: "Remove this computer from your ChatGPT account and turn Dots access off",
      params: {
        server: Flag.string("server").pipe(
          Flag.withDescription("Connect to a server URL instead of the background service"),
          Flag.optional,
        ),
        yes: Flag.boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription("Confirm removing this computer from your ChatGPT account without asking"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("threads", {
      description: "List your Dot's threads and tasks",
      params: { server },
    }),
    Spec.make("tasks", {
      description: "List your Dot's tasks, or one task's updates",
      params: {
        server,
        task: Argument.string("task").pipe(Argument.withDescription("Task ID whose updates to read"), Argument.optional),
        ...page,
      },
    }),
    Spec.make("read", {
      description: "Read a Dot thread transcript, newest turns first",
      params: { server, thread, ...page },
    }),
    Spec.make("send", {
      description: "Send a message to a Dot thread; it steers an active turn unless queued",
      params: {
        server,
        thread,
        text: Argument.string("text").pipe(Argument.withDescription("Message text")),
        queue: Flag.boolean("queue").pipe(Flag.withDescription("Queue the message after the active turn instead of steering it; ChatGPT.app sends Dot messages without queueing, and when ChatGPT rejects a queued message the command prints the rejection reason"), Flag.withDefault(false)),
      },
    }),
    Spec.make("interrupt", {
      description: "Interrupt the active turn of a Dot thread",
      params: { server, thread, turn: Argument.string("turn").pipe(Argument.withDescription("Turn ID to interrupt")) },
    }),
    Spec.make("resume", {
      description: "Resume your Dot's runtime",
      params: { server },
    }),
    Spec.make("requests", {
      description: "List the approval and input requests pending on a Dot thread",
      params: { server, thread },
    }),
    Spec.make("respond", {
      description: "Answer one pending Dot thread request",
      params: {
        server,
        thread,
        request: Argument.string("request").pipe(Argument.withDescription("Request ID from dots requests")),
        decision: Flag.choice("decision", ["accept", "acceptForSession", "decline", "cancel"]).pipe(
          Flag.withDescription("Decision for an approval request"),
          Flag.optional,
        ),
        answers: Flag.string("answers").pipe(
          Flag.withDescription('Answers for an input request as JSON, for example {"question-id":["answer"]}'),
          Flag.optional,
        ),
      },
    }),
  ],
})

export const dotsAttachWarning =
  "This keeps your other computers connected. Choose which computer runs a Dots task in ChatGPT."

export const dotsDetachWarning =
  "This computer stops running Dots tasks. Your other computers stay connected."

export const dotsRemoveWarning =
  "This deletes this computer from your ChatGPT account and turns Dots access off. Turning access on again enrolls it as a new computer."

export function dotsComputerLine(status: Dots.NativeStatus) {
  const computer = status.computer ?? { state: "unavailable" as const }
  return `Computer: ${computer.state}${status.computer?.name === undefined ? "" : ` · ${status.computer.name}`}${computer.message === undefined ? "" : ` (${computer.message})`}`
}

export function dotsAttachConfirmed(answer: string | undefined) {
  return answer !== undefined && /^\s*y(es)?\s*$/i.test(answer)
}

const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function dotsThreadLine(thread: Dots.ConversationThread) {
  return [`Thread ${thread.threadID} ${thread.kind}`, thread.status, thread.name ?? (thread.preview === undefined ? undefined : oneLine(thread.preview))]
    .filter((part) => part !== undefined).join(" · ")
}

export function dotsTaskLine(task: Dots.Task) {
  return [`Task ${task.taskID} ${task.status}`, oneLine(task.title), task.latestUpdate === undefined ? undefined : oneLine(task.latestUpdate)]
    .filter((part) => part !== undefined && part !== "").join(" · ")
}

function itemLine(item: Dots.TranscriptItem) {
  if (item.type === "userMessage") return `  user: ${item.text}${item.truncated ? " …" : ""}`
  if (item.type === "agentMessage") return `  agent: ${item.text}${item.truncated ? " …" : ""}`
  if (item.type === "commandExecution") return `  command: ${oneLine(item.command, 500)}${item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`}`
  if (item.type === "fileChange") return `  files: ${item.paths.join(", ")}`
  return `  ${item.itemType}`
}

export function dotsTranscriptLines(transcript: Dots.Transcript) {
  const lines = transcript.turns.flatMap((turn) => [`Turn ${turn.turnID}${turn.status === undefined ? "" : ` ${turn.status}`}`, ...turn.items.map(itemLine)])
  return transcript.nextCursor === undefined ? lines : [...lines, `Older turns: --cursor ${transcript.nextCursor}`]
}

export function dotsRequestLines(request: Dots.PendingRequest) {
  return [
    `Request ${request.requestID} ${request.kind}${request.turnID === undefined ? "" : ` · turn ${request.turnID}`}`,
    ...(request.reason === undefined ? [] : [`  reason: ${oneLine(request.reason, 500)}`]),
    ...(request.command === undefined ? [] : [`  command: ${oneLine(request.command, 500)}`]),
    ...(request.cwd === undefined ? [] : [`  cwd: ${request.cwd}`]),
    ...(request.questions ?? []).flatMap((question) => [
      `  question ${question.questionID}: ${oneLine(question.question, 500)}`,
      ...(question.options ?? []).map((option) => `    - ${option.label}${option.description === undefined ? "" : `: ${oneLine(option.description)}`}`),
    ]),
  ]
}
