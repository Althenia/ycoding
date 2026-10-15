import { expect, test } from "bun:test"
import { ensure, stop } from "@ycoding-ai/client/service"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/v5"
import { Schema } from "effect"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  create,
  decodeLossless,
  encodeLossless,
  encodeStrict,
  PeerRole,
  ScopeSchema,
  session_get_RequestSchema,
  session_get_ResultSchema,
} from "@ycoding-ai/protocol/v5"
import { decodeRemoteResult } from "@ycoding-ai/remote"
import { TestPeer } from "../../remote/test/peer"
import { streamResponse } from "../script/runtime-smoke"
import { ServiceConfig } from "../src/services/service-config"
import { command, localRelay, until, updateSource } from "./fixture/packaged-update"

const packaged = process.env.YCODING_TEST_PACKAGED_CLI
const busyRelease = process.env.YCODING_TEST_PACKAGED_UPDATE_BUSY
const forceRelease = process.env.YCODING_TEST_PACKAGED_UPDATE_FORCE

test.skipIf(!busyRelease && !forceRelease)(
  "fresh packaged busy and force updates preserve Sessions and the enrolled workerd connector lifecycle",
  async () => {
    if (!packaged || !busyRelease || !forceRelease) throw new Error("Three fresh packaged releases are required")
    expect({ platform: process.platform, arch: process.arch }).toEqual({ platform: "darwin", arch: "arm64" })
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-packaged-update-"))
    const project = path.join(root, "project")
    const config = path.join(root, "config/ycoding")
    const file = path.join(root, "state/ycoding-beta", ServiceConfig.filename("beta"))
    const clients: ReturnType<typeof YCoding.make>[] = []
    const peers: TestPeer[] = []
    const held = new Set<string>()
    const requests: string[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text()
        requests.push(body)
        for (const text of ["Hold updater root", "Hold updater child"])
          if (body.includes(text) && !held.has(text)) {
            held.add(text)
            return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
          }
        return new Response(streamResponse({ index: requests.length, content: "Update recovery settled" }), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    let source: Awaited<ReturnType<typeof updateSource>> | undefined
    let relay: Awaited<ReturnType<typeof localRelay>> | undefined
    try {
      await mkdir(project, { recursive: true })
      await mkdir(config, { recursive: true })
      await writeFile(
        path.join(config, "ycoding.json"),
        JSON.stringify({
          providers: {
            openrouter: {
              name: "OpenRouter",
              package: "aisdk:@openrouter/ai-sdk-provider",
              settings: { baseURL: `http://127.0.0.1:${provider.port}/api/v1` },
              models: {
                "update-model": {
                  name: "Update",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 100000, output: 4096 },
                },
              },
            },
          },
        }),
      )
      await cp(path.dirname(packaged), path.join(root, "bin"), { recursive: true })
      const executable = path.join(root, "bin/ycoding")
      const releaseVersion = async (directory: string) =>
        (
          await Schema.decodeUnknownPromise(Schema.Struct({ version: Schema.String }))(
            await Bun.file(path.join(directory, "../package.json")).json(),
          )
        ).version
      const releases = await Promise.all(
        [busyRelease, forceRelease].map(async (directory) => ({
          version: await releaseVersion(directory),
          directory,
        })),
      )
      const initial = await releaseVersion(path.dirname(packaged))
      expect(new Set([initial, ...releases.map((release) => release.version)]).size).toBe(3)
      for (const version of [initial, ...releases.map((release) => release.version)])
        expect(version).toMatch(/^0\.11\.0-beta\.\d+$/)
      source = await updateSource(path.join(root, "updates"), releases)
      relay = await localRelay(path.join(root, "relay"))
      const environment = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_DATA_HOME: path.join(root, "data"),
        YCODING_CONFIG_DIR: config,
        YCODING_CONFIG_PROJECT_DISABLE: "1",
        YCODING_DISABLE_MODELS_FETCH: "1",
        ...source.environment,
      }
      const cli = (args: string[], input?: string) =>
        command([executable, ...args], {
          cwd: project,
          env: environment,
          stdin: input === undefined ? "ignore" : new Blob([input]),
        })
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
      await writeFile(path.join(config, ServiceConfig.filename("beta")), JSON.stringify({ port: reservation.port }))
      await reservation.stop(true)
      const options = {
        file,
        version: initial,
        command: [
          "/usr/bin/env",
          "-i",
          ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
          executable,
          "serve",
          "--service",
        ],
        startupErrorFile: path.join(root, "startup-error"),
      }
      const endpoint = await ensure(options)
      const registration = async () =>
        Schema.decodeUnknownPromise(Schema.fromJsonString(Service.Info))(await readFile(file, "utf8"))
      const before = await registration()
      const client = YCoding.make({ endpoint, location: { directory: project } })
      clients.push(client)
      expect(await client.health.get()).toMatchObject({ healthy: true, version: initial, pid: before.pid })
      await client.integration.connect.key({
        integrationID: "openrouter",
        key: "updater-synthetic-key",
        location: { directory: project },
      })
      const session = await client.session.create({
        model: { providerID: "openrouter", id: "update-model" },
        location: { directory: project },
      })
      const child = await client.session.create({
        parentID: session.id,
        model: { providerID: "openrouter", id: "update-model" },
        location: { directory: project },
      })
      const idle = await client.session.create({ location: { directory: project } })
      await client.session.rename({ sessionID: session.id, title: "Acknowledged updater root" })
      await client.session.rename({ sessionID: child.id, title: "Acknowledged updater child" })
      await client.session.prompt({
        sessionID: idle.id,
        id: "msg_updater_pending",
        text: "Admitted without execution",
        resume: false,
      })
      const enrollment = await Schema.decodeUnknownPromise(
        Schema.Struct({ enrollmentID: Schema.String, code: Schema.String }),
      )(await relay.json("/api/devices/enrollments", {}))
      const enrolled = await cli(
        ["remote", "enroll", enrollment.enrollmentID, "--relay", relay.origin, "--name", "Packaged update fixture"],
        enrollment.code,
      )
      expect(enrolled.stdout).toContain("Device Packaged update fixture")
      const device = (await client.remote.get()).device!
      expect(device.relayOrigin).toBe(relay.origin)
      expect((await cli(["remote", "connect", "--relay", relay.origin])).stdout).toContain("Remote connection on.")
      const online = async (value: boolean) =>
        until(async () => {
          const listing = await Schema.decodeUnknownPromise(
            Schema.Struct({ devices: Schema.Array(Schema.Struct({ id: Schema.String, online: Schema.Boolean })) }),
          )(await relay!.json("/api/devices"))
          return listing.devices.find((item) => item.id === device.deviceID)?.online === value
        }, `relay device online=${value}`)
      await online(true)
      const browser = new TestPeer(
        `${relay.origin.replace("http", "ws")}/ws/v5/client?device=${device.deviceID}`,
        { cookie: relay.cookie, origin: relay.origin },
        PeerRole.REMOTE_CLIENT,
      )
      peers.push(browser)
      await browser.ready
      const remoteGet = async (sessionID: string, peer = browser) => {
        const id = peer.request(
          "session.get",
          create(ScopeSchema, { target: { case: "session", value: sessionID } }),
          encodeStrict(
            session_get_RequestSchema,
            create(session_get_RequestSchema, { params: { sessionID: encodeLossless(sessionID) } }),
          ),
        )
        const result = await peer.next("settled", id)
        if (result.status !== "success" || !result.payload) throw new Error(`Remote session.get: ${result.status}`)
        return decodeRemoteResult("session.get", result.payload, session_get_ResultSchema).data!
      }
      expect(decodeLossless((await remoteGet(session.id)).title!)).toBe("Acknowledged updater root")
      for (const [sessionID, text] of [
        [session.id, "Hold updater root"],
        [child.id, "Hold updater child"],
      ])
        await client.session.prompt({ sessionID, text })
      await until(async () => held.size === 2, "both provider requests started")
      expect((await client.session.outstanding()).running.sort()).toEqual([session.id, child.id].sort())
      const histories = await Promise.all(
        [session.id, child.id, idle.id].map((sessionID) => client.message.list({ sessionID })),
      )
      const pending = await client.session.pending.list({ sessionID: idle.id })
      expect(pending).toMatchObject([{ id: "msg_updater_pending", sessionID: idle.id, type: "user" }])
      const busy = await cli(["update", "--version", releases[0].version])
      expect(busy.stdout).toContain(`Updated ycoding to ${releases[0].version}`)
      expect(busy.stdout).toContain("2 Sessions have running work, so the background server was not restarted.")
      expect(busy.stdout).toContain("`ycoding service restart`")
      expect(busy.stdout).not.toContain("Restarted the background server")
      expect(await registration()).toEqual(before)
      expect(await client.health.get()).toMatchObject({ version: initial, pid: before.pid })
      expect((await cli(["--version"])).stdout.trim()).toBe(`ycoding v${releases[0].version}`)
      expect((await client.session.outstanding()).running.sort()).toEqual([session.id, child.id].sort())
      expect(
        await Promise.all([session.id, child.id, idle.id].map((sessionID) => client.message.list({ sessionID }))),
      ).toEqual(histories)
      expect(await client.session.pending.list({ sessionID: idle.id })).toEqual(pending)
      expect((await client.remote.get()).state).toBe("on")
      await online(true)
      expect(decodeLossless((await remoteGet(child.id)).parentID!)).toBe(session.id)
      const force = await cli(["update", "--version", releases[1].version, "--force"])
      expect(force.stdout).toContain(`Updated ycoding to ${releases[1].version}`)
      expect(force.stdout).toContain("Interrupting 2 running Sessions to restart the background server...")
      expect(force.stdout).toContain("Restarted the background server")
      const after = await registration()
      expect(after.id).not.toBe(before.id)
      expect(after.pid).not.toBe(before.pid)
      expect(after.version).toBe(releases[1].version)
      expect(after.password).toBe(before.password)
      expect(() => process.kill(before.pid, 0)).toThrow()
      client.transport.close()
      const recovered = YCoding.make({
        endpoint: await ensure({ ...options, version: releases[1].version }),
        location: { directory: project },
      })
      clients.push(recovered)
      expect(await recovered.health.get()).toMatchObject({ version: releases[1].version, pid: after.pid })
      for (const [sessionID, title] of [
        [session.id, "Acknowledged updater root"],
        [child.id, "Acknowledged updater child"],
      ]) {
        expect((await recovered.session.get({ sessionID })).title).toBe(title)
        expect((await recovered.message.list({ sessionID })).filter((message) => message.type === "user")).toEqual(
          histories[sessionID === session.id ? 0 : 1].filter((message) => message.type === "user"),
        )
        const reasons: string[] = []
        for await (const event of recovered.session.log({ sessionID, follow: false }))
          if (event.type === "session.execution.interrupted") reasons.push(event.data.reason)
        expect(reasons).toEqual(["shutdown"])
      }
      expect((await recovered.session.get({ sessionID: child.id })).parentID).toBe(session.id)
      expect((await recovered.session.outstanding()).running).toEqual([])
      expect(await recovered.session.pending.list({ sessionID: idle.id })).toEqual(pending)
      expect(requests.filter((body) => body.includes("Hold updater root"))).toHaveLength(1)
      expect(requests.filter((body) => body.includes("Hold updater child"))).toHaveLength(1)
      await until(async () => (await recovered.remote.get()).state === "on", "connector rehydrated")
      expect((await recovered.remote.get()).device?.deviceID).toBe(device.deviceID)
      await online(true)
      expect(decodeLossless((await remoteGet(session.id)).title!)).toBe("Acknowledged updater root")
      expect((await cli(["remote", "status"])).stdout).toContain("Connection on")
      expect((await cli(["remote", "sessions"])).stdout).toContain(session.id)
      for (const sessionID of [session.id, child.id]) {
        await recovered.session.prompt({ sessionID, text: "Settle after the packaged update" })
        await recovered.session.wait({ sessionID })
        expect(JSON.stringify(await recovered.message.list({ sessionID }))).toContain("Update recovery settled")
      }
      expect((await cli(["remote", "disconnect"])).stdout).toContain("Remote connection off.")
      await online(false)
      const unavailableID = browser.request(
        "session.get",
        create(ScopeSchema, { target: { case: "session", value: session.id } }),
        encodeStrict(
          session_get_RequestSchema,
          create(session_get_RequestSchema, { params: { sessionID: encodeLossless(session.id) } }),
        ),
      )
      expect((await browser.next("settled", unavailableID)).status).toBe("unknown")
      expect(await browser.closed).toEqual({ code: 1012, reason: "EPOCH" })
      expect((await cli(["service", "restart"])).code).toBe(0)
      recovered.transport.close()
      const disabled = YCoding.make({ endpoint: await ensure({ ...options, version: releases[1].version }) })
      clients.push(disabled)
      expect((await disabled.remote.get()).state).toBe("off")
      expect((await cli(["remote", "status"])).stdout).toContain("Connection off")
      expect((await cli(["remote", "connect"])).stdout).toContain("Remote connection on.")
      await online(true)
      const reconnected = new TestPeer(
        `${relay.origin.replace("http", "ws")}/ws/v5/client?device=${device.deviceID}`,
        { cookie: relay.cookie, origin: relay.origin },
        PeerRole.REMOTE_CLIENT,
      )
      peers.push(reconnected)
      await reconnected.ready
      expect(decodeLossless((await remoteGet(session.id, reconnected)).title!)).toBe("Acknowledged updater root")
      expect(source.rejected).toEqual([])
      expect(source.requests).toEqual(
        releases.flatMap((release) => [
          `/Althenia/ycoding/releases/download/v${release.version}/ycoding-${release.version}-checksums.txt`,
          `/Althenia/ycoding/releases/download/v${release.version}/ycoding-${release.version}-darwin-arm64.tar.gz`,
        ]),
      )
    } finally {
      peers.forEach((peer) => peer.stop())
      await Promise.all(peers.map((peer) => peer.closed))
      clients.forEach((client) => client.transport.close())
      await stop({ file })
      await relay?.close()
      await source?.close()
      await provider.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  300_000,
)
