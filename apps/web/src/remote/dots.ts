import {
  readDotsTarget,
  type RemoteDotsTarget,
  type RemoteDotsStatus,
  type RemoteDotsSend,
  type RemoteDotsDelivery,
} from "@ycoding-ai/remote"
import type { RemoteLink, QueryScope } from "./queries"
import { uploadAttachments, assertRemoteRequestSize } from "./attachment-upload"

export const dotsDisabledMessage = "Dots is disabled for this Location."

export function dotsClient(link: RemoteLink, scope: QueryScope, sessionID: string) {
  const request = async (
    operation:
      | "session.dots.targets"
      | "session.dots.status"
      | "session.dots.bind"
      | "session.dots.send"
      | "session.dots.pause"
      | "session.dots.resume",
    input?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted()
    const outcome = await link.request(scope, operation, {
      sessionID,
      signal,
      ...(input === undefined ? {} : { input }),
    })
    signal?.throwIfAborted()
    if (outcome.status !== "ok")
      throw new Error(
        outcome.status === "unavailable" ? "The Dots destination lost its machine connection." : outcome.error.message,
      )
    if (typeof outcome.value !== "object" || outcome.value === null) return undefined
    return Reflect.get(outcome.value, "data")
  }
  return {
    targets: async (profile: string) => {
      const value: unknown = await request("session.dots.targets", { profile })
      if (!Array.isArray(value) || !value.every((target) => readDotsTarget(target)))
        throw new Error("Invalid Dots destination response.")
      return value.map((target) => readDotsTarget(target)!)
    },
    status: async (signal?: AbortSignal) => readStatus(await request("session.dots.status", undefined, signal)),
    bind: async (target: RemoteDotsTarget) => readStatus(await request("session.dots.bind", { ...target })),
    send: async (input: RemoteDotsSend, signal?: AbortSignal) => {
      const status = readStatus(await request("session.dots.status", undefined, signal))
      if (!status.enabled) throw new Error(dotsDisabledMessage)
      if (
        !status.target ||
        (["profile", "dotID", "threadID", "generation"] as const).some(
          (key) => status.target?.[key] !== input.expectedTarget[key],
        )
      )
        throw new Error("The Dots destination changed. Confirm the destination before sending.")
      const files = input.files?.length
        ? await uploadAttachments({
            sessionID,
            files: input.files,
            signal,
            request: async (operation, options) => {
              if (operation !== "session.attachment.upload") throw new Error("Invalid Dots attachment operation.")
              return link.request(scope, operation, options)
            },
          })
        : undefined
      const payload = {
        id: input.id,
        text: input.text,
        expectedTarget: input.expectedTarget,
        ...(input.causalMessageID === undefined ? {} : { causalMessageID: input.causalMessageID }),
        ...(files === undefined ? {} : { files }),
      }
      assertRemoteRequestSize("session.dots.send", sessionID, payload)
      return readDelivery(await request("session.dots.send", payload, signal))
    },
    pause: async (expectedTarget: RemoteDotsTarget) => readStatus(await request("session.dots.pause", { expectedTarget })),
    resume: async (expectedTarget: RemoteDotsTarget) => readStatus(await request("session.dots.resume", { expectedTarget })),
  }
}

function readStatus(value: unknown): RemoteDotsStatus {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Dots status response.")
  const enabled: unknown = Reflect.get(value, "enabled")
  const state: unknown = Reflect.get(value, "state")
  const target: unknown = Reflect.get(value, "target")
  const error: unknown = Reflect.get(value, "error")
  const runtimeState: unknown = Reflect.get(value, "runtimeState")
  if (typeof enabled !== "boolean") throw new Error("Invalid Dots enabled state.")
  if (state !== "disconnected" && state !== "connecting" && state !== "connected" && state !== "failed")
    throw new Error("Invalid Dots connection state.")
  const selected = readDotsTarget(target)
  if (target !== undefined && !selected) throw new Error("Invalid Dots target identity.")
  if (runtimeState !== undefined && runtimeState !== "paused" && runtimeState !== "unpaused" && runtimeState !== "unknown")
    throw new Error("Invalid Dots runtime state.")
  return { enabled, state, ...(selected ? { target: selected } : {}), ...(typeof error === "string" ? { error } : {}),
    ...(runtimeState === undefined ? {} : { runtimeState }) }
}

function readDelivery(value: unknown): RemoteDotsDelivery {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Dots delivery response.")
  const messageID: unknown = Reflect.get(value, "messageID")
  const status: unknown = Reflect.get(value, "status")
  const turnID: unknown = Reflect.get(value, "turnID")
  if (
    typeof messageID !== "string" ||
    !messageID ||
    (status !== "accepted" && status !== "unknown") ||
    (turnID !== undefined && typeof turnID !== "string")
  )
    throw new Error("Invalid Dots delivery identity.")
  return { messageID, status, ...(typeof turnID === "string" ? { turnID } : {}) }
}

export function createDotsCapabilityReader(input: {
  read: (signal: AbortSignal) => Promise<boolean>
  reset: () => void
  publish: (enabled: boolean) => void
}) {
  let fence = 0
  let reading: AbortController | undefined
  const stop = () => {
    fence++
    reading?.abort()
    reading = undefined
    input.publish(false)
    input.reset()
  }
  return {
    fence: () => fence,
    start(selected: boolean) {
      stop()
      if (!selected) return
      const generation = fence
      const controller = new AbortController()
      reading = controller
      void input.read(controller.signal).then(
        (value) => value === true,
        () => false,
      ).then((value) => {
        if (generation === fence) input.publish(value)
      })
    },
    disable: stop,
  }
}
