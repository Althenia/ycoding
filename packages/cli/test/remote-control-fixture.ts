import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { Schema } from "effect"
import { Session } from "@ycoding-ai/schema/session"
import type { RemoteControlBackend } from "../src/remote-control/app-server"

export const pendingRequest = (threadID: string, id = "request"): NativeDots.NativeRequest => ({
  id, threadID, turnID: "turn", itemID: "item", handle: {} as NativeDots.Candidate,
  questions: [{ id: "decision", header: "Decision", question: "Proceed?", isOther: false, isSecret: false, options: [{ label: "Reject", description: "Reject" }] }],
})

export const requestBackend = {
  readThread: async () => { throw Error("Unexpected history read") },
  pending: async () => [],
  settle: async () => {},
  subscribe: async () => () => {},
  retire: () => {},
} satisfies Pick<RemoteControlBackend, "readThread" | "pending" | "settle" | "subscribe" | "retire">

export const sessionInfo = (thread: { id: string; title?: string; directory: string; updatedAt?: number }): Session.Info => Schema.decodeUnknownSync(Session.Info)({
  id: thread.id, title: thread.title ?? "Test", projectID: "global", location: { directory: thread.directory },
  time: { created: 0, updated: (thread.updatedAt ?? 0) * 1_000 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

export const rootSnapshot = (thread: Parameters<typeof sessionInfo>[0]): NativeDots.RootSnapshot => ({ session: sessionInfo(thread), active: false, waiting: [] })

export function nativeHost(backend: RemoteControlBackend, credential = { access: "synthetic", accountID: "synthetic", key: "synthetic", profile: "fixture" }): NativeDots.Host {
  return {
    configuration: async () => ({ enabled: true, profile: credential.profile, credentialID: "credential", accountID: credential.accountID, accountGeneration: 1 }),
    credential: async () => ({ ...credential, credentialID: "credential", accountGeneration: 1 }),
    subscribeConfiguration: () => () => {},
    attach: async () => ({
      retire: () => {},
      channel: () => ({
        listRoots: backend.listThreads,
        getRoot: backend.getThread,
        readRoot: backend.readThread,
        createRoot: ({ inputID, directory, title }) => backend.createThread({ inputID, location: { directory }, title }),
        prompt: ({ rootID, ...input }) => backend.prompt(rootID, input),
        interrupt: backend.interrupt,
        pending: async (id) => [...await backend.pending(id)], settle: backend.settle, subscribe: backend.subscribe, retire: backend.retire,
        models: async () => (await backend.models()).map((model) => ({ ...model, providerID: model.providerID ?? "synthetic" })), skills: backend.skills,
      }),
    }),
  }
}
