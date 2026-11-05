import { Schema } from "effect"
import { TuiKeybind } from "./keybind"

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>
export type AttentionSoundPaths = Partial<Record<AttentionSoundName, string>>

export const CoordinationNotifications = Schema.Struct({
  scope: Schema.Literals(["all", "coordinators", "selected"]),
  sessionIDs: Schema.Array(Schema.String.check(Schema.isStartsWith("ses_"))).check(Schema.isMaxLength(128)).pipe(Schema.optional),
  categories: Schema.Array(Schema.Literals(["question", "permission", "review", "failure", "completion"])).check(Schema.isMaxLength(5)).pipe(Schema.optional),
})
export type CoordinationNotifications = typeof CoordinationNotifications.Type

export const Plugin = Schema.Union([
  Schema.String,
  Schema.Struct({
    package: Schema.String.annotate({ description: "Plugin package name or path" }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)).annotate({
      description: "Options passed to the plugin",
    }),
  }),
])

export const Info = Schema.Struct({
  theme: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String).annotate({ description: "Theme name" }),
      mode: Schema.optional(Schema.Literals(["system", "dark", "light"])).annotate({
        description: "Color mode; 'system' follows the terminal",
      }),
    }),
  ).annotate({ description: "Color theme settings" }),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides).annotate({ description: "Custom key bindings" }),
  plugins: Schema.optional(Schema.Array(Plugin)).annotate({
    description: "Ordered plugin enablement directives and external package declarations",
  }),
  leader: Schema.optional(
    Schema.Struct({
      timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Time in milliseconds to wait for a key after the leader key",
      }),
    }),
  ).annotate({ description: "Leader key behavior" }),
  scroll: Schema.optional(
    Schema.Struct({
      speed: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.001))).annotate({
        description: "Distance scrolled per input tick",
      }),
      acceleration: Schema.optional(Schema.Boolean).annotate({
        description: "Accelerate scrolling from repeated input",
      }),
    }),
  ).annotate({ description: "Scrolling behavior" }),
  attention: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({ description: "Enable attention alerts" }),
      notifications: Schema.optional(Schema.Boolean).annotate({ description: "Show system notifications" }),
      sound: Schema.optional(Schema.Boolean).annotate({ description: "Play attention sounds" }),
      volume: Schema.optional(
        Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
      ).annotate({ description: "Attention sound volume from 0 to 1" }),
      sound_pack: Schema.optional(Schema.String).annotate({ description: "Active attention sound pack ID" }),
      sounds: Schema.optional(Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String))).annotate({
        description: "Sound file overrides by attention event",
      }),
      coordination: CoordinationNotifications.pipe(Schema.optional),
    }),
  ).annotate({ description: "System notification and sound settings" }),
  diffs: Schema.optional(
    Schema.Struct({
      wrap: Schema.optional(Schema.Literals(["word", "none"])).annotate({
        description: "Line wrapping behavior in diff output",
      }),
      tree: Schema.optional(Schema.Boolean).annotate({ description: "Show the diff file tree" }),
      single: Schema.optional(Schema.Boolean).annotate({ description: "Show only the selected file patch" }),
      view: Schema.optional(Schema.Literals(["auto", "split", "unified"])).annotate({
        description: "Diff layout; 'auto' selects a layout from the available width",
      }),
    }),
  ).annotate({ description: "Diff presentation settings" }),
  terminal: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.Boolean).annotate({ description: "Update the terminal window title" }),
      copy_on_select: Schema.optional(Schema.Boolean).annotate({ description: "Copy selected terminal text" }),
    }),
  ).annotate({ description: "Terminal integration settings" }),
  prompt: Schema.optional(
    Schema.Struct({
      editor: Schema.optional(Schema.Boolean).annotate({
        description: "Include the active editor file or selection as prompt context",
      }),
      paste: Schema.optional(Schema.Literals(["compact", "full"])).annotate({
        description: "Display large pastes as compact placeholders or full text",
      }),
    }),
  ).annotate({ description: "Prompt input behavior" }),
  session: Schema.optional(
    Schema.Struct({
      sidebar: Schema.optional(Schema.Literals(["auto", "hide"])).annotate({
        description: "Session sidebar visibility; 'auto' shows it when space permits",
      }),
      scrollbar: Schema.optional(Schema.Boolean).annotate({ description: "Show the session transcript scrollbar" }),
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning by default",
      }),
      grouping: Schema.optional(Schema.Literals(["auto", "none"])).annotate({
        description: "Group related transcript items automatically or render each item separately",
      }),
    }),
  ).annotate({ description: "Session transcript presentation settings" }),
  hints: Schema.optional(
    Schema.Struct({
      onboarding: Schema.optional(Schema.Boolean).annotate({ description: "Show getting-started guidance" }),
    }),
  ).annotate({ description: "In-product guidance settings" }),
  debug: Schema.optional(
    Schema.Struct({
      devtools: Schema.optional(Schema.Boolean).annotate({ description: "Show the DevTools sidebar" }),
      timing: Schema.optional(Schema.Boolean).annotate({ description: "Show time-to-first-draw diagnostics" }),
    }),
  ).annotate({ description: "Debugging settings" }),
  animations: Schema.optional(Schema.Boolean).annotate({ description: "Enable interface animations" }),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable terminal mouse capture" }),
})
export type Info = Schema.Schema.Type<typeof Info>
