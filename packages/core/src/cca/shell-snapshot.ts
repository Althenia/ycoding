export * as CcaShellSnapshot from "./shell-snapshot"

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CcaCredentialBroker } from "./credential-broker"
import type { CcaAuthorizationGrant, CcaAuthorizationInput } from "./executor"
import { CCA_PROXY_ACTIVE_ENV_KEY, isCcaManagedProxyEnvVar } from "./network-proxy"
import { CcaPolicy } from "./policy"

export class CcaShellSnapshotError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = "CcaShellSnapshotError"
    this.code = code
  }
}

export class CcaShellSnapshotCaptureError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = "CcaShellSnapshotCaptureError"
    this.reason = reason
  }
}

export interface CcaShellSnapshotRequest {
  readonly scopeId: string
  readonly shell: { readonly name: string; readonly path: string }
}

export type CcaSnapshotShell = "bash" | "zsh" | "sh"
export type CcaShellSnapshotReplay = "file" | "environment"

export interface CcaParsedShellSnapshot {
  readonly state: string
  readonly fileSource: boolean
  readonly environment: Readonly<Record<string, string>>
}

export const CCA_SHELL_SNAPSHOT_FD = 10

const MAX_CACHED_SNAPSHOTS = 16
const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_FILE_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_SNAPSHOT_CAPTURE_BYTES = 8 * MAX_SNAPSHOT_BYTES
const MAX_FILE_SNAPSHOT_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOT_ENV_VALUE_BYTES = 60 * 1024
const MAX_SNAPSHOT_SCOPE_BYTES = 256
const SNAPSHOT_TIMEOUT_MS = 10_000
const SNAPSHOT_RETRY_BACKOFF_MS = 1_000
const MAX_SNAPSHOT_ATTEMPTS = 3
const SOURCE_MARKER = "CODEX_SNAPSHOT_SOURCE"
export const CCA_SNAPSHOT_BROKERED_VALUE_ENV_PREFIX = "CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_VALUE_"
export const CCA_SNAPSHOT_BROKERED_UNSET_ENV_PREFIX = "CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_UNSET_"
const CONFIGURED_VALUE_PREFIX = "__CODEX_SHELL_SNAPSHOT_CONFIGURED_"
export const CCA_SNAPSHOT_MASKING_FALLBACK_WARNING =
  "Credential masking is unavailable for this shell snapshot; running with unmasked credentials."
const READONLY_EXPORT_CHECK = `
for __codex_snapshot_key in \${(f)"$(builtin typeset +x)"}; do
  case "\${(tP)__codex_snapshot_key}" in *readonly*) exit 74 ;; esac
done
`

function validShellName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

export function buildCcaBrokeredCredentialExports(env: Readonly<Record<string, string>>, removeCopies: boolean): string {
  const blocks: string[] = []
  const copies = Object.keys(env)
    .filter((copy) => copy.startsWith(CCA_SNAPSHOT_BROKERED_VALUE_ENV_PREFIX))
    .map((copy) => [copy.slice(CCA_SNAPSHOT_BROKERED_VALUE_ENV_PREFIX.length), copy] as const)
    .filter(([key]) => validShellName(key))
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const values = copies.map(([key, copy]) => {
    const restore = `if [ -z "\${${copy}+x}" ]; then exit 1; fi\nif [ -n "\${${key}+x}" ] && [ -n "\${${key}}" ] && [ "\${${key}}" != "\${${copy}}" ]; then export ${key}="\${${copy}}" || exit 1; fi\nif [ -n "\${${key}+x}" ] && [ -n "\${${key}}" ] && [ "\${${key}}" != "\${${copy}}" ]; then exit 1; fi`
    return removeCopies ? `${restore}\nunset ${copy} || exit 1` : restore
  })
  if (values.length > 0) blocks.push(values.join("\n"))
  const markers = Object.keys(env)
    .filter((marker) => marker.startsWith(CCA_SNAPSHOT_BROKERED_UNSET_ENV_PREFIX))
    .map((marker) => [marker.slice(CCA_SNAPSHOT_BROKERED_UNSET_ENV_PREFIX.length), marker] as const)
    .filter(([key]) => validShellName(key))
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const unsets = markers.map(([key, marker]) => {
    const restore = `if [ -z "\${${marker}+x}" ]; then exit 1; fi\nif [ -n "\${${key}+x}" ] && [ -n "\${${key}}" ]; then unset ${key} || exit 1; fi\nif [ -n "\${${key}+x}" ] && [ -n "\${${key}}" ]; then exit 1; fi`
    return removeCopies ? `${restore}\nunset ${marker} || exit 1` : restore
  })
  if (unsets.length > 0) blocks.push(unsets.join("\n"))
  if (blocks.length === 0) return ""
  return `case $- in\n  *x*) __CODEX_SNAPSHOT_BROKER_XTRACE=1; set +x ;;\n  *) __CODEX_SNAPSHOT_BROKER_XTRACE= ;;\nesac\n${blocks.join("\n")}\nif [ -n "$__CODEX_SNAPSHOT_BROKER_XTRACE" ]; then\n  unset __CODEX_SNAPSHOT_BROKER_XTRACE\n  set -x\nelse\n  unset __CODEX_SNAPSHOT_BROKER_XTRACE\nfi`
}
const THREAD_ID_ENV = "CODEX_THREAD_ID"
const TOOL_CALL_ID_ENV = "CODEX_TOOL_CALL_ID"

const COMMAND_HELPER = `__codex_snapshot_command() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@"
  else
    command -p "$@"
  fi
}`

const ENVIRONMENT_CAPTURE = `if command -v env >/dev/null 2>&1; then
  "env" -0
else
  "$(PATH="$(command -p getconf PATH)" command -v env)" -0
fi
`

const ZSH_STARTUP = `if [[ -n "\${ZDOTDIR-}" ]]; then
  rc="$ZDOTDIR/.zshrc"
elif [[ -n "\${HOME-}" ]]; then
  rc="$HOME/.zshrc"
else
  rc=
fi
[[ -r "$rc" ]] && . "$rc"
`

const BASH_STARTUP = `if [ -z "\${BASH_ENV-}" ] && [ -n "\${HOME-}" ] && [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
`

const POSIX_ENV_PATH_EXPANSION = `__codex_snapshot_expand_env() (
  set +u
  __codex_snapshot_getenv() {
    __codex_env_expanded=$(
      if command -v printenv >/dev/null 2>&1; then
        printenv "$1"
      elif [ "$1" = PATH ]; then
        [ "\${PATH+x}" = x ] && printf '%s\\n' "$PATH"
      else
        command -p printenv "$1"
      fi && printf '.'
    ) || return 1
    __codex_env_expanded=\${__codex_env_expanded%?}
    __codex_env_expanded=\${__codex_env_expanded%?}
  }
  __codex_env_file=$1
  case "$__codex_env_file" in
    '~/'*) __codex_env_file="\${HOME-}/\${__codex_env_file#*/}" ;;
    '\${PATH%%:*}') __codex_env_file="\${PATH%%:*}" ;;
    '\${PATH%%:*}/'*) __codex_env_file="\${PATH%%:*}/\${__codex_env_file#*/}" ;;
    '\${'*)
      __codex_env_body=\${__codex_env_file#\\$\\{}
      case "$__codex_env_body" in
        *\\}*)
          __codex_env_name=\${__codex_env_body%%\\}*}
          __codex_env_suffix=\${__codex_env_body#*\\}}
          case "$__codex_env_name" in
            *:-*)
              __codex_env_default=\${__codex_env_name#*:-}
              __codex_env_name=\${__codex_env_name%%:-*}
              __codex_env_has_default=1
              ;;
            *) __codex_env_has_default= ;;
          esac
          case "$__codex_env_name" in
            ''|[0-9]*|*[!A-Za-z0-9_]*) ;;
            *)
              case "$__codex_env_suffix" in
                ''|/*)
                  if __codex_snapshot_getenv "$__codex_env_name" 2>/dev/null &&
                    { [ -n "$__codex_env_expanded" ] || [ -z "$__codex_env_has_default" ]; }; then
                    __codex_env_file="$__codex_env_expanded$__codex_env_suffix"
                  elif [ -n "$__codex_env_has_default" ]; then
                    __codex_env_default=$(__codex_snapshot_expand_env "$__codex_env_default")
                    __codex_env_file="$__codex_env_default$__codex_env_suffix"
                  fi
                  ;;
              esac
              ;;
          esac
          ;;
      esac
      ;;
    '$'*)
      __codex_env_name=\${__codex_env_file%%/*}
      __codex_env_name=\${__codex_env_name#\\$}
      case "$__codex_env_name" in
        ''|[0-9]*|*[!A-Za-z0-9_]*) ;;
        *)
          if __codex_snapshot_getenv "$__codex_env_name" 2>/dev/null; then
            if [ "$__codex_env_file" = "\\$$__codex_env_name" ]; then
              __codex_env_file=$__codex_env_expanded
            else
              __codex_env_file="$__codex_env_expanded/\${__codex_env_file#*/}"
            fi
          fi
          ;;
      esac
      ;;
  esac
  printf '%s' "$__codex_env_file"
)`

const SH_STARTUP = `${POSIX_ENV_PATH_EXPANSION}
if [ -n "\${ENV-}" ]; then
  __codex_env_file=$(__codex_snapshot_expand_env "$ENV")
  if [ -r "$__codex_env_file" ] && [ ! -d "$__codex_env_file" ]; then
    case "$__codex_env_file" in
      /*) . "$__codex_env_file" ;;
      *) . "./$__codex_env_file" ;;
    esac
  fi
  command unset __codex_env_file
fi
command unset -f __codex_snapshot_expand_env
`

const ZSH_CAPTURE = `print '# Snapshot file'
print '# Unset all aliases to avoid conflicts with functions'
print 'unalias -a 2>/dev/null || true'
print '# Functions'
functions
print ''
printf '{\\n'
${COMMAND_HELPER}
setopt_count=$(setopt | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
print "# setopts $setopt_count"
setopt | __codex_snapshot_command sed 's/^/setopt /'
print ''
printf '\\0'
alias_count=$(\\alias -L | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
print "# aliases $alias_count"
(\\setopt NO_RC_QUOTES; \\alias -L)
print ''
printf "case '' in '') ;; esac\\n}\\n"
printf '\\0'
printf '\\0'
${ENVIRONMENT_CAPTURE}`

const BASH_CAPTURE = `echo '# Snapshot file'
echo '# Unset all aliases to avoid conflicts with functions'
echo 'unalias -a 2>/dev/null || true'
shopt -p || true
echo '# Functions'
declare -f
echo ''
printf '{\\n'
${COMMAND_HELPER}
bash_opts=$(set -o | __codex_snapshot_command awk '$2=="on"{print $1}')
bash_opt_count=$(printf '%s\\n' "$bash_opts" | __codex_snapshot_command sed '/^$/d' | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
echo "# setopts $bash_opt_count"
if [ -n "$bash_opts" ]; then
  printf 'set -o %s\\n' $bash_opts
fi
echo ''
printf '\\0'
alias_count=$(\\alias -p | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
echo "# aliases $alias_count"
\\alias -p
echo ''
printf "case '' in '') ;; esac\\n}\\n"
printf '\\0'
printf '\\0'
${ENVIRONMENT_CAPTURE}`

const SH_CAPTURE = `echo '# Snapshot file'
if [ -n "\${BASH_VERSINFO-}" ]; then
  echo '# Bash-backed sh'
  shopt -p || true
fi
echo '# Unset all aliases to avoid conflicts with functions'
unalias -a 2>/dev/null || true
echo '# Functions'
if command -v typeset >/dev/null 2>&1; then
  typeset -f
elif command -v declare >/dev/null 2>&1; then
  declare -f
fi
echo ''
${COMMAND_HELPER}
if set -o >/dev/null 2>&1; then
  sh_opts=$(set -o | __codex_snapshot_command awk '$2=="on"{print $1}')
  sh_opt_count=$(printf '%s\\n' "$sh_opts" | __codex_snapshot_command sed '/^$/d' | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
  echo "# setopts $sh_opt_count"
  if [ -n "$sh_opts" ]; then
    printf 'set -o %s\\n' $sh_opts
  fi
else
  echo '# setopts 0'
fi
echo ''
printf '\\0'
if alias >/dev/null 2>&1; then
  alias_count=$(alias | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
  echo "# aliases $alias_count"
  alias
  echo ''
else
  echo '# aliases 0'
fi
printf '\\0'
printf '\\0'
printf '\\0'
${ENVIRONMENT_CAPTURE}`

function captureScript(shell: CcaSnapshotShell, probe: boolean): string {
  const body = shell === "zsh" ? `${ZSH_STARTUP}${ZSH_CAPTURE}` : shell === "bash" ? `${BASH_STARTUP}${BASH_CAPTURE}` : `${SH_STARTUP}${SH_CAPTURE}`
  const marker = (flag: number) => `printf '\\0%s\\0%s\\0' '${SOURCE_MARKER}' ${flag}`
  const prefix = probe
    ? `if case '' in '') ;; esac 2>/dev/null </dev/fd/${CCA_SHELL_SNAPSHOT_FD}; then ${marker(1)}; else ${marker(0)}; fi\n`
    : `${marker(0)}\n`
  return `${prefix}${body}`
}

function takeRecord(state: { remaining: Buffer }): Buffer | undefined {
  const boundary = state.remaining.indexOf(0)
  if (boundary < 0) return undefined
  const record = state.remaining.subarray(0, boundary)
  state.remaining = state.remaining.subarray(boundary + 1)
  return record
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes)
  } catch {
    return undefined
  }
}

function invalidCapture(message = "invalid shell snapshot capture"): CcaShellSnapshotCaptureError {
  return new CcaShellSnapshotCaptureError("invalid_capture", message)
}

export function parseCcaShellSnapshot(
  shell: CcaSnapshotShell,
  output: Uint8Array,
  envPolicy: unknown,
  replay: CcaShellSnapshotReplay,
): CcaParsedShellSnapshot {
  const cursor = { remaining: Buffer.from(output.buffer, output.byteOffset, output.byteLength) }
  const stateRecord = takeRecord(cursor)
  const start = stateRecord?.indexOf("# Snapshot file") ?? -1
  const stateText = stateRecord && start >= 0 ? decodeUtf8(stateRecord.subarray(start)) : undefined
  const aliasRecord = takeRecord(cursor)
  const aliases = aliasRecord ? decodeUtf8(aliasRecord) : undefined
  if (stateText === undefined || aliases === undefined) throw invalidCapture()
  for (;;) {
    const key = takeRecord(cursor)
    if (key === undefined) throw invalidCapture()
    if (key.length === 0) break
    if (takeRecord(cursor) === undefined) throw invalidCapture()
  }
  if (shell === "sh") {
    for (;;) {
      const entry = takeRecord(cursor)
      if (entry === undefined) throw invalidCapture()
      if (entry.length === 0) break
    }
  }
  const rawEnvironment = cursor.remaining
  const state = `${stateText}${aliases}`
  if (rawEnvironment.length > MAX_SNAPSHOT_BYTES) {
    throw new CcaShellSnapshotCaptureError("environment_too_large", `shell snapshot environment exceeds ${MAX_SNAPSHOT_BYTES} bytes`)
  }
  const stateLimit = replay === "file" ? MAX_FILE_SNAPSHOT_BYTES : MAX_SNAPSHOT_BYTES - rawEnvironment.length
  if (Buffer.byteLength(state) > stateLimit) {
    throw new CcaShellSnapshotCaptureError("state_too_large", `shell snapshot state exceeds ${stateLimit} bytes`)
  }

  const captured: Record<string, string> = {}
  for (const entry of rawEnvironment.toString("latin1").split("\0")) {
    if (!entry) continue
    const decoded = decodeUtf8(Buffer.from(entry, "latin1"))
    const equals = decoded?.indexOf("=") ?? -1
    if (decoded === undefined || equals < 0) continue
    captured[decoded.slice(0, equals)] = decoded.slice(equals + 1)
  }
  if (CCA_PROXY_ACTIVE_ENV_KEY in captured) {
    for (const [key, value] of Object.entries(captured)) {
      if (isCcaManagedProxyEnvVar(key, value)) delete captured[key]
    }
  }
  let environment: Record<string, string>
  try {
    environment =
      envPolicy == null
        ? CcaPolicy.buildProcessEnv({ base: {}, env: captured })
        : CcaPolicy.buildProcessEnv({
            base: captured,
            envPolicy: typeof envPolicy === "object" && !Array.isArray(envPolicy) ? { ...envPolicy, inherit: "all" } : envPolicy,
          })
  } catch {
    throw new CcaShellSnapshotCaptureError("invalid_environment", "shell snapshot environment violates the environment policy")
  }
  for (const key of [THREAD_ID_ENV, TOOL_CALL_ID_ENV, "PWD", "OLDPWD"]) delete environment[key]
  return { state, fileSource: replay === "file", environment }
}

function materialize(shell: "bash" | "zsh", state: string, root: string): number {
  const directory = fs.mkdtempSync(path.join(root, "cca-shell-snapshot-"))
  const file = path.join(directory, "state")
  let writer: number | undefined
  let reader: number | undefined
  try {
    writer = fs.openSync(file, "wx", 0o600)
    reader = fs.openSync(file, "r")
    fs.unlinkSync(file)
    fs.rmdirSync(directory)
    if (fs.fstatSync(reader).nlink !== 0) throw new Error("shell snapshot transport is still linked")
    const close =
      shell === "bash"
        ? `\\exec ${CCA_SHELL_SNAPSHOT_FD}<&-\n`
        : `__codex_snapshot_fd=${CCA_SHELL_SNAPSHOT_FD}\nexec {__codex_snapshot_fd}<&-\nunset __codex_snapshot_fd\n`
    const content = Buffer.from(`${close}${state}`)
    for (let offset = 0; offset < content.length; ) offset += fs.writeSync(writer, content, offset)
    fs.closeSync(writer)
    writer = undefined
    const opened = reader
    reader = undefined
    return opened
  } finally {
    if (writer !== undefined) fs.closeSync(writer)
    if (reader !== undefined) fs.closeSync(reader)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

export interface CcaShellSnapshotLaunch {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly fd?: number
  readonly release: () => void
}

type StdioEntry = "pipe" | "ignore" | "inherit"

export function ccaShellSnapshotStdio(
  base: readonly [StdioEntry, StdioEntry, StdioEntry],
  launch: CcaShellSnapshotLaunch,
): StdioOptions {
  if (launch.fd === undefined) return [...base]
  return [...base, ...Array<"ignore">(CCA_SHELL_SNAPSHOT_FD - base.length).fill("ignore"), launch.fd]
}

export interface CcaShellSnapshotPrepareInput {
  readonly sessionId: string
  readonly processId: string
  readonly request: CcaShellSnapshotRequest
  readonly argv: readonly string[]
  readonly arg0?: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly requestEnv: Readonly<Record<string, string>>
  readonly envPolicy?: unknown
  readonly sandboxKey?: string
  readonly credentialBroker?: CcaCredentialBroker
}

export interface CcaShellSnapshotCache {
  readonly prepare: (input: CcaShellSnapshotPrepareInput) => Promise<CcaShellSnapshotLaunch | undefined>
  readonly close: () => Promise<void>
}

export interface CreateCcaShellSnapshotCacheOptions {
  readonly authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly tempRoot?: string
}

interface CaptureCell {
  readonly promise: Promise<CcaParsedShellSnapshot | undefined>
  settled?: { readonly snapshot: CcaParsedShellSnapshot } | { readonly retryAt: number }
}

interface CacheEntry {
  readonly key: string
  attempts: number
  cell: CaptureCell
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

export function createCcaShellSnapshotCache(options: CreateCcaShellSnapshotCacheOptions): CcaShellSnapshotCache {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const tempRoot = options.tempRoot ?? os.tmpdir()
  const entries: CacheEntry[] = []
  const running = new Set<ChildProcess>()
  let closed = false

  const runCapture = async (
    input: CcaShellSnapshotPrepareInput,
    shell: CcaSnapshotShell,
    protectedCapture: boolean,
  ): Promise<CcaParsedShellSnapshot> => {
    let grant: CcaAuthorizationGrant
    try {
      grant = await options.authorize({
        action: "shell",
        resources: [`${input.request.shell.path} -lc <shell snapshot capture>`],
        metadata: { processId: input.processId, cwd: input.cwd, shellSnapshotScope: input.request.scopeId },
      })
    } catch {
      throw new CcaShellSnapshotCaptureError("authorization_denied", "shell snapshot capture was not authorized")
    }
    if (!grant || typeof grant.release !== "function") {
      throw new CcaShellSnapshotCaptureError("authorization_denied", "shell snapshot capture was not authorized")
    }
    let probe: number | undefined
    try {
      if (shell !== "sh") {
        try {
          probe = materialize(shell, "", tempRoot)
        } catch {
          probe = undefined
        }
      }
      const limit = probe === undefined ? MAX_SNAPSHOT_CAPTURE_BYTES : MAX_FILE_SNAPSHOT_CAPTURE_BYTES
      const argv = [...input.argv]
      argv[2] = `${captureScript(shell, probe !== undefined)}${protectedCapture && shell === "zsh" ? READONLY_EXPORT_CHECK : ""}`
      const env = { ...input.env }
      delete env[TOOL_CALL_ID_ENV]
      if (closed) throw new CcaShellSnapshotCaptureError("closed", "shell snapshot cache closed")
      const child = spawn(argv[0], argv.slice(1), {
        cwd: input.cwd,
        env,
        argv0: input.arg0,
        detached: true,
        stdio: probe === undefined ? ["ignore", "pipe", "ignore"] : ccaShellSnapshotStdio(["ignore", "pipe", "ignore"], { argv, env, fd: probe, release: () => {} }),
        windowsHide: true,
      })
      if (probe !== undefined) {
        fs.closeSync(probe)
        probe = undefined
      }
      running.add(child)
      const output = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        const fail = (reason: string, message: string) => {
          clearTimeout(timer)
          killGroup(child)
          reject(new CcaShellSnapshotCaptureError(reason, message))
        }
        const timer = setTimeout(() => fail("timeout", "shell snapshot capture timed out"), SNAPSHOT_TIMEOUT_MS)
        child.stdout!.on("data", (data: Buffer) => {
          size += data.length
          if (size > limit) return fail("capture_too_large", `shell snapshot capture exceeds ${limit} bytes`)
          chunks.push(data)
        })
        child.once("error", () => fail("spawn_failed", "cannot capture shell snapshot"))
        child.once("close", (code, signal) => {
          clearTimeout(timer)
          if (code !== 0) {
            killGroup(child)
            return reject(new CcaShellSnapshotCaptureError("nonzero_exit", `shell snapshot capture exited with ${code ?? signal}`))
          }
          resolve(Buffer.concat(chunks))
        })
      }).finally(() => running.delete(child))
      const marker = Buffer.from(`\0${SOURCE_MARKER}\0`)
      const markerAt = output.indexOf(marker)
      if (markerAt < 0) throw invalidCapture("missing snapshot source probe")
      const flagged = output.subarray(markerAt + marker.length)
      if (flagged.length < 2) throw invalidCapture("incomplete snapshot source probe")
      const replay: CcaShellSnapshotReplay = flagged[0] === 0x31 && flagged[1] === 0 ? "file" : "environment"
      if (replay === "environment" && output.length > MAX_SNAPSHOT_CAPTURE_BYTES) {
        throw new CcaShellSnapshotCaptureError("capture_too_large", `shell snapshot capture exceeds ${MAX_SNAPSHOT_CAPTURE_BYTES} bytes`)
      }
      return parseCcaShellSnapshot(shell, flagged.subarray(2), input.envPolicy, replay)
    } finally {
      if (probe !== undefined) fs.closeSync(probe)
      await grant.release().catch(() => {})
    }
  }

  const lookup = (key: string, create: () => CaptureCell): CaptureCell => {
    const index = entries.findIndex((entry) => entry.key === key)
    if (index < 0) {
      entries.push({ key, attempts: 1, cell: create() })
      if (entries.length > MAX_CACHED_SNAPSHOTS) entries.shift()
      return entries[entries.length - 1].cell
    }
    const [entry] = entries.splice(index, 1)
    const settled = entry.cell.settled
    if (settled && "retryAt" in settled && entry.attempts < MAX_SNAPSHOT_ATTEMPTS && now() >= settled.retryAt) {
      entry.attempts++
      entry.cell = create()
    }
    entries.push(entry)
    return entry.cell
  }

  const buildLaunch = (
    input: CcaShellSnapshotPrepareInput,
    shell: CcaSnapshotShell,
    snapshot: CcaParsedShellSnapshot,
    replayEnv?: Record<string, string>,
  ): CcaShellSnapshotLaunch | undefined => {
    const protectedLaunch = replayEnv !== undefined
    const env: Record<string, string> = replayEnv ?? { ...input.env, ...snapshot.environment }
    if (!protectedLaunch) for (const [name, value] of Object.entries(input.requestEnv)) env[name] = input.env[name] ?? value
    let fd: number | undefined
    let restore: string
    if (snapshot.fileSource && shell !== "sh") {
      try {
        fd = materialize(shell, snapshot.state, tempRoot)
      } catch {
        return undefined
      }
      restore = `. /dev/fd/${CCA_SHELL_SNAPSHOT_FD}`
    } else {
      const bytes = Buffer.from(snapshot.state)
      const names: string[] = []
      for (let offset = 0; offset < bytes.length; ) {
        let end = Math.min(bytes.length, offset + MAX_SNAPSHOT_ENV_VALUE_BYTES)
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
        const name = `__CODEX_SHELL_SNAPSHOT_STATE_${names.length}`
        env[name] = bytes.subarray(offset, end).toString("utf8")
        names.push(name)
        offset = end
      }
      restore = `eval "unset ${names.join(" ")}\n${names.map((name) => (protectedLaunch ? `\${${name}:?missing shell snapshot chunk}` : `\${${name}}`)).join("")}"`
    }
    const [flag, startup] = shell === "bash" ? ["-pc", "set +o privileged\n"] : shell === "zsh" ? ["-fc", "setopt RCS\n"] : ["-c", ""]
    const argv = [...input.argv]
    argv[1] = flag
    argv[2] = protectedLaunch
      ? `${startup}if ! ${restore} >/dev/null 2>&1; then printf 'failed to restore shell snapshot\\n' >&2; exit 1; fi\n${input.argv[2]}`
      : `${startup}if ! ${restore} >/dev/null; then printf 'failed to restore shell snapshot\\n' >&2; fi\n${input.argv[2]}`
    let released = false
    return {
      argv,
      env,
      ...(fd === undefined ? {} : { fd }),
      release: () => {
        if (released || fd === undefined) return
        released = true
        fs.closeSync(fd)
      },
    }
  }

  const fallbackLaunch = (input: CcaShellSnapshotPrepareInput): CcaShellSnapshotLaunch => {
    const argv = [...input.argv]
    argv[2] = `\\builtin printf '%s\\n' '${CCA_SNAPSHOT_MASKING_FALLBACK_WARNING}' >&2\n${input.argv[2]}`
    return { argv, env: { ...input.env }, release: () => {} }
  }

  const prepareProtected = async (
    input: CcaShellSnapshotPrepareInput,
    shell: CcaSnapshotShell,
    broker: CcaCredentialBroker,
  ): Promise<CcaShellSnapshotLaunch | undefined> => {
    let snapshot: CcaParsedShellSnapshot
    try {
      snapshot = await runCapture(input, shell, true)
    } catch {
      return fallbackLaunch(input)
    }
    if (closed) return undefined
    const internal = (key: string) =>
      key.startsWith(CCA_SNAPSHOT_BROKERED_VALUE_ENV_PREFIX) || key.startsWith(CCA_SNAPSHOT_BROKERED_UNSET_ENV_PREFIX) || key.startsWith(CONFIGURED_VALUE_PREFIX)
    const managed = Object.fromEntries(Object.entries(input.env).filter(([key, value]) => isCcaManagedProxyEnvVar(key, value)))
    const configured = Object.fromEntries(
      Object.entries(input.requestEnv).filter(([key, value]) => !internal(key) && !isCcaManagedProxyEnvVar(key, value)),
    )
    const combined: Record<string, string> = { ...snapshot.environment, ...configured, ...managed }
    for (const key of Object.keys(combined)) if (internal(key)) delete combined[key]
    const masked = broker.maskEnvironment(combined).env
    const replayEnv: Record<string, string> = { ...masked }
    let exports = ""
    for (const key of broker.brokeredKeys(masked)) {
      if (isCcaManagedProxyEnvVar(key, masked[key] ?? "")) continue
      if (!validShellName(key)) return fallbackLaunch(input)
      const copy = `${CCA_SNAPSHOT_BROKERED_VALUE_ENV_PREFIX}${key}`
      replayEnv[copy] = masked[key] ?? ""
      exports += `\\builtin export ${key}="\${${copy}}" || exit 1\n`
    }
    let overrides = ""
    for (const [index, key] of Object.keys(configured).filter(validShellName).toSorted().entries()) {
      const value = masked[key]
      if (value === undefined) continue
      const copy = `${CONFIGURED_VALUE_PREFIX}${index}`
      replayEnv[copy] = value
      overrides += `if [ -z "\${${copy}+x}" ]; then exit 1; fi\n\\builtin export ${key}="\${${copy}}" || exit 1\n\\builtin unset ${copy} || exit 1\n`
    }
    const before = buildCcaBrokeredCredentialExports(replayEnv, false)
    const after = buildCcaBrokeredCredentialExports(replayEnv, true)
    const state = `${before}\n${exports}${broker.maskText(snapshot.state)}\n${overrides}\n\\builtin test "$?" -eq 0 || exit 1\n${after}\n`
    const environmentBytes = Object.entries(replayEnv).reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value) + 2, 0)
    const stateLimit = snapshot.fileSource ? MAX_FILE_SNAPSHOT_BYTES : MAX_SNAPSHOT_BYTES - environmentBytes
    if (environmentBytes > MAX_SNAPSHOT_BYTES || Buffer.byteLength(state) > stateLimit) return fallbackLaunch(input)
    return buildLaunch(input, shell, { ...snapshot, state }, replayEnv) ?? fallbackLaunch(input)
  }

  const prepare = async (input: CcaShellSnapshotPrepareInput): Promise<CcaShellSnapshotLaunch | undefined> => {
    if (closed) throw new CcaShellSnapshotError(-32603, "Executor session closed")
    if (platform === "win32") throw new CcaShellSnapshotError(-32602, "shell snapshots are unsupported on this platform")
    const scopeBytes = Buffer.byteLength(input.request.scopeId)
    if (scopeBytes === 0 || scopeBytes > MAX_SNAPSHOT_SCOPE_BYTES) {
      throw new CcaShellSnapshotError(-32602, `shell snapshot scope must be non-empty and at most ${MAX_SNAPSHOT_SCOPE_BYTES} bytes`)
    }
    if (input.argv.length < 3 || input.argv[0] !== input.request.shell.path || input.argv[1] !== "-lc") return undefined
    const name = input.request.shell.name
    if (name !== "bash" && name !== "zsh" && name !== "sh") {
      throw new CcaShellSnapshotError(-32602, `shell snapshots are unsupported for shell \`${name}\``)
    }
    const shell: CcaSnapshotShell = name
    if (input.credentialBroker) return prepareProtected(input, shell, input.credentialBroker)
    const key = JSON.stringify([
      input.sessionId,
      input.request.scopeId,
      input.request.shell.name,
      input.request.shell.path,
      input.cwd,
      input.envPolicy ?? null,
      input.sandboxKey ?? null,
    ])
    const cell = lookup(key, () => {
      const created: CaptureCell = {
        promise: runCapture(input, shell, false).then(
          (snapshot) => {
            created.settled = { snapshot }
            return snapshot
          },
          () => {
            created.settled = { retryAt: now() + SNAPSHOT_RETRY_BACKOFF_MS }
            return undefined
          },
        ),
      }
      return created
    })
    const snapshot = await cell.promise
    if (!snapshot || closed) return undefined
    return buildLaunch(input, shell, snapshot)
  }

  const close = async () => {
    closed = true
    for (const child of running) killGroup(child)
    entries.length = 0
  }

  return { prepare, close }
}
