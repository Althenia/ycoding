export async function sendControl(url: string, token: string, input: unknown): Promise<unknown> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(url)) throw new Error("Invalid bridge URL")
  const address = new URL(url)
  if (Number(address.port) > 65535 || !address.port) throw new Error("Invalid bridge URL")
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("Invalid controller credential")
  const body = JSON.stringify(input)
  if (body === undefined || Buffer.byteLength(body) > 1_048_576) throw new Error("Invalid control payload")
  const response = await fetch(`${address.origin}/control`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error("Bridge request failed or timed out; outcome unknown")
  })
  if (!response.ok) throw new Error(`Bridge control rejected (${response.status})`)
  return response.json().catch(() => {
    throw new Error("Invalid bridge response; outcome unknown")
  })
}
