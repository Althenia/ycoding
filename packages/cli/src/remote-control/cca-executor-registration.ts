import { createHash } from "node:crypto"
import { open, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import { ycodingDotsSkillsRoot } from "./ycoding-operator-skill"

export const ccaExecutorRegistrationURL = "https://chatgpt.com/backend-api/flora/cca/executor"
export const ccaDesktopAppVersion = "26.1023.50603"
export const ccaDesktopOriginator = "Codex Desktop"
export const defaultTimeoutMs = 15_000
const reregistrationAttempts = 2
const reregistrationRetryDelayMs = 1_000

const desktopPlatformNames: Partial<Record<string, string>> = {
  darwin: "Mac OS",
  linux: "X11; Linux",
  win32: "Windows NT 10.0",
}

export function ccaDesktopUserAgent(platform: string = process.platform, arch: string = process.arch) {
  return `${ccaDesktopOriginator}/${ccaDesktopAppVersion} (${desktopPlatformNames[platform] ?? platform}; ${arch})`
}

export type CcaCredential = {
  readonly access: string
  readonly accountID: string
}

export type CcaCredentialRefresh = (rejected: CcaCredential) => Promise<CcaCredential | undefined>

export class CcaRegistrationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
  }
}

export type CcaRegistrationResponse = {
  readonly executorID: string
  readonly customDisplayName?: string | null
}

export type CcaFetch = (url: string, init?: RequestInit) => Promise<Response>

export type CcaCapabilityRoot = {
  readonly id: string
  readonly path: string
}

export function ccaExecutorCapabilityRoots(home: string, dataDirectory?: string): CcaCapabilityRoot[] {
  return [
    { id: "codex-home-skills", path: path.join(home, ".agents", "skills") },
    { id: "ycoding-dots-skills", path: ycodingDotsSkillsRoot(dataDirectory) },
  ]
}

export function sameCcaCapabilityRoots(left: readonly CcaCapabilityRoot[] | undefined, right: readonly CcaCapabilityRoot[]) {
  return left !== undefined && left.length === right.length && left.every((root, index) => root.id === right[index]!.id && root.path === right[index]!.path)
}

export type CcaPrefixClass = "ccarenv_b64_" | "ccarenv_" | "env_e_" | "unknown"

export type CcaRenameDeclined = {
  readonly label: string
  readonly outcome: "executor-changed" | "unconfirmed" | "uncertain"
  readonly offeredExecutorID?: string
  readonly at: string
}

export type CcaExperimentState = {
  readonly installationID: string
  readonly accountHash: string
  readonly status: "pending" | "completed" | "failed" | "uncertain"
  readonly createdAt: string
  readonly updatedAt: string
  readonly executorID?: string
  readonly customDisplayName?: string | null
  readonly displayName?: string
  readonly errorClassification?: string
  readonly selectedCapabilityRoots?: readonly CcaCapabilityRoot[]
  readonly renameDeclined?: CcaRenameDeclined
}

export type RunCcaRegistrationInput = {
  readonly credential: CcaCredential
  readonly installationID: string
  readonly displayName?: string
  readonly statePath: string
  readonly roots?: readonly CcaCapabilityRoot[]
  readonly fetch?: CcaFetch
  readonly refreshCredential?: CcaCredentialRefresh
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export function buildCcaHeaders(credential: CcaCredential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.access}`,
    "chatgpt-account-id": credential.accountID,
    originator: ccaDesktopOriginator,
    "User-Agent": ccaDesktopUserAgent(),
    "content-type": "application/json",
  }
}

export function buildCcaRegistrationBody(input: {
  readonly displayName: string
  readonly installationID: string
  readonly roots?: readonly CcaCapabilityRoot[]
}): string {
  const trimmedInstallationID = input.installationID.trim()
  if (!trimmedInstallationID) {
    throw new Error("Installation ID is required")
  }
  const name = input.displayName.trim()
  if (!name) {
    throw new Error("Display name is required")
  }
  return JSON.stringify({
    displayName: name.slice(0, 100),
    installation_id: trimmedInstallationID,
    selected_capability_roots: (input.roots ?? []).map((root) => ({ id: root.id, path: root.path })),
  })
}

export function decodeCcaRegistrationResponse(value: unknown): CcaRegistrationResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid CCA executor registration response: expected object")
  }
  const record = value as Record<string, unknown>
  const rawId = record.executor_id
  if (typeof rawId !== "string" || !rawId.trim()) {
    throw new Error("Invalid CCA executor registration response: missing or empty executor_id")
  }
  const rawDisplayName = record.custom_display_name
  if (rawDisplayName !== undefined && rawDisplayName !== null && typeof rawDisplayName !== "string") {
    throw new Error("Invalid CCA executor registration response: invalid custom_display_name")
  }
  return {
    executorID: rawId.trim(),
    customDisplayName: rawDisplayName,
  }
}

export function safeExecutorSummary(executorID: string): {
  readonly prefix: CcaPrefixClass
  readonly sha256: string
  readonly length: number
} {
  let prefix: CcaPrefixClass = "unknown"
  if (executorID.startsWith("ccarenv_b64_")) {
    prefix = "ccarenv_b64_"
  } else if (executorID.startsWith("ccarenv_")) {
    prefix = "ccarenv_"
  } else if (executorID.startsWith("env_e_")) {
    prefix = "env_e_"
  }
  return {
    prefix,
    sha256: createHash("sha256").update(executorID).digest("hex"),
    length: executorID.length,
  }
}

export async function loadCcaExperimentState(statePath: string): Promise<CcaExperimentState> {
  const text = await readFile(statePath, "utf8")
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Corrupt experiment state file: expected object")
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.installationID !== "string" || typeof record.status !== "string") {
    throw new Error("Corrupt experiment state file: missing required fields")
  }
  return parsed as CcaExperimentState
}

function retryableRegistrationStatus(status: number) {
  return status === 401 || status === 408 || status === 429 || status >= 500
}

async function postCcaRegistration(input: {
  readonly credential: CcaCredential
  readonly body: string
  readonly fetch?: CcaFetch
  readonly refreshCredential?: CcaCredentialRefresh
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}): Promise<CcaRegistrationResponse> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? defaultTimeoutMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
  const send = async (credential: CcaCredential) => {
    try {
      return await (input.fetch ?? fetch)(ccaExecutorRegistrationURL, {
        method: "POST",
        headers: buildCcaHeaders(credential),
        body: input.body,
        redirect: "error",
        signal,
      })
    } catch (error) {
      throw new CcaRegistrationError(
        error instanceof Error && error.name === "AbortError"
          ? "CCA executor registration timed out or was aborted"
          : "CCA executor registration request failed",
        true,
      )
    }
  }
  const discard = (response: Response) => response.body?.cancel().catch(() => {})

  let response = await send(input.credential)
  if (response.status === 401 && input.refreshCredential !== undefined) {
    await discard(response)
    const refreshed = await input.refreshCredential(input.credential).catch(() => undefined)
    if (refreshed === undefined || refreshed.accountID !== input.credential.accountID)
      throw new CcaRegistrationError("CCA executor registration needs a refreshed ChatGPT sign-in", true, 401)
    response = await send(refreshed)
  }

  const challenged = response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
  if (!response.ok || challenged) {
    await discard(response)
    throw new CcaRegistrationError(
      `CCA executor registration failed with status ${response.status}`,
      !challenged && retryableRegistrationStatus(response.status),
      response.status,
    )
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new CcaRegistrationError("CCA executor registration returned an unparseable response", false)
  }
  try {
    return decodeCcaRegistrationResponse(parsed)
  } catch {
    throw new CcaRegistrationError("CCA executor registration returned an invalid payload", false)
  }
}

export async function runCcaRegistration(input: RunCcaRegistrationInput): Promise<{
  readonly result: CcaRegistrationResponse
  readonly state: CcaExperimentState
}> {
  if (!input.statePath || !input.statePath.trim()) {
    throw new Error("State path is required")
  }
  const trimmedInstallationID = input.installationID.trim()
  if (!trimmedInstallationID) {
    throw new Error("Installation ID is required")
  }
  const name = (input.displayName ?? os.hostname()).trim()
  if (!name) {
    throw new Error("Display name is required")
  }
  const roots = input.roots ?? []
  const requestBody = buildCcaRegistrationBody({
    displayName: name,
    installationID: trimmedInstallationID,
    roots,
  })

  const now = new Date().toISOString()
  const reservedState: CcaExperimentState = {
    installationID: trimmedInstallationID,
    accountHash: createHash("sha256").update(input.credential.accountID).digest("hex"),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }

  const handle = await open(input.statePath, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(reservedState, null, 2), "utf8")
  } finally {
    await handle.close()
  }

  const writeStateUpdate = async (update: Partial<CcaExperimentState>) => {
    const updatedState: CcaExperimentState = {
      ...reservedState,
      ...update,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(input.statePath, JSON.stringify(updatedState, null, 2), { mode: 0o600 })
    return updatedState
  }

  let decoded: CcaRegistrationResponse
  try {
    decoded = await postCcaRegistration({ ...input, body: requestBody })
  } catch (error) {
    if (error instanceof CcaRegistrationError && !error.retryable) await writeStateUpdate({ status: "failed", errorClassification: "failed" })
    else await rm(input.statePath, { force: true })
    throw error
  }

  const completedState = await writeStateUpdate({
    status: "completed",
    executorID: decoded.executorID,
    customDisplayName: decoded.customDisplayName,
    displayName: name.slice(0, 100),
    selectedCapabilityRoots: roots,
  })

  return {
    result: decoded,
    state: completedState,
  }
}

type RegistrationRetryInput = {
  readonly credential: CcaCredential
  readonly fetch?: CcaFetch
  readonly refreshCredential?: CcaCredentialRefresh
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

async function postWithRetry(input: RegistrationRetryInput, body: string): Promise<CcaRegistrationResponse> {
  const wait = input.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }))
  const register = async (attempt: number): Promise<CcaRegistrationResponse> => {
    try {
      return await postCcaRegistration({ ...input, body })
    } catch (error) {
      if (attempt >= reregistrationAttempts || !(error instanceof CcaRegistrationError) || !error.retryable) throw error
      await wait(reregistrationRetryDelayMs, input.signal)
      return register(attempt + 1)
    }
  }
  return register(1)
}

export async function reregisterCcaExecutor(input: RegistrationRetryInput & {
  readonly state: CcaExperimentState
  readonly displayName?: string
  readonly statePath: string
  readonly roots: readonly CcaCapabilityRoot[]
}): Promise<{ readonly state: CcaExperimentState; readonly executorChanged: boolean }> {
  const displayName = (input.displayName ?? os.hostname()).trim().slice(0, 100)
  const body = buildCcaRegistrationBody({
    displayName,
    installationID: input.state.installationID,
    roots: input.roots,
  })
  const decoded = await postWithRetry(input, body)
  const executorChanged = decoded.executorID !== input.state.executorID
  const state: CcaExperimentState = {
    ...input.state,
    executorID: decoded.executorID,
    customDisplayName: decoded.customDisplayName,
    displayName,
    selectedCapabilityRoots: input.roots,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(input.statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
  return { state, executorChanged }
}

export type CcaRenameResult = {
  readonly outcome: "confirmed" | "executor-changed" | "unconfirmed" | "uncertain" | "unrecorded"
  readonly persisted: boolean
  readonly state: CcaExperimentState
}

export async function renameCcaExecutor(input: {
  readonly credential: CcaCredential
  readonly state: CcaExperimentState
  readonly label: string
  readonly statePath: string
  readonly fetch?: CcaFetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}): Promise<CcaRenameResult> {
  const label = input.label.trim().slice(0, 100)
  if (!label) throw new Error("Display name is required")
  input.signal?.throwIfAborted()
  const body = JSON.stringify({ installation_id: input.state.installationID.trim(), custom_display_name: label })
  const fenced = async () => {
    const raw = await readFile(input.statePath, "utf8").catch(() => undefined)
    if (raw === undefined) return undefined
    const current = await loadCcaExperimentState(input.statePath).catch(() => undefined)
    if (
      current === undefined ||
      current.accountHash !== input.state.accountHash ||
      current.installationID !== input.state.installationID ||
      current.executorID !== input.state.executorID
    )
      return undefined
    return { raw, current }
  }
  const write = async (state: CcaExperimentState) => {
    try {
      await writeFile(input.statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
  const declined = (record: Omit<CcaRenameDeclined, "label" | "at">): CcaRenameDeclined => ({ label, ...record, at: new Date().toISOString() })
  const before = await fenced()
  if (before === undefined) return { outcome: "unrecorded", persisted: false, state: input.state }
  const intent: CcaExperimentState = { ...before.current, renameDeclined: declined({ outcome: "uncertain" }), updatedAt: new Date().toISOString() }
  if (!(await write(intent))) return { outcome: "unrecorded", persisted: false, state: input.state }

  let dispatched = false
  const dispatch: CcaFetch = (url, init) => {
    if (init?.signal?.aborted) return Promise.reject(Object.assign(new Error("Executor rename aborted"), { name: "AbortError" }))
    dispatched = true
    return (input.fetch ?? fetch)(url, init)
  }
  let decoded: CcaRegistrationResponse
  try {
    decoded = await postCcaRegistration({ credential: input.credential, body, fetch: dispatch, timeoutMs: input.timeoutMs, signal: input.signal })
  } catch (error) {
    if (!dispatched) {
      await writeFile(input.statePath, before.raw, { mode: 0o600 }).catch(() => undefined)
      throw error
    }
    return { outcome: "uncertain", persisted: true, state: intent }
  }

  const resolve = async (
    outcome: "confirmed" | "executor-changed" | "unconfirmed",
    update: (current: CcaExperimentState) => CcaExperimentState,
  ): Promise<CcaRenameResult> => {
    const latest = await fenced()
    if (latest === undefined) return { outcome, persisted: false, state: intent }
    const state = update(latest.current)
    return { outcome, persisted: await write(state), state }
  }
  const stamp = (current: CcaExperimentState, record: CcaRenameDeclined): CcaExperimentState => ({ ...current, renameDeclined: record, updatedAt: new Date().toISOString() })
  if (decoded.executorID !== input.state.executorID)
    return resolve("executor-changed", (current) => stamp(current, declined({ outcome: "executor-changed", offeredExecutorID: decoded.executorID })))
  if (decoded.customDisplayName !== label) return resolve("unconfirmed", (current) => stamp(current, declined({ outcome: "unconfirmed" })))
  return resolve("confirmed", ({ renameDeclined: _intent, ...current }) => ({ ...current, customDisplayName: label, updatedAt: new Date().toISOString() }))
}
