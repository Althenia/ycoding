import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("Node Dots socket sends upgrade headers and selected subprotocols", async () => {
  const file = pathToFileURL(path.resolve(import.meta.dir, "../src/dots/socket.ts")).href
  const child = Bun.spawn(["node", "--input-type=module", "-"], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  child.stdin.write(`
import assert from "node:assert/strict";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { DotsSocket } from ${JSON.stringify(file)};
const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const received = new Promise(resolve => server.once("connection", (socket, request) => {
  resolve(request.headers);
  socket.on("message", (value, binary) => socket.send(value, { binary }));
}));
const address = server.address();
const socket = await DotsSocket.open("ws://127.0.0.1:" + address.port, ["synthetic-protocol"], { originator: "Synthetic Client", "User-Agent": "Synthetic Agent", "ChatGPT-Account-Id": "synthetic-account" });
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
const headers = await received;
assert.equal(headers.originator, "Synthetic Client");
assert.equal(headers["user-agent"], "Synthetic Agent");
assert.equal(headers["chatgpt-account-id"], "synthetic-account");
assert.equal(headers["sec-websocket-protocol"], "synthetic-protocol");
const echoed = new Promise(resolve => socket.addEventListener("message", event => resolve(event.data)));
socket.send("synthetic-frame");
assert.equal(await echoed, "synthetic-frame");
socket.close();
await new Promise(resolve => server.close(resolve));
console.log("node-socket-ok");
`)
  child.stdin.end()
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exit, stderr }).toMatchObject({ exit: 0 })
  expect(stdout.trim()).toBe("node-socket-ok")
}, 15_000)
