export type DotsRejection = { code?: number; errorCode?: string; errorType?: string; message?: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const clean = (value: unknown, limit: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, limit) || undefined : undefined

export function dotsRejection(body: unknown): DotsRejection | undefined {
  if (!record(body) || typeof body._tag !== "string" || !record(body.rejection)) return undefined
  const value = body.rejection
  const errorCode = clean(value.errorCode, 128)
  const errorType = clean(value.errorType, 128)
  const message = clean(value.message, 1000)
  const rejection = {
    ...(typeof value.code === "number" && Number.isSafeInteger(value.code) ? { code: value.code } : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(message === undefined ? {} : { message }),
  }
  return Object.keys(rejection).length ? rejection : undefined
}

export function dotsRejectionText(rejection: DotsRejection) {
  const labels = [
    ...(rejection.code === undefined ? [] : [`code ${rejection.code}`]),
    ...(rejection.errorType === undefined ? [] : [`type ${rejection.errorType}`]),
    ...(rejection.errorCode === undefined ? [] : [`error ${rejection.errorCode}`]),
  ]
  return `ChatGPT rejection${labels.length ? ` ${labels.join(", ")}` : ""}${rejection.message === undefined ? "" : `: ${rejection.message}`}`
}

export function dotsFailureText(body: unknown) {
  if (!record(body) || typeof body._tag !== "string") return undefined
  const message = clean(body.message, 1000)
  const rejection = dotsRejection(body)
  if (message === undefined && rejection === undefined) return undefined
  return [message, rejection === undefined ? undefined : dotsRejectionText(rejection)].filter((part) => part !== undefined).join(" ")
}
