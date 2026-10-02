import { isSessionID, noticeSequence, type RemoteAlertDetail, type RemoteNoticeCategory } from "@ycoding-ai/remote"

export type AlertNotice = { readonly deviceID: string; readonly noticeID: string }

export function alertCopy(category: RemoteNoticeCategory, detail: RemoteAlertDetail = {}): { readonly title: string; readonly body: string } {
  const subject = detail.title === undefined ? "A session" : `“${detail.title}”`
  if (category === "agent-completed") return { title: "YCoding — work finished", body: `${subject} finished all its work.` }
  if (detail.need === "permission") return { title: "YCoding — approval needed", body: `${subject} is waiting for you to allow or deny a tool request.` }
  if (detail.need === "question") return { title: "YCoding — question for you", body: `${subject} is waiting for your answer.` }
  if (detail.need === "review") return { title: "YCoding — guardrail review", body: `${subject} is waiting for you to approve or reject a guarded action.` }
  if (detail.need === "failed") return { title: "YCoding — session failed", body: `${subject} stopped with an error. Open it to review and retry.` }
  return { title: "YCoding — needs your attention", body: `${subject} is waiting for you.` }
}

export function overflowCopy(category: RemoteNoticeCategory, count: number): { readonly title: string; readonly body: string } {
  const sessions = count === 1 ? "1 more session" : `${count} more sessions`
  if (category === "agent-completed") return { title: "YCoding — more work finished", body: `${sessions} finished ${count === 1 ? "its" : "their"} work. Open YCoding to see them.` }
  return { title: "YCoding — more sessions need you", body: `${sessions} ${count === 1 ? "is" : "are"} waiting for you. Open YCoding to see them.` }
}

export function alertHash(sessionID: string, notice?: AlertNotice): string {
  return new URLSearchParams({ session: sessionID, ...(notice === undefined ? {} : { device: notice.deviceID, notice: notice.noticeID }) }).toString()
}

export function readAlertHash(fragment: string): { readonly sessionID: string; readonly notice?: AlertNotice } | undefined {
  const params = new URLSearchParams(fragment)
  const sessionID = params.get("session")
  if (sessionID === null || !isSessionID(sessionID)) return undefined
  const deviceID = params.get("device")
  const noticeID = params.get("notice")
  return deviceID !== null && isAlertDeviceID(deviceID) && noticeID !== null && noticeSequence(noticeID) !== undefined
    ? { sessionID, notice: { deviceID, noticeID } }
    : { sessionID }
}

export function isAlertDeviceID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
