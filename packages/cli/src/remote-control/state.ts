import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"

export type RemoteControlEnrollment = {
  readonly serverID: string
  readonly environmentID: string
  readonly serverName: string
  readonly remoteControlEnabled: boolean
  readonly updatedAt: number
}

export type RemoteControlState = {
  readonly installationID: string
  readonly enrollments: Readonly<Record<string, RemoteControlEnrollment>>
}

export function accountHash(accountID: string) {
  return createHash("sha256").update(accountID).digest("hex")
}

export function enrollmentKey(input: { readonly websocketURL: string; readonly accountHash: string }) {
  return [input.websocketURL, input.accountHash, OpenAICodex.clientInfo.name].join("\0")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function decodeEnrollment(value: unknown): RemoteControlEnrollment | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.serverID !== "string" ||
    typeof value.environmentID !== "string" ||
    typeof value.serverName !== "string" ||
    typeof value.remoteControlEnabled !== "boolean" ||
    typeof value.updatedAt !== "number"
  )
    return undefined
  return {
    serverID: value.serverID,
    environmentID: value.environmentID,
    serverName: value.serverName,
    remoteControlEnabled: value.remoteControlEnabled,
    updatedAt: value.updatedAt,
  }
}

export function createRemoteControlStateStore(file: string) {
  let pending = Promise.resolve()
  const installationID = randomUUID()

  async function read(): Promise<RemoteControlState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      if (!isRecord(parsed)) throw new SyntaxError("Invalid remote-control state")
      const enrollments: Record<string, RemoteControlEnrollment> = {}
      if (isRecord(parsed.enrollments))
        for (const entry of Object.entries(parsed.enrollments)) {
          const decoded = decodeEnrollment(entry[1])
          if (decoded) enrollments[entry[0]] = decoded
        }
      return {
        installationID:
          typeof parsed.installationID === "string" && parsed.installationID.length > 0
            ? parsed.installationID
            : installationID,
        enrollments,
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return { installationID, enrollments: {} }
      throw error
    }
  }

  async function write(state: RemoteControlState) {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  function update(mutator: (state: RemoteControlState) => RemoteControlState) {
    const run = pending.then(async () => {
      const next = mutator(await read())
      await write(next)
      return next
    })
    pending = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    load: () => pending.then(read),
    saveEnrollment: (input: {
      readonly websocketURL: string
      readonly accountHash: string
      readonly enrollment: RemoteControlEnrollment
    }) =>
      update((state) => ({
        ...state,
        enrollments: { ...state.enrollments, [enrollmentKey(input)]: input.enrollment },
      })),
    deleteEnrollment: (input: { readonly websocketURL: string; readonly accountHash: string }) =>
      update((state) => {
        const enrollments = { ...state.enrollments }
        delete enrollments[enrollmentKey(input)]
        return { ...state, enrollments }
      }),
    enrollment: async (input: { readonly websocketURL: string; readonly accountHash: string }): Promise<RemoteControlEnrollment | undefined> =>
      (await pending.then(read)).enrollments[enrollmentKey(input)],
  }
}

export type RemoteControlStateStore = ReturnType<typeof createRemoteControlStateStore>
