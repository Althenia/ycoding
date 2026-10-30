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

export async function reregisterCcaExecutor(input: {
  readonly credential: CcaCredential
  readonly state: CcaExperimentState
  readonly displayName?: string
  readonly statePath: string
  readonly roots: readonly CcaCapabilityRoot[]
  readonly fetch?: CcaFetch
  readonly refreshCredential?: CcaCredentialRefresh
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly preserveExecutor?: boolean
}): Promise<{ readonly state: CcaExperimentState; readonly executorChanged: boolean }> {
  const displayName = (input.displayName ?? os.hostname()).trim().slice(0, 100)
  const body = buildCcaRegistrationBody({
    displayName,
    installationID: input.state.installationID,
    roots: input.roots,
  })
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
  const decoded = await register(1)
  const executorChanged = decoded.executorID !== input.state.executorID
  if (executorChanged && input.preserveExecutor) return { state: input.state, executorChanged }
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
