import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { ConnectionState, DesktopAPI } from "./contract"

function subscribe<T>(event: string, callback: (value: T) => void) {
  let active = true
  const subscribed = listen<T>(event, ({ payload }) => { if (active) callback(payload) })
  return () => { active = false; void subscribed.then((stop) => stop()) }
}

export const desktop: DesktopAPI = {
  preferences: () => invoke("desktop_preferences"),
  state: () => invoke("desktop_state"),
  connect: (selection) => invoke("desktop_connect", { selection }),
  disconnect: () => invoke("desktop_disconnect"),
  sessions: (query) => invoke("desktop_sessions", { query }),
  session: (input) => invoke("desktop_session", { request: input }),
  pin: (request) => invoke("desktop_pin", { request }),
  workspaces: () => invoke("desktop_workspaces"),
  messages: (sessionID) => invoke("desktop_messages", { sessionId: sessionID }),
  createSession: (input) => invoke("desktop_create_session", { directory: input.directory, sessionId: input.sessionID }),
  prompt: (input) => invoke("desktop_prompt", { sessionId: input.sessionID, promptId: input.promptID, text: input.text }),
  interrupt: (sessionID) => invoke("desktop_interrupt", { sessionId: sessionID }),
  requests: (sessionID) => invoke("desktop_requests", { sessionId: sessionID }),
  reply: (input) => invoke("desktop_reply", { reply: input }),
  models: (source) => invoke("desktop_models", { source }),
  switchModel: (input) => invoke("desktop_switch_model", { request: input }),
  onState: (callback) => subscribe<ConnectionState>("desktop:state", callback),
  onEvent: (callback) => subscribe<YCodingEvent>("desktop:event", callback),
  onResync: (callback) => subscribe<null>("desktop:resync", () => callback()),
}
