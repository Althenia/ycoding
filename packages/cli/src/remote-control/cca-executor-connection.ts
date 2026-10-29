import type { CcaExecutorConnection } from "@ycoding-ai/core/cca/executor"
import { ccaFsWireMethods, type CcaFsWireMethod } from "./cca-executor-fs-wire"
import {
  CCA_HTTP_REQUEST_BODY_DELTA_METHOD,
  CCA_HTTP_REQUEST_METHOD,
  decodeCcaHttpRequestParams,
  encodeCcaHttpBodyDelta,
  encodeCcaHttpRequestResponse,
} from "./cca-executor-http-wire"
import type { CcaRpcConnection, CcaRpcConnectionMethod } from "./cca-executor-rpc"

function fsMethod<P, R>(wire: CcaFsWireMethod<P, R>, run: (params: P, ctx: Parameters<CcaRpcConnectionMethod>[1]) => Promise<R>): CcaRpcConnectionMethod {
  return async (params, ctx) => ({ result: wire.encode(await run(wire.decode(params), ctx)) })
}

export function ccaRpcConnection(connection: CcaExecutorConnection): CcaRpcConnection {
  const fs = connection.fs
  return {
    methods: {
      "fs/createDirectory": fsMethod(ccaFsWireMethods["fs/createDirectory"], fs.createDirectory),
      "fs/open": fsMethod(ccaFsWireMethods["fs/open"], fs.open),
      "fs/readBlock": fsMethod(ccaFsWireMethods["fs/readBlock"], fs.readBlock),
      "fs/writeBlock": fsMethod(ccaFsWireMethods["fs/writeBlock"], fs.writeBlock),
      "fs/close": fsMethod(ccaFsWireMethods["fs/close"], fs.close),
      "fs/walk": fsMethod(ccaFsWireMethods["fs/walk"], fs.walk),
      "fs/remove": fsMethod(ccaFsWireMethods["fs/remove"], fs.remove),
      "fs/copy": fsMethod(ccaFsWireMethods["fs/copy"], fs.copy),
      [CCA_HTTP_REQUEST_METHOD]: async (params, ctx) => {
        const outcome = await connection.http.request(decodeCcaHttpRequestParams(params), {
          signal: ctx.signal,
          sessionId: ctx.sessionId,
          emit: (delta) => ctx.notify(CCA_HTTP_REQUEST_BODY_DELTA_METHOD, encodeCcaHttpBodyDelta(delta)),
        })
        const result = encodeCcaHttpRequestResponse(outcome.response)
        const stream = outcome.stream
        if (stream === undefined) return { result }
        return {
          result,
          afterSend: () => void stream.start().catch(() => {}),
          unsent: () => void stream.cancel().catch(() => {}),
        }
      },
    },
    close: connection.close,
  }
}
