import { parsePushRemoval } from "../../../../packages/remote/src/index"
import { base64UrlEncode, cryptoBytes } from "../auth/crypto"
import { encryptWebPushPayload, vapidJwt } from "./crypto"
import type { PushStore } from "./store"

export type PushEvent = { readonly category: "approval-requested" | "agent-completed"; readonly sessionID: string; readonly deviceID: string }

export async function sendPushToOwner(input: {
  readonly store: PushStore
  readonly accountID: string
  readonly event: PushEvent
  readonly publicKey: string
  readonly privateKey: string
  readonly subject: string
  readonly now: () => number
  readonly fetch: typeof fetch
}): Promise<void> {
  const subscriptions = await input.store.list(input.accountID)
  const encoded = new TextEncoder().encode(JSON.stringify(input.event))
  const topic = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`${input.event.sessionID}:${input.event.category}`)))).slice(0, 32)
  const send = input.fetch
  await Promise.all(subscriptions.map(async (subscription) => {
    if (!parsePushRemoval({ endpoint: subscription.endpoint }).ok) {
      await input.store.recordFailure(subscription, true)
      return
    }
    try {
      const body = await encryptWebPushPayload(encoded, subscription.keys.p256dh, subscription.keys.auth)
      const jwt = await vapidJwt(subscription.endpoint, input.publicKey, input.privateKey, input.subject, Math.floor(input.now() / 1000))
      const response = await send(subscription.endpoint, { method: "POST", body: cryptoBytes(body),
        headers: { authorization: `vapid t=${jwt}, k=${input.publicKey}`,
          "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
          ttl: input.event.category === "approval-requested" ? "3600" : "600",
          urgency: input.event.category === "approval-requested" ? "high" : "normal", topic } })
      if (response.status === 404 || response.status === 410) await input.store.recordFailure(subscription, true)
      else if (!response.ok) await input.store.recordFailure(subscription, false)
    } catch {
      await input.store.recordFailure(subscription, false)
    }
  }))
}
