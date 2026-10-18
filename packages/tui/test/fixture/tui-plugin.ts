import type { Context } from "@ycoding-ai/plugin/tui/context"

type Options = {
  readonly attention?: Partial<Context["attention"]>
  readonly client?: Partial<Context["client"]>
  readonly ui?: Partial<Context["ui"]>
  readonly data?: {
    readonly on?: Context["data"]["on"]
    readonly session?: Partial<Context["data"]["session"]>
  }
}

const on = (() => () => {}) as Context["data"]["on"]

export function createTuiPluginContext(options: Options = {}) {
  // The fixture intentionally implements only Context surfaces used by notification tests.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    options: {},
    location: undefined,
    attention: {
      notify: async () => ({ ok: false, notification: false, sound: false }),
      soundboard: {
        registerPack: () => () => {},
        activate: () => false,
        current: () => "",
        list: () => [],
      },
      ...options.attention,
    },
    client: options.client ?? {},
    data: {
      on: options.data?.on ?? on,
      session: {
        get: () => undefined,
        ...options.data?.session,
      },
    },
    keymap: {},
    ui: {
      router: {
        register: () => { throw new Error("Unexpected route registration") },
        navigate: () => { throw new Error("Unexpected route navigation") },
        current: () => ({ type: "home" }),
      },
      slot: () => () => {},
      ...options.ui,
    },
  } as unknown as Context
}
