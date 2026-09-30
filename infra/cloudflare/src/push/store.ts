import type { PushCategories, PushKeys, PushRegistration, PushRenewal } from "../../../../packages/remote/src/index"

export type PushSubscription = {
  readonly endpoint: string
  readonly keys: PushKeys
  readonly categories: PushCategories
  readonly accountID: string
  readonly browserSessionID: string
  readonly createdAt: number
  readonly failures: number
}

export type PushTestClaim = { readonly status: "missing" } | { readonly status: "limited" } | { readonly status: "claimed"; readonly subscription: PushSubscription }

export type PushStore = {
  readonly upsert: (accountID: string, browserSessionID: string, input: PushRegistration, now: number) => Promise<boolean>
  readonly renew: (accountID: string, browserSessionID: string, input: PushRenewal, now: number) => Promise<"written" | "missing" | "unauthorized">
  readonly remove: (accountID: string, endpoint: string) => Promise<void>
  readonly list: (accountID: string) => Promise<readonly PushSubscription[]>
  readonly claimTest: (accountID: string, endpoint: string, now: number) => Promise<PushTestClaim>
  readonly recordFailure: (subscription: PushSubscription, permanent: boolean) => Promise<void>
}
