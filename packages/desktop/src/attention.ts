import type { YCodingEvent } from "@ycoding-ai/client"
import type { AttentionNotification } from "./contract"
import { eventSessionID } from "./event-refresh"

type DesktopSound = "permission" | "question" | "complete" | "failure"
const soundURLs: Record<DesktopSound, string> = {
  permission: new URL("../../tui/src/assets/audio/staplebops-06.mp3", import.meta.url).href,
  question: new URL("../../tui/src/assets/audio/bip-bop-03.mp3", import.meta.url).href,
  complete: new URL("../../tui/src/assets/audio/bip-bop-01.mp3", import.meta.url).href,
  failure: new URL("../../tui/src/assets/audio/nope-03.mp3", import.meta.url).href,
}

export function createDesktopAudio(create: (url: string) => Pick<HTMLAudioElement, "src" | "volume" | "play" | "pause"> = (url) => new Audio(url)) {
  let current: ReturnType<typeof create> | undefined
  const stop = () => { const audio = current; current = undefined; if (audio) { audio.pause(); audio.src = "" } }
  return {
    stop,
    async play(kind: DesktopSound, volume: number) {
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("Choose a volume between 0 and 1.")
      stop()
      if (volume === 0) return
      const audio = create(soundURLs[kind])
      current = audio
      audio.volume = volume
      try { await audio.play() }
      catch (error) { if (current === audio) { stop(); throw error } }
    },
  }
}

export function createDesktopAttention(options: {
  readonly enabled: () => boolean
  readonly notifications: () => boolean
  readonly sound: () => boolean
  readonly volume: () => number
  readonly play: (kind: DesktopSound, volume: number) => Promise<void>
  readonly focused: () => boolean
  readonly notify: (input: AttentionNotification) => Promise<void>
  readonly error: (cause: unknown) => void
}) {
  const delivered = new Set<string>()
  return {
    reset: () => delivered.clear(),
    event(event: YCodingEvent) {
      const kind = ["permission.asked", "question.asked", "form.created", "guardrail.asked"].includes(event.type) ? "request"
        : event.type === "session.execution.succeeded" ? "complete"
        : event.type === "session.execution.failed" ? "failure" : undefined
      if (!kind) return
      const data: unknown = "data" in event ? event.data : undefined
      const field = (value: unknown, name: string): unknown => value && typeof value === "object" ? Reflect.get(value, name) : undefined
      const requestID = field(data, "requestID") ?? field(data, "id") ?? field(field(data, "form"), "id")
      const key = `${event.type}:${eventSessionID(event) ?? ""}:${kind === "request" && typeof requestID === "string" ? requestID : event.id}`
      if (delivered.has(key)) return
      delivered.add(key)
      if (delivered.size > 256) delivered.delete(delivered.values().next().value!)
      if (!options.enabled()) return
      if (options.notifications() && !options.focused()) void options.notify({ kind, silent: true }).catch(options.error)
      if (options.sound()) void options.play(kind === "request" ? ["question.asked", "form.created"].includes(event.type) ? "question" : "permission" : kind, options.volume()).catch(options.error)
    },
  }
}
