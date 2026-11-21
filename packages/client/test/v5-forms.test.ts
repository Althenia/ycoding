import { expect, test } from "bun:test"
import { decodeLossless } from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

test("every global Form method selects the Location scope while Session Forms retain their owner", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (request) => peer.reject(request)
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    location: { directory: "/default", workspaceID: "wrk_default" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  const options = {
    headers: { "x-ycoding-directory": encodeURIComponent("/selected work/ไทย"), "x-ycoding-workspace": "wrk_selected" },
  }
  const target = { sessionID: "global", formID: "frm_global" }
  try {
    const calls = [
      () =>
        client.form.create({ sessionID: "global", title: "Global", fields: [{ key: "ok", type: "boolean" }] }, options),
      () => client.form.list({ sessionID: "global" }, options),
      () => client.form.get(target, options),
      () => client.form.state(target, options),
      () => client.form.reply({ ...target, answer: {} }, options),
      () => client.form.cancel(target, options),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ _tag: "InvalidRequestError" })
      const scope = peer.requests.at(-1)!.request.scope!.target
      expect(scope.case).toBe("globalForm")
      if (scope.case !== "globalForm") throw new Error("Expected global Form scope")
      expect(decodeLossless(scope.value.directory!)).toBe("/selected work/ไทย")
      expect(decodeLossless(scope.value.workspaceId!)).toBe("wrk_selected")
    }
    await expect(client.form.cancel(target)).rejects.toMatchObject({ _tag: "InvalidRequestError" })
    const fallback = peer.requests.at(-1)!.request.scope!.target
    expect(fallback.case).toBe("globalForm")
    if (fallback.case !== "globalForm") throw new Error("Expected configured global Form scope")
    expect(decodeLossless(fallback.value.directory!)).toBe("/default")
    expect(decodeLossless(fallback.value.workspaceId!)).toBe("wrk_default")
    await expect(client.form.cancel({ ...target, sessionID: "ses_owner" }, options)).rejects.toMatchObject({
      _tag: "InvalidRequestError",
    })
    expect(peer.requests.at(-1)!.request.scope!.target).toEqual({ case: "form", value: "ses_owner" })
  } finally {
    client.transport.close()
  }
})
