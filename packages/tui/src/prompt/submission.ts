import type {
  LocationRef,
  ModelDaybreak,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageUser,
  SessionPendingInfo,
  SessionPendingUser,
  YCodingClient,
  YCodingEvent,
} from "@ycoding-ai/client"
import { createSignal } from "solid-js"
import type { PromptInfo } from "./history"
import type { promptSkillMetadata } from "./skill"
import { projectedPromptInput } from "./codec"
import type { SessionSubmissionRetry, YoloLevel } from "../util/session-autonomy"
import { submitPrompt } from "../component/prompt/prompt-admission"
import { errorMessage } from "../util/error"
import { isConflictError, isInvalidRequestError } from "@ycoding-ai/client"

export type PromptSubmissionPayload = {
  inputText: string
  files: PromptInfo["files"]
  agents: PromptInfo["agents"]
  metadata: ReturnType<typeof promptSkillMetadata>
  mode: NonNullable<PromptInfo["mode"]>
  agentID: string
  daybreak?: ModelDaybreak
  autonomy?: { yolo: YoloLevel; goal?: string }
  model: ModelRef
  modelSelectionPending: boolean
  editor?: { key: string; text: string }
  history: PromptInfo
  cursor: number
}

type Submission = {
  input: SessionSubmissionRetry<PromptSubmissionPayload>
  location: LocationRef
  skillOnly?: string
  steerNow?: boolean
  created: number
  state: "queued" | "sending" | "attention"
  phase: string
  error?: string
  completed: Set<string>
  admitted?: SessionPendingUser
  consumed: boolean
  consumedMessage?: SessionMessageUser
  discarded?: boolean
  cleanup: () => Promise<void>
  onCommitted?: () => void
  onAdmitted?: (history: PromptInfo) => Promise<void>
  onDiscarded?: () => Promise<void>
  command?: { name: string; arguments: string }
}

export function createPromptSubmissions(input: {
  api: () => YCodingClient
  admitted: (pending: SessionPendingInfo) => void
  created?: (session: SessionInfo) => void
}) {
  const [entries, setEntries] = createSignal<Submission[]>([])
  const running = new Set<string>()
  const requests = new Set<AbortController>()
  const gates = new Map<string, (pending?: SessionPendingUser) => void>()
  let disposed = false

  function update(entry: Submission, value: Partial<Submission>) {
    Object.assign(entry, value)
    setEntries((current) => [...current])
  }

  async function request<T>(
    entry: Submission,
    key: string,
    send: (signal: AbortSignal) => Promise<T>,
    event?: (pending?: SessionPendingUser) => T,
  ) {
    const controller = new AbortController()
    requests.add(controller)
    const gateKey = `${entry.input.sessionID}:${key}`
    const outcome = new Promise<T>((resolve, reject) => {
      if (event)
        gates.set(gateKey, (pending) => {
          if (entry.consumed) {
            reject(new Error("Input already consumed"))
            controller.abort()
            return
          }
          resolve(event(pending))
          controller.abort()
        })
      send(AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])).then(resolve, reject)
    })
    try {
      return await outcome
    } finally {
      gates.delete(gateKey)
      requests.delete(controller)
    }
  }

  async function run(entry: Submission) {
    const submission = entry.input
    const payload = submission.payload
    const sessionID = submission.sessionID
    update(entry, { state: "sending" })
    if (entry.consumed || entry.discarded) {
      if (entry.completed.has("cleanup")) return
      if (entry.discarded) await entry.onDiscarded?.()
      if (!entry.discarded) {
        const canonical = entry.consumedMessage ?? entry.admitted?.data
        if (canonical)
          payload.history.files = projectedPromptInput(canonical).files?.map((file, index) => ({
            ...file,
            mention: payload.files?.[index]?.mention ?? file.mention,
          }))
        if (!entry.completed.has("history")) await entry.onAdmitted?.(payload.history)
        entry.completed.add("history")
      }
      update(entry, { phase: "Releasing attachments" })
      await entry.cleanup()
      entry.completed.add("cleanup")
      return
    }
    if (!submission.creationConfirmed) {
      update(entry, { phase: "Creating session" })
      const session = await request(entry, "create", (signal) =>
        input
          .api()
          .session.create(
            { id: sessionID, location: entry.location, agent: payload.agentID, model: payload.model },
            { signal },
          ),
      )
      submission.creationConfirmed = true
      input.created?.(session)
    }
    if (
      payload.autonomy &&
      (payload.autonomy.yolo > 0 || payload.autonomy.goal !== undefined) &&
      !entry.completed.has("autonomy")
    ) {
      update(entry, { phase: "Setting autonomy" })
      const autonomy =
        payload.autonomy.goal === undefined
          ? { yolo: payload.autonomy.yolo }
          : { yolo: payload.autonomy.yolo, goal: payload.autonomy.goal }
      await request(entry, "autonomy", (signal) =>
        input.api().session.autonomy.set({ sessionID, payload: autonomy }, { signal }),
      )
      entry.completed.add("autonomy")
    }
    if (payload.daybreak && !entry.completed.has("daybreak")) {
      update(entry, { phase: "Selecting Daybreak" })
      const daybreak = payload.daybreak
      await request(entry, "daybreak", (signal) =>
        input.api().session.daybreak.set({ sessionID, daybreak }, { signal }),
      )
      entry.completed.add("daybreak")
    }
    if (entry.skillOnly) {
      update(entry, { phase: "Loading skill" })
      await request(entry, "standalone", (signal) =>
        input.api().session.skill({ id: submission.skillIDs[0], sessionID, skill: entry.skillOnly! }, { signal }),
      )
      return
    }
    if (!entry.admitted && (!entry.command || payload.modelSelectionPending)) {
      update(entry, { phase: "Checking session" })
      const session = await request(entry, "session", (signal) => input.api().session.get({ sessionID }, { signal }))
      if (!entry.command && session.agent !== payload.agentID) {
        update(entry, { phase: "Selecting agent" })
        await request(entry, "agent", (signal) =>
          input.api().session.switchAgent({ sessionID, agent: payload.agentID }, { signal }),
        )
      }
      if (!entry.command && session.revert && !entry.completed.has("revert")) {
        update(entry, { phase: "Committing revert" })
        await request(entry, "revert", (signal) => input.api().session.revert.commit({ sessionID }, { signal }))
        entry.completed.add("revert")
      }
      const modelMatches =
        session.model?.providerID === payload.model.providerID &&
        session.model.id === payload.model.id &&
        session.model.variant === payload.model.variant &&
        session.model.profile === payload.model.profile
      if (entry.completed.has("model") && payload.model.profile !== undefined && !modelMatches)
        throw new Error("The Session model changed while this prompt was pending; select the model again before retrying")
      if (payload.modelSelectionPending && (!entry.completed.has("model") || (payload.model.profile === undefined && !modelMatches))) {
        update(entry, { phase: "Switching model" })
        await request(entry, "model", (signal) =>
          input.api().session.switchModel({ sessionID, model: payload.model }, { signal }),
        )
        entry.completed.add("model")
      }
      if (payload.editor && !entry.command && !entry.completed.has("editor")) {
        update(entry, { phase: "Sending editor context" })
        await request(entry, "editor", (signal) =>
          input
            .api()
            .session.synthetic(
              { id: submission.syntheticID, sessionID, text: payload.editor!.text, resume: false },
              { signal },
            ),
        )
        entry.completed.add("editor")
      }
    }
    const result = await submitPrompt({
      prompt: async (resume) => {
        if (!resume && entry.admitted) return entry.admitted
        if (resume && entry.consumed) return entry.admitted!
        if (resume && entry.steerNow && !entry.completed.has("interrupt")) {
          await request(entry, "interrupt", (signal) => input.api().session.interrupt({ sessionID }, { signal }))
          entry.completed.add("interrupt")
        }
        if (!resume && entry.command)
          return request(
            entry,
            submission.promptID,
            (signal) =>
              input.api().session.command(
                {
                  id: submission.promptID,
                  sessionID,
                  command: entry.command!.name,
                  arguments: entry.command!.arguments,
                  agent: payload.agentID,
                  files: payload.files,
                  agents: payload.agents,
                  resume: false,
                  ...(payload.modelSelectionPending ? { model: payload.model } : {}),
                },
                { signal },
              ),
            (pending) => pending!,
          )
        return request(
          entry,
          resume ? "wake" : submission.promptID,
          (signal) =>
            input.api().session.prompt(
              {
                id: submission.promptID,
                sessionID,
                text: resume && entry.command ? entry.admitted!.data.text : payload.inputText,
                files: payload.files,
                agents: payload.agents,
                metadata: resume && entry.command ? entry.admitted!.data.metadata : payload.metadata,
                resume,
              },
              { signal },
            ),
          (pending) => pending ?? entry.admitted!,
        )
      },
      onPhase: (phase) =>
        update(entry, {
          phase: phase.type === "admission" ? "Sending prompt" : "Prompt admitted · waking session",
        }),
      onAdmitted: async (admitted) => {
        entry.admitted = admitted
        payload.files = projectedPromptInput(admitted.data).files?.map((file, index) => ({
          ...file,
          mention: payload.files?.[index]?.mention ?? file.mention,
        }))
        payload.history.files = payload.files
        if (!entry.consumed) input.admitted(admitted)
        if (!entry.completed.has("history")) await entry.onAdmitted?.(payload.history)
        entry.completed.add("history")
        if (entry.completed.has("cleanup")) return
        await entry.cleanup()
        entry.completed.add("cleanup")
      },
    })
    if (result.wakeError !== undefined) throw result.wakeError
  }

  function drain(sessionID: string) {
    if (disposed || running.has(sessionID)) return
    const entry = entries().find((item) => item.input.sessionID === sessionID)
    if (!entry || entry.state === "attention") return
    running.add(sessionID)
    run(entry)
      .catch((error: unknown) => {
        if (entry.consumed) return run(entry)
        throw error
      })
      .then(() => {
        if (!entry.discarded) entry.onCommitted?.()
        setEntries((current) => current.filter((item) => item !== entry))
      })
      .catch((error: unknown) => {
        if (!disposed)
          update(entry, {
            state: "attention",
            error: errorMessage(error),
            phase: `${
              entry.admitted
                ? "Prompt admitted · wake unresolved"
                : entry.phase === "Sending prompt" && isConflictError(error)
                  ? "Prompt ID conflict"
                  : entry.phase === "Sending prompt" && isInvalidRequestError(error) && error.field === "files"
                    ? "Attachment rejected"
                    : entry.phase + " unresolved"
            } · Retry send`,
          })
      })
      .finally(() => {
        running.delete(sessionID)
        drain(sessionID)
      })
  }

  function reconcileAdmission(pending: SessionPendingUser) {
    const entry = entries().find(
      (item) => item.input.sessionID === pending.sessionID && item.input.promptID === pending.id,
    )
    if (!entry) return
    const confirmed = entry.admitted !== undefined
    entry.admitted = pending
    gates.get(`${pending.sessionID}:${pending.id}`)?.(pending)
    if (entry.state === "attention" && !confirmed) {
      update(entry, { state: "queued", phase: "Prompt admitted" })
      drain(pending.sessionID)
    }
  }

  function reconcileConsumed(sessionID: string, id: string, message?: SessionMessageUser) {
    const entry = entries().find((item) => item.input.sessionID === sessionID && item.input.promptID === id)
    if (!entry) return
    entry.consumed = true
    entry.consumedMessage = message ?? entry.consumedMessage
    gates.get(`${sessionID}:${id}`)?.()
    gates.get(`${sessionID}:wake`)?.()
    if (!running.has(sessionID)) {
      update(entry, { state: "queued" })
      drain(sessionID)
    }
  }

  return {
    list(sessionID?: string) {
      return entries().filter((entry) => sessionID === undefined || entry.input.sessionID === sessionID)
    },
    message(sessionID: string, id: string): SessionMessageInfo | undefined {
      const entry = entries().find(
        (item) => item.input.sessionID === sessionID && item.input.promptID === id && !item.skillOnly,
      )
      if (!entry) return undefined
      return {
        id,
        type: "user",
        text: entry.input.payload.inputText,
        files: [],
        metadata: entry.input.payload.metadata,
        time: { created: entry.created },
      }
    },
    dispatch(
      submission: SessionSubmissionRetry<PromptSubmissionPayload>,
      options: {
        location: LocationRef
        skillOnly?: string
        steerNow?: boolean
        cleanup: () => Promise<void>
        onCommitted?: () => void
        onAdmitted?: (history: PromptInfo) => Promise<void>
        onDiscarded?: () => Promise<void>
        command?: { name: string; arguments: string }
      },
    ) {
      if (entries().some((entry) => entry.input.promptID === submission.promptID)) return
      setEntries((current) => [
        ...current,
        {
          input: submission,
          ...options,
          created: Date.now(),
          state: "queued",
          phase: "Queued for send",
          completed: new Set(),
          consumed: false,
        },
      ])
      drain(submission.sessionID)
    },
    retry(sessionID: string, promptID: string) {
      const entry = entries().find((item) => item.input.sessionID === sessionID && item.input.promptID === promptID)
      if (!entry || entry.state !== "attention") return
      update(entry, { state: "queued", phase: "Retrying send" })
      drain(sessionID)
    },
    discard(sessionID: string, promptID: string) {
      const entry = entries().find((item) => item.input.sessionID === sessionID && item.input.promptID === promptID)
      if (!entry || entry.state !== "attention") return
      update(entry, { discarded: true, state: "queued", phase: "Discarding local recovery" })
      drain(sessionID)
    },
    observe(event: YCodingEvent) {
      if (event.type === "session.input.admitted" && event.data.input.type === "user") {
        const pending: SessionPendingUser = {
          id: event.data.inputID,
          sessionID: event.data.sessionID,
          admittedSeq: event.durable.seq,
          timeCreated: event.created,
          ...event.data.input,
        }
        reconcileAdmission(pending)
      }
      if (event.type === "session.input.consumed") {
        event.data.inputIDs.forEach((id) => reconcileConsumed(event.data.sessionID, id))
      }
    },
    reconcile(sessionID: string, messages: SessionMessageInfo[], pending: SessionPendingInfo[]) {
      pending.forEach((item) => {
        if (item.type === "user") reconcileAdmission(item)
      })
      messages.forEach((message) => {
        if (message.type === "user" && message.time.consumed !== undefined)
          reconcileConsumed(sessionID, message.id, message)
      })
    },
    dispose() {
      disposed = true
      requests.forEach((controller) => controller.abort())
    },
  }
}
