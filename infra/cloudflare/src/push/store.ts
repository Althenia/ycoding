import type { PushSubscriptionInput } from "../../../../packages/remote/src/index"

export type PushSubscription = PushSubscriptionInput & { readonly accountID: string; readonly createdAt: number; readonly failures: number }

export type PushStore = {
  readonly upsert: (accountID: string, input: PushSubscriptionInput, now: number) => Promise<void>
  readonly remove: (accountID: string, endpoint: string) => Promise<void>
  readonly list: (accountID: string) => Promise<readonly PushSubscription[]>
  readonly recordFailure: (subscription: PushSubscription, permanent: boolean) => Promise<void>
}
