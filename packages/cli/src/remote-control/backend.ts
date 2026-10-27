import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { RemoteControlBackend } from "./app-server"

export function createRemoteControlBackend(input: { readonly channel: NativeDots.Channel; readonly profile: string }): RemoteControlBackend {
  const channel = input.channel
  return {
    createThread: ({ location, title, inputID }) => channel.createRoot({ inputID, directory: location.directory, ...(title === undefined ? {} : { title }) }),
    getThread: channel.getRoot,
    listThreads: channel.listRoots,
    readThread: channel.readRoot,
    prompt: (rootID, prompt) => channel.prompt({ rootID, inputID: prompt.inputID, text: prompt.text, delivery: prompt.delivery }),
    interrupt: channel.interrupt,
    models: channel.models,
    skills: channel.skills,
    account: async () => ({ profile: input.profile }),
    pending: channel.pending,
    settle: channel.settle,
    subscribe: channel.subscribe,
    retire: channel.retire,
  }
}
