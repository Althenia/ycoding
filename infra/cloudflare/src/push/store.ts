import type { PushCategories, PushKeys, PushRegistration, PushRenewal } from "../../../../packages/remote/src/index"

export type PushSubscription = {
  readonly endpoint: string
  readonly keys: PushKeys
  readonly categories: PushCategories
  readonly accountID: string
  readonly createdAt: number
  readonly failures: number
}

export type PushTestClaim = { readonly status: "missing" } | { readonly status: "limited" } | { readonly status: "claimed"; readonly subscription: PushSubscription }

export type PushStore = {
  readonly upsert: (accountID: string, input: PushRegistration, now: number) => Promise<void>
  readonly renew: (accountID: string, input: PushRenewal, now: number) => Promise<boolean>
  readonly remove: (accountID: string, endpoint: string) => Promise<void>
  readonly list: (accountID: string) => Promise<readonly PushSubscription[]>
  readonly claimTest: (accountID: string, endpoint: string, now: number) => Promise<PushTestClaim>
  readonly recordFailure: (subscription: PushSubscription, permanent: boolean) => Promise<void>
}
