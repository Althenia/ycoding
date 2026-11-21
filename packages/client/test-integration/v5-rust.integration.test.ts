import { expect, test } from "bun:test"
import { make, isSessionNotFoundError } from "../src/v5/index.js"

test("Rust runtime socket interoperates with the native TypeScript v5 client", async () => {
  const url = process.env.YCODING_V5_TEST_URL
  if (!url)
    throw new Error(
      "YCODING_V5_TEST_URL is required; start a disposable Rust runtime test server with ready Core and the standard dispatcher before running test:integration:rust",
    )
  const client = make({
    endpoint: {
      url,
      ...(process.env.YCODING_V5_TEST_PASSWORD
        ? { auth: { type: "basic" as const, username: "ycoding", password: process.env.YCODING_V5_TEST_PASSWORD } }
        : {}),
    },
  })
  try {
    const health = await client.health.get()
    expect(health.healthy).toBe(true)
    expect(health.pid > 0).toBe(true)
    expect(health.version.length > 0).toBe(true)
    expect(health.sourceEpoch).toBe(client.transport.sourceEpoch!)
    const server = await client.server.get()
    expect(server.urls.length > 0).toBe(true)
    const missing = await client.session
      .get({ sessionID: "ses_v5_integration_missing" })
      .catch((error: unknown) => error)
    expect(isSessionNotFoundError(missing)).toBe(true)
  } finally {
    client.transport.close()
  }
})
