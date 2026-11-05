import { DesktopError, utf8Length, type FormAnswer, type RequestReply } from "./contract"

const invalid = "This answer is invalid. Refresh requests and answer again."
const fields: Record<RequestReply["kind"], readonly string[]> = {
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

export function requestReply(value: unknown): RequestReply {
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
