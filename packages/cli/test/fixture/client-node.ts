import { createClient } from "../../src/services/client"

const client = createClient({
  url: process.argv[2],
  auth: { type: "basic", username: "node-owner", password: "synthetic-node-secret" },
})
try {
  console.log(JSON.stringify(await client.health.get()))
} finally {
  client.transport.close()
}
