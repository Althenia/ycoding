import { parsePushEndpoint, type PushTestResponse, type RemoteNoticeCategory } from "../../../../packages/remote/src/index"
import { base64UrlEncode, cryptoBytes } from "../auth/crypto"
import { encryptWebPushPayload, vapidJwt } from "./crypto"
import type { PushStore, PushSubscription } from "./store"

export type PushEvent =
  | { readonly category: RemoteNoticeCategory; readonly sessionID: string; readonly deviceID: string; readonly noticeID?: string }
  | { readonly category: "machine-offline"; readonly deviceID: string; readonly offlineAt: number }

type PushSender = {
  readonly publicKey: string
  readonly privateKey: string
  readonly subject: string
  readonly now: () => number
  readonly fetch: typeof fetch
}

type PushMessage = {
  readonly category: PushEvent["category"] | "test"
  readonly payload: Uint8Array
  readonly ttl: string
  readonly urgency: "high" | "normal"
  readonly topic?: string
  readonly targetCount: number
}

export async function sendPushToOwner(input: PushSender & { readonly store: PushStore; readonly accountID: string; readonly event: PushEvent }): Promise<void> {
  const subscriptions = await input.store.list(input.accountID)
  const targets = subscriptions.filter((subscription) => subscription.categories[input.event.category])
  if (targets.length === 0) {
    console.info(JSON.stringify({ component: "web-push", category: input.event.category, host: "none", targetCount: 0,
      errorClass: subscriptions.length === 0 ? "no_subscriptions" : "category_off" }))
    return
  }
  const scope = input.event.category === "machine-offline" ? input.event.deviceID : input.event.sessionID
  const message: PushMessage = {
    category: input.event.category,
    payload: new TextEncoder().encode(JSON.stringify(input.event)),
    ttl: input.event.category === "agent-completed" ? "600" : "3600",
    urgency: input.event.category === "approval-requested" ? "high" : "normal",
    topic: base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${input.event.category}`)))).slice(0, 32),
    targetCount: targets.length,
  }
  await Promise.all(targets.map((subscription) => deliver(input, input.store, subscription, message)))
}

export function sendTestPush(input: PushSender & { readonly store: PushStore; readonly subscription: PushSubscription }): Promise<PushTestResponse> {
  return deliver(input, input.store, input.subscription, { category: "test", payload: new TextEncoder().encode(JSON.stringify({ category: "test" })),
    ttl: "60", urgency: "high", targetCount: 1 })
}

async function deliver(sender: PushSender, store: PushStore, subscription: PushSubscription, message: PushMessage): Promise<PushTestResponse> {
  const outcome = { component: "web-push", category: message.category, targetCount: message.targetCount }
  if (!parsePushEndpoint({ endpoint: subscription.endpoint }).ok) {
    console.info(JSON.stringify({ ...outcome, host: "invalid", errorClass: "invalid_subscription" }))
    await store.recordFailure(subscription, true)
    return { outcome: "unreachable" }
  }
  const host = new URL(subscription.endpoint).hostname
  const send = sender.fetch
  const response = await (async () => {
    try {
      const body = await encryptWebPushPayload(message.payload, subscription.keys.p256dh, subscription.keys.auth)
      const jwt = await vapidJwt(subscription.endpoint, sender.publicKey, sender.privateKey, sender.subject, Math.floor(sender.now() / 1000))
      return await send(subscription.endpoint, { method: "POST", body: cryptoBytes(body),
        headers: { authorization: `vapid t=${jwt}, k=${sender.publicKey}`,
          "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
          ttl: message.ttl, urgency: message.urgency, ...(message.topic === undefined ? {} : { topic: message.topic }) } })
    } catch { return undefined }
  })()
  if (response === undefined) {
    console.info(JSON.stringify({ ...outcome, host, errorClass: "delivery_error" }))
    await store.recordFailure(subscription, false)
    return { outcome: "unreachable" }
  }
  console.info(JSON.stringify({ ...outcome, host, status: response.status }))
  if (response.status === 404 || response.status === 410) {
    await store.recordFailure(subscription, true)
    return { outcome: "expired", status: response.status }
  }
  if (!response.ok) {
    await store.recordFailure(subscription, false)
    return { outcome: "rejected", status: response.status }
  }
  return { outcome: "accepted", status: response.status }
}
