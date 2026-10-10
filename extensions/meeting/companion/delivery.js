import { backendStopReason, bridgeURL } from "./protocol.js"

export function createDelivery(options) {
  const url = bridgeURL(options.url)
  const queue = []
  const state = { pumping: false, closed: false, error: undefined, controller: undefined }
  const fail = (reason) => {
    if (state.closed) return
    state.closed = true
    state.error = reason
    state.controller?.abort()
    queue.splice(0).forEach((item) => item.reject(new Error(reason)))
    options.onFailure(reason)
  }
  const pump = async () => {
    if (state.pumping || state.closed) return
    state.pumping = true
    while (queue.length && !state.closed) {
      const item = queue[0]
      let acknowledged = false
      for (let attempt = 0; attempt < 4 && !state.closed; attempt++) {
        state.controller = new AbortController()
        const response = await options
          .fetch(`${url}/capture`, {
            method: "POST",
            headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
            body: item.body,
            redirect: "error",
            signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(3000)]),
          })
          .catch(() => undefined)
        if (state.closed) break
        if (response?.status === 200) {
          const result = await response.json().catch(() => undefined)
          if (result !== undefined) {
            item.stop = result?.stop === true
            item.stopReason = backendStopReason(result?.reason)
            acknowledged = true
            break
          }
        }
        if (response?.status === 401 || response?.status === 403) {
          fail("pairing_expired")
          break
        }
        if (response && response.status !== 200 && response.status !== 429 && response.status < 500) {
          fail("capture_rejected")
          break
        }
        options.onState("reconnecting")
        if (attempt < 3) await options.wait(1000)
      }
      if (state.closed) break
      if (!acknowledged) {
        fail("reconnect_exhausted")
        break
      }
      queue.shift()
      item.resolve()
      options.onState("connected")
      if (item.stop) options.onStop?.(item.stopReason)
    }
    state.pumping = false
  }
  return {
    send(message) {
      if (state.closed) return Promise.reject(new Error(state.error ?? "delivery_closed"))
      if (queue.length >= 32) {
        fail("queue_overflow")
        return Promise.reject(new Error("queue_overflow"))
      }
      return new Promise((resolve, reject) => {
        queue.push({ body: JSON.stringify(message), resolve, reject })
        void pump()
      })
    },
    close() {
      if (state.closed) return
      state.closed = true
      state.controller?.abort()
      queue.splice(0).forEach((item) => item.reject(new Error("delivery_closed")))
    },
  }
}
