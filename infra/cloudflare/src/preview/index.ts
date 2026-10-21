import { parsePreviewOrigins } from "../../../../packages/remote/src/index"
import type { PreviewDirectory } from "./directory"
import { previewDirectoryName } from "./directory-store"
import { createPreviewWorker } from "./worker"

export type PreviewEnv = {
  readonly PREVIEW_ORIGINS?: string
  readonly DEVICE_RELAY: DurableObjectNamespace
  readonly PREVIEW_DIRECTORY: DurableObjectNamespace<PreviewDirectory>
}

let worker: ((request: Request) => Promise<Response>) | undefined

export default {
  fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const directory = () => env.PREVIEW_DIRECTORY.getByName(previewDirectoryName)
    worker ??= createPreviewWorker({
      origins: parsePreviewOrigins(env.PREVIEW_ORIGINS),
      directory: {
        redeem: (ticketHash, origin) => directory().redeem(ticketHash, origin),
        bind: (input) => directory().bind(input),
        resolve: (cookieHash, leaseTag, origin) => directory().resolve(cookieHash, leaseTag, origin),
      },
      forward: (device, input, signal) => env.DEVICE_RELAY.getByName(`${device.ownerID}:${device.deviceID}`).fetch(new Request("https://relay.internal/_ycoding/preview", {
        method: "POST",
        headers: { "x-ycoding-internal": "1", "x-ycoding-owner": device.ownerID, "x-ycoding-device": device.deviceID, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      })),
    })
    return worker(request)
  },
}
