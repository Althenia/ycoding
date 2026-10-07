import { isSessionID, noticeSequence, type RemoteAlertDetail, type RemoteNoticeCategory } from "@ycoding-ai/remote"

export type AlertNotice = { readonly deviceID: string; readonly noticeID: string }

export function alertCopy(category: RemoteNoticeCategory, detail: RemoteAlertDetail = {}): { readonly title: string; readonly body: string } {
  const subject = detail.title === undefined ? "A session" : `“${detail.title}”`
  if (category === "agent-completed") return { title: "YCoding — work finished", body: `${subject} finished all its work.` }
  if (detail.need === "permission") return { title: "YCoding — approval needed", body: `${subject} is waiting for you to allow or deny a tool request.` }
  if (detail.need === "question") return { title: "YCoding — question for you", body: `${subject} is waiting for your answer.` }
  if (detail.need === "review") return { title: "YCoding — guardrail review", body: `${subject} is waiting for you to approve or reject a guarded action.` }
  if (detail.need === "blocked") return { title: "YCoding — action blocked", body: `A guardrail blocked an action in ${detail.title === undefined ? "a session" : subject}. Open it to review.` }
  if (detail.need === "failed") return { title: "YCoding — session failed", body: `${subject} stopped with an error. Open it to review and retry.` }
  return { title: "YCoding — needs your attention", body: `${subject} is waiting for you.` }
}

export function overflowCopy(category: RemoteNoticeCategory, count: number): { readonly title: string; readonly body: string } {
  const sessions = count === 1 ? "1 more session" : `${count} more sessions`
  if (category === "agent-completed") return { title: "YCoding — more work finished", body: `${sessions} finished ${count === 1 ? "its" : "their"} work. Open YCoding to see them.` }
  return { title: "YCoding — more sessions need you", body: `${sessions} ${count === 1 ? "is" : "are"} waiting for you. Open YCoding to see them.` }
}

export function sessionSearch(sessionID: string, deviceID?: string, noticeID?: string): { session_id: string; device_id?: string; notice_id?: string } {
  return { session_id: sessionID, ...(deviceID === undefined ? {} : { device_id: deviceID }), ...(noticeID === undefined ? {} : { notice_id: noticeID }) }
}

export function readSessionSearch(search: unknown): { sessionID: string; deviceID?: string; noticeID?: string } | undefined {
  if (typeof search !== "object" || search === null || Array.isArray(search)) return undefined
  const sessionID = "session_id" in search ? search.session_id : undefined
  if (!isSessionID(sessionID)) return undefined
  if (!("device_id" in search)) return { sessionID }
  const deviceID = search.device_id
  const noticeID = "notice_id" in search ? search.notice_id : undefined
  if (!isAlertDeviceID(deviceID)) return undefined
  return { sessionID, deviceID, ...(typeof noticeID === "string" && noticeSequence(noticeID) !== undefined ? { noticeID } : {}) }
}

export function sessionURL(sessionID: string, deviceID?: string, noticeID?: string): string {
  return `/remote/session?${new URLSearchParams({ session_id: sessionID, ...(deviceID === undefined ? {} : { device_id: deviceID }),
    ...(noticeID === undefined ? {} : { notice_id: noticeID }) })}`
}

export function isAlertDeviceID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
