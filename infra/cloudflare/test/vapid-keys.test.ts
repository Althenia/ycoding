import { expect, test } from "bun:test"
import { base64UrlDecode } from "../src/auth/crypto"
import { generateVapidKeys } from "../script/vapid-keys"

test("generates a VAPID P-256 public point and 32-byte private scalar", async () => {
  const keys = await generateVapidKeys()
  expect(base64UrlDecode(keys.VAPID_PUBLIC_KEY)?.length).toBe(65)
  expect(base64UrlDecode(keys.VAPID_PUBLIC_KEY)?.[0]).toBe(4)
  expect(base64UrlDecode(keys.VAPID_PRIVATE_KEY)?.length).toBe(32)
})
