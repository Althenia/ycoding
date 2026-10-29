import type { NativeDots } from "@ycoding-ai/core/dots/native"

export type CcaTaskWorkspaceHost = Pick<NativeDots.Host, "projectCatalog" | "assignProject" | "prepareWorkspace">

export interface CcaTaskWorkspaceAnswer {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export const ccaTaskWorkspaceFailure: CcaTaskWorkspaceAnswer = { stdout: "", stderr: "Desktop task request failed\n", exitCode: 1 }

const frameLimitBytes = 64 * 1024
const listFrameLimitBytes = 1024 * 1024
const signatureLength = 88
const nonceLength = 64
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

type Params = Readonly<Record<string, unknown>>
type Request =
  | { readonly id: string | number; readonly method: "taskProject/list"; readonly params: { readonly environmentId: string } }
  | { readonly id: string | number; readonly method: "taskProject/assign"; readonly params: { readonly environmentId: string; readonly projectId: string; readonly threadId: string } }
  | { readonly id: string | number; readonly method: "taskWorkspace/prepare"; readonly params: Params & { readonly environmentId: string; readonly cwd: string | null; readonly projectId?: string } }

function record(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function projectID(value: unknown): value is string {
  return text(value) && value.trim() === value
}

function onlyKeys(params: Params, keys: readonly string[]) {
  return Object.keys(params).every((key) => keys.includes(key))
}

function decode(encoded: string): unknown {
  if (!base64.test(encoded)) return undefined
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  } catch {
    return undefined
  }
}

function parse(message: unknown): Request | undefined {
  if (!record(message) || message.jsonrpc !== "2.0") return undefined
  const { id, method, params } = message
  if (typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id))) return undefined
  if (!record(params) || !text(params.environmentId)) return undefined
  if (method === "taskProject/list")
    return onlyKeys(params, ["environmentId"]) ? { id, method, params: { environmentId: params.environmentId } } : undefined
  if (method === "taskProject/assign") {
    if (!onlyKeys(params, ["environmentId", "projectId", "threadId"]) || !projectID(params.projectId) || !text(params.threadId)) return undefined
    return { id, method, params: { environmentId: params.environmentId, projectId: params.projectId, threadId: params.threadId } }
  }
  if (method !== "taskWorkspace/prepare") return undefined
  if (params.cwd !== null && !text(params.cwd)) return undefined
  if (params.includeModelDefaults !== undefined && typeof params.includeModelDefaults !== "boolean") return undefined
  if (params.projectId !== undefined && !projectID(params.projectId)) return undefined
  return { id, method, params: { ...params, environmentId: params.environmentId, cwd: params.cwd } }
}

function escapeNonAscii(json: string) {
  return json.replace(/[\u007f-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function frameBytes(request: Request, domain: string, field: string, value: unknown) {
  const payload = JSON.stringify({ domain, request: { ...request.params, nonce: "0".repeat(nonceLength) }, [field]: value })
  return Buffer.byteLength(JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { payload, signature: "A".repeat(signatureLength) } }))
}

async function respond(request: Request, environmentID: string, threadID: string | undefined, host: CcaTaskWorkspaceHost) {
  if (request.method === "taskProject/list") {
    const catalog = await host.projectCatalog({ environmentID })
    const value = {
      environmentId: catalog.environmentId,
      projects: catalog.projects.map((project) => ({ projectId: project.projectId, name: project.name, rootPaths: project.rootPaths })),
    }
    return frameBytes(request, "codex.taskProject.list.v1", "catalog", value) > listFrameLimitBytes ? undefined : value
  }
  if (request.method === "taskProject/assign") {
    const assigned = await host.assignProject({ environmentID, threadID: request.params.threadId, projectID: request.params.projectId })
    const value = { environmentId: assigned.environmentId, projectId: assigned.projectId, threadId: assigned.threadId }
    return frameBytes(request, "codex.taskProject.assign.v1", "project", value) > frameLimitBytes ? undefined : value
  }
  const prepared = await host.prepareWorkspace({
    environmentID,
    ...(threadID === undefined ? {} : { threadID }),
    cwd: request.params.cwd,
    ...(request.params.projectId === undefined ? {} : { projectID: request.params.projectId }),
  })
  const value = {
    cwd: prepared.cwd,
    runtimeWorkspaceRoots: prepared.runtimeWorkspaceRoots,
    ...(prepared.projectId === undefined ? {} : { projectId: prepared.projectId }),
  }
  return frameBytes(request, "codex.taskWorkspace.prepare.v1", "workspace", value) > frameLimitBytes ? undefined : value
}

export async function answerCcaTaskWorkspace(input: {
  readonly argv: readonly string[]
  readonly environmentID: string
  readonly threadID?: string
  readonly host: CcaTaskWorkspaceHost
}): Promise<CcaTaskWorkspaceAnswer | undefined> {
  const { argv } = input
  if (argv.length < 6 || argv[1] !== "-c" || argv[3] !== "task-workspace") return undefined
  const request = parse(decode(argv[5]))
  if (request === undefined || request.params.environmentId !== input.environmentID) return ccaTaskWorkspaceFailure
  try {
    const value = await respond(request, input.environmentID, input.threadID, input.host)
    if (value === undefined) return ccaTaskWorkspaceFailure
    return { stdout: escapeNonAscii(JSON.stringify(value)), stderr: "", exitCode: 0 }
  } catch {
    return ccaTaskWorkspaceFailure
  }
}
