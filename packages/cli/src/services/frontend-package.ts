import type { Endpoint } from "@ycoding-ai/client/service"
import { createClient } from "./client"

export async function resolveFrontendPackage(endpoint: Endpoint, spec: string) {
  const client = createClient(endpoint)
  try {
    const result = await client.frontendPackage.resolve({ location: { directory: process.cwd() }, spec })
    return result.entrypoint.path
  } finally {
    client.transport.close()
  }
}
