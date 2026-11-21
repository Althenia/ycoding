import { createServer } from "node:http2"

const server = createServer()
server.on("stream", (stream, headers) => {
  let body = Buffer.alloc(0)
  let answered = false
  stream.on("error", (error) => {
    if (stream.rstCode !== 8) throw error
  })
  stream.on("data", (chunk) => {
    if (answered) return
    body = Buffer.concat([body, chunk])
    if (body.length < 5 || body.length < 5 + body.readUInt32BE(1)) return
    if (body[0] !== 0) throw new Error("Expected an uncompressed Cursor Run frame")
    answered = true
    console.log(
      JSON.stringify({
        authorization: headers.authorization,
        session: headers["x-session-id"] ?? null,
        body: body.subarray(5, 5 + body.readUInt32BE(1)).toString("hex"),
      }),
    )
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(Buffer.from(JSON.parse(process.env.CURSOR_RESPONSE)))
  })
})
server.listen(0, "127.0.0.1", () => console.log(server.address().port))
