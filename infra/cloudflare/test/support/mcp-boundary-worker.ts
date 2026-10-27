import worker, { DeviceRelay, PreviewDirectory } from "../../src/index"
import type { WorkerEnv } from "../../src/env"

export { DeviceRelay, PreviewDirectory }

export default {
  fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url)
    if (url.pathname === "/__fixture/relay") {
      const target = new URL(url.searchParams.get("path") ?? "/", "https://relay.internal")
      return env.DEVICE_RELAY.getByName("owner:device").fetch(new Request(target, {
        method: request.method,
        headers: url.searchParams.get("trusted") === "true" ? { "x-ycoding-internal": "1" } : {},
      }))
    }
    return worker.fetch(request, env)
  },
}
