import type { CcaAuthorizationGrant, CcaAuthorizationInput, CcaScopeFor } from "@ycoding-ai/core/cca/executor"
import type { CcaTranscript } from "@ycoding-ai/core/cca/transcript"
import type { NativeDots } from "@ycoding-ai/core/dots/native"

export function fixedScopeFor(
  roots: readonly string[],
  authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>,
): CcaScopeFor {
  const scope = { sessionID: "ses_cca_fixed_scope", roots, authorization: { authorize }, close: async () => {} }
  return async () => scope
}

export const unrecordedTranscript: CcaTranscript.Recorder = {
  process: () => ({ output: () => {}, ended: () => {} }),
  read: () => {},
  write: () => {},
  http: () => {},
  denied: () => {},
  flush: async () => {},
}

export const unexpectedExecutorHost: Pick<
  NativeDots.Host,
  "threadScope" | "unattributedScope" | "projectCatalog" | "assignProject" | "prepareWorkspace"
> = {
  threadScope: async () => { throw new Error("Unexpected executor scope") },
  unattributedScope: async () => { throw new Error("Unexpected executor scope") },
  projectCatalog: async () => { throw new Error("Unexpected task-workspace request") },
  assignProject: async () => { throw new Error("Unexpected task-workspace request") },
  prepareWorkspace: async () => { throw new Error("Unexpected task-workspace request") },
}

export const idleDurableConnector = () => {
  let readyState = 0
  return {
    get readyState() { return readyState },
    on: () => undefined,
    send: () => { throw new Error("Unexpected durable send") },
    ping: () => {},
    close: () => { readyState = 3 },
    terminate: () => { readyState = 3 },
  }
}

const conversationUnavailable = async () => ({ ok: false as const, problem: "durable-unavailable" as const })
export const unavailableConversation = {
  threads: conversationUnavailable, taskUpdates: conversationUnavailable, read: conversationUnavailable, send: conversationUnavailable,
  interrupt: conversationUnavailable, resume: conversationUnavailable, requests: conversationUnavailable, respond: conversationUnavailable,
}
