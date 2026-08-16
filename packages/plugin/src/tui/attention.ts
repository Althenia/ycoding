export type When = "always" | "focused" | "blurred"

export const SoundNames = ["default", "question", "permission", "error", "done", "subagent_done"] as const
export type SoundName = (typeof SoundNames)[number]

export type Sound =
  | boolean
  | {
      readonly name?: SoundName
      readonly volume?: number
      readonly when?: When
    }

export type Notification = boolean | { readonly when?: When }

export type SoundPack = {
  readonly id: string
  readonly name?: string
  readonly sounds: Partial<Record<SoundName, string>>
}

export type SoundPackInfo = {
  readonly id: string
  readonly name?: string
  readonly active: boolean
  readonly builtin: boolean
}

export type Soundboard = {
  registerPack(pack: SoundPack): () => void
  activate(id: string, options?: { readonly persist?: boolean }): boolean
  current(): string
  list(): ReadonlyArray<SoundPackInfo>
}

export type NotifyInput = {
  readonly title?: string
  readonly message: string
  readonly notification?: Notification
  readonly sound?: Sound
}

export type NotifySkipReason =
  | "attention_disabled"
  | "empty_message"
  | "blurred"
  | "focused"
  | "focus_unknown"
  | "renderer_destroyed"

export type NotifyResult = {
  readonly ok: boolean
  readonly notification: boolean
  readonly sound: boolean
  readonly skipped?: NotifySkipReason
}

export type TuiAttention = {
  readonly notify: (input: NotifyInput) => Promise<NotifyResult>
  readonly soundboard: Soundboard
}
