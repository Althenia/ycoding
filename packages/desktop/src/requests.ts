import { DesktopError, utf8Length, type FormAnswer, type RequestReply, type PageInput, type RevertInput, type SetAutonomyInput, type ShellOutputInput, type WorkspaceDirectoriesInput, type UsageRange } from "./contract"
import path from "node:path"

type ClassicReply = Exclude<RequestReply, { readonly kind: "guardrail" | "review" }>
const invalid = "This answer is invalid. Refresh requests and answer again."
const fields: Record<ClassicReply["kind"], readonly string[]> = {
  permission: ["kind", "message", "reply", "requestID", "revision", "sessionID"],
  form: ["answer", "formID", "kind", "revision", "sessionID"],
  "form-cancel": ["formID", "kind", "revision", "sessionID"],
}

export const isSessionID = (value: unknown): value is string => typeof value === "string" && /^ses_[A-Za-z0-9_-]{1,124}$/.test(value)
export const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export function session(value: unknown) {
  if (!isSessionID(value)) throw new DesktopError("Choose a Session.")
  return value
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const decision = (value: unknown): value is "manual" | "auto" | "yolo" => value === "manual" || value === "auto" || value === "yolo"
export function setAutonomyInput(value: unknown): SetAutonomyInput {
  const invalid = () => new DesktopError("Invalid autonomy change.")
  if (!record(value) || Object.keys(value).some((key) => !["sessionID", "revision", "payload"].includes(key)) || !isRevision(value.revision) || !record(value.payload)) throw invalid()
  const sessionID = session(value.sessionID)
  const revision = value.revision
  const payload = value.payload
  const keys = Object.keys(payload)
  if (Object.hasOwn(payload, "goal")) {
    if (keys.some((key) => key !== "goal" && key !== "maxNoProgress") || !(payload.goal === null || payload.goal === true || (typeof payload.goal === "string" && payload.goal.trim().length > 0)) || (payload.maxNoProgress !== undefined && (!isRevision(payload.maxNoProgress) || payload.maxNoProgress < 1))) throw invalid()
    return { sessionID, revision, payload: { goal: payload.goal, ...(payload.maxNoProgress === undefined ? {} : { maxNoProgress: payload.maxNoProgress }) } }
  }
  if (Object.hasOwn(payload, "sleep")) {
    if (keys.length !== 1 || typeof payload.sleep !== "boolean") throw invalid()
    return { sessionID, revision, payload: { sleep: payload.sleep } }
  }
  if (!keys.length || keys.some((key) => !["permissions", "guardrails", "answers"].includes(key)) || keys.some((key) => !decision(payload[key]))) throw invalid()
  const permissions = payload.permissions
  const guardrails = payload.guardrails
  const answers = payload.answers
  if (decision(permissions)) return { sessionID, revision, payload: { permissions, ...(decision(guardrails) ? { guardrails } : {}), ...(decision(answers) ? { answers } : {}) } }
  if (decision(guardrails)) return { sessionID, revision, payload: { guardrails, ...(decision(answers) ? { answers } : {}) } }
  if (decision(answers)) return { sessionID, revision, payload: { answers } }
  throw invalid()
}
export function pageInput(value: unknown): PageInput {
  if (value === undefined) return {}
  if (!record(value) || Object.keys(value).some((key) => key !== "cursor" && key !== "revision")) throw new DesktopError("Invalid page request.")
  if (value.cursor === undefined && value.revision === undefined) return {}
  if (typeof value.cursor !== "string" || !value.cursor || utf8Length(value.cursor) > 4096 || !isRevision(value.revision)) throw new DesktopError("Invalid page request.")
  return { cursor: value.cursor, revision: value.revision }
}
export function activityInput(value: unknown) {
  if (typeof value === "string") return { sessionID: session(value), page: {} }
  if (!record(value) || Object.keys(value).some((key) => !["sessionID", "cursor", "revision"].includes(key))) throw new DesktopError("Invalid activity request.")
  return { sessionID: session(value.sessionID), page: pageInput({ ...(value.cursor === undefined ? {} : { cursor: value.cursor }), ...(value.revision === undefined ? {} : { revision: value.revision }) }) }
}
export function shellOutputInput(value: unknown): ShellOutputInput {
  if (!record(value) || Object.keys(value).some((key) => !["sessionID", "shellID", "cursor", "limit"].includes(key)) || typeof value.shellID !== "string" || !/^sh_[A-Za-z0-9_-]{1,124}$/.test(value.shellID) || (value.cursor !== undefined && !isRevision(value.cursor)) || (value.limit !== undefined && (!isRevision(value.limit) || value.limit < 1 || value.limit > 65536))) throw new DesktopError("Invalid shell output request.")
  return { sessionID: session(value.sessionID), shellID: value.shellID, ...(value.cursor === undefined ? {} : { cursor: value.cursor }), ...(value.limit === undefined ? {} : { limit: value.limit }) }
}
export function revertInput(value: unknown): RevertInput {
  if (!record(value) || !isRevision(value.revision) || !["stage", "commit", "clear"].includes(String(value.action))) throw new DesktopError("Invalid revert request.")
  const sessionID = session(value.sessionID)
  if (value.action === "stage") {
    if (Object.keys(value).some((key) => !["action", "sessionID", "revision", "messageID", "files"].includes(key)) || typeof value.messageID !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(value.messageID) || (value.files !== undefined && typeof value.files !== "boolean")) throw new DesktopError("Invalid revert request.")
    return { action: "stage", sessionID, revision: value.revision, messageID: value.messageID, ...(value.files === undefined ? {} : { files: value.files }) }
  }
  if ((value.action !== "commit" && value.action !== "clear") || Object.keys(value).some((key) => !["action", "sessionID", "revision"].includes(key))) throw new DesktopError("Invalid revert request.")
  return { action: value.action, sessionID, revision: value.revision }
}
export function directoriesInput(value: unknown): WorkspaceDirectoriesInput {
  if (!record(value) || Object.keys(value).some((key) => key !== "projectID" && key !== "directory") || typeof value.projectID !== "string" || !value.projectID || utf8Length(value.projectID) > 256 || (value.directory !== undefined && (typeof value.directory !== "string" || !path.isAbsolute(value.directory) || utf8Length(value.directory) > 4096))) throw new DesktopError("Invalid project directories request.")
  return { projectID: value.projectID, ...(value.directory === undefined ? {} : { directory: value.directory }) }
}
export function usageInput(value: unknown): UsageRange {
  if (value === undefined) return "all"
  if (!record(value) || Object.keys(value).some((key) => key !== "range") || (value.range !== undefined && value.range !== "today" && value.range !== "7d" && value.range !== "30d" && value.range !== "all")) throw new DesktopError("Invalid usage range.")
  return value.range ?? "all"
}

function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new DesktopError(invalid)
  return value
}

function answer(value: unknown): FormAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new DesktopError(invalid)
  const entries = Object.entries(value)
  if (entries.length > 256 || utf8Length(JSON.stringify(value)) > 500_000) throw new DesktopError(invalid)
  return Object.fromEntries(entries.map(([key, item]): [string, string | number | boolean | readonly string[]] => {
    if (!key || key.length > 256) throw new DesktopError(invalid)
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return [key, item]
    if (Array.isArray(item) && item.length <= 256 && item.every((choice) => typeof choice === "string")) return [key, item.map(String)]
    throw new DesktopError(invalid)
  }))
}

export function requestReply(value: unknown): ClassicReply {
  if (typeof value !== "object" || value === null || !("kind" in value) || !("sessionID" in value) || !("revision" in value)) throw new DesktopError(invalid)
  const kind = value.kind
  if (kind !== "permission" && kind !== "form" && kind !== "form-cancel") throw new DesktopError(invalid)
  if (Object.keys(value).some((key) => !fields[kind].includes(key))) throw new DesktopError(invalid)
  const sessionID = session(value.sessionID)
  const revision = value.revision
  if (!isRevision(revision)) throw new DesktopError(invalid)
  if (kind === "permission") {
    if (!("requestID" in value) || !("reply" in value)) throw new DesktopError(invalid)
    const reply = value.reply
    if (reply !== "once" && reply !== "always" && reply !== "reject") throw new DesktopError(invalid)
    const message = "message" in value ? value.message : undefined
    if (message !== undefined && (typeof message !== "string" || message.length > 4096)) throw new DesktopError(invalid)
    return { kind, sessionID, revision, requestID: identifier(value.requestID), reply, ...(message === undefined ? {} : { message }) }
  }
  if (!("formID" in value)) throw new DesktopError(invalid)
  const formID = identifier(value.formID)
  if (kind === "form-cancel") return { kind, sessionID, revision, formID }
  if (!("answer" in value)) throw new DesktopError(invalid)
  return { kind, sessionID, revision, formID, answer: answer(value.answer) }
}
