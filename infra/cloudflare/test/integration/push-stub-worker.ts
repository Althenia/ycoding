import worker, { DeviceRelay } from "../../src/index"

const send = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === "fcm.googleapis.com" && url.pathname === "/fcm/send/flow-local-only")
    return send(`http://127.0.0.1:${PUSH_STUB_PORT}/push`, init)
  return send(input, init)
}

export { DeviceRelay }
export default worker
