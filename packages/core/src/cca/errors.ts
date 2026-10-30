export class CcaExecutorError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message.slice(0, 512))
    this.name = "CcaExecutor.CcaExecutorError"
    this.code = code
  }
}

export interface CcaRpcHandlerContext {
  readonly signal: AbortSignal
  readonly sessionId: string
}

export interface CcaDecisionStep {
  readonly kind: "permission" | "guardrail"
  readonly requestID?: string
  readonly reply: "allow" | "once" | "always" | "reject" | "expired"
  readonly by: "rule" | "user" | "auto" | "yolo" | "expired"
}

export type CcaDecisionTrace = readonly CcaDecisionStep[]

export interface CcaAuthorizationGrant {
  release(): Promise<void>
  readonly trace?: CcaDecisionTrace
}

export interface CcaAuthorizationInput {
  readonly action: string
  readonly guardrailAction?: string
  readonly resources: readonly string[]
  readonly metadata?: Readonly<Record<string, string>>
}

export interface CcaAttribution {
  readonly threadId?: string
  readonly toolCallId?: string
}

export interface CcaPendingDecision {
  readonly kind: "permission" | "guardrail"
  readonly sessionID: string
  readonly itemID?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly hardReview: boolean
  readonly state: "open" | "rejected" | "full"
  readonly directories?: readonly string[]
}

export const CCA_BUSY_TEXT = "YCoding did not run this: YCoding is busy; retry the identical action."

export function ccaRefusalText(refusal: { readonly pending?: readonly CcaPendingDecision[]; readonly busy?: boolean }): string | undefined {
  const pending = refusal.pending ?? []
  if (pending.length === 0) return refusal.busy ? CCA_BUSY_TEXT : undefined
  const rejected = pending.find((item) => item.state === "rejected" && item.itemID !== undefined)
  if (rejected) return `YCoding did not run this: the user rejected review item ${rejected.itemID}. Do not retry it.`
  if (pending.some((item) => item.state === "full")) return "YCoding did not run this: the review box is full. Run ycoding decision list and decide or clear items first."
  const open = pending.filter((item) => item.state === "open" && item.itemID !== undefined)
  if (open.length === 0) return undefined
  return [
    "YCoding did not run this: it needs the user's decision.",
    ...open.map((item) => `Review item ${item.itemID} in Session ${item.sessionID}: ${item.kind} ${item.action} ${item.resources.join(" ")}.`),
    "Ask the user in this chat, record the answer, then retry the identical action.",
    ...open.flatMap((item) => {
      const decide = (reply: "once" | "always" | "reject") =>
        `ycoding api session.review.decide --param sessionID=${item.sessionID} --param itemID=${item.itemID} -d '{"decision":{"kind":"${item.kind}","reply":"${reply}"}}'`
      return [
        ` approve once:   ${decide("once")}`,
        ...(remembered(item) ? [` approve always: ${decide("always")}`] : []),
        ` reject:         ${decide("reject")}`,
      ]
    }),
  ].join("\n")
}

function remembered(pending: CcaPendingDecision) {
  if (pending.hardReview) return false
  return pending.kind === "permission" || (pending.directories?.length ?? 0) > 0
}

export class CcaRefusalError extends CcaExecutorError {
  readonly text: string

  constructor(text: string) {
    super(-32600, `Permission denied: ${text}`)
    this.message = `Permission denied: ${text}`
    this.text = text
  }
}
