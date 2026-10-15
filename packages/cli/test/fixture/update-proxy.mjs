import http from "node:http"
import https from "node:https"
import { createReadStream, readFileSync, statSync } from "node:fs"
import path from "node:path"

const root = process.argv[2]
const files = new Map(JSON.parse(process.argv[3]))
const sockets = new Set()
const record = (event) => process.stdout.write(JSON.stringify(event) + "\n")
const secure = https.createServer(
  { key: readFileSync(path.join(root, "key.pem")), cert: readFileSync(path.join(root, "ca.pem")) },
  (request, response) => {
    const file = files.get(request.url)
    if (!file || request.headers.host !== "github.com" || request.method !== "GET") {
      record({ rejected: `${request.method} ${request.headers.host}${request.url}` })
      response.writeHead(403).end()
      return
    }
    record({ request: request.url })
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(file).size })
    createReadStream(file).pipe(response)
  },
)
const proxy = http.createServer((_request, response) => {
  record({ rejected: "non-CONNECT" })
  response.writeHead(403).end()
})
proxy.on("connection", (socket) => {
  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
})
proxy.on("connect", (request, socket, head) => {
  if (request.url !== "github.com:443" || head.length) {
    record({ rejected: request.url ?? "missing target" })
    socket.destroy()
    return
  }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
  secure.emit("connection", socket)
})
proxy.listen(0, "127.0.0.1", () => record({ port: proxy.address().port }))
process.stdin.resume()
process.stdin.once("end", () => {
  sockets.forEach((socket) => socket.destroy())
  proxy.close()
})
