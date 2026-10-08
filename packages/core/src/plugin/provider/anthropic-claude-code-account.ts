export interface ClaudeCodeCredentials {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly subscriptionType?: string
}

export interface ClaudeCodeAccount {
  readonly label: string
  readonly source: string
  readonly credentials: ClaudeCodeCredentials
}

export interface ClaudeCodeCredentialSource {
  readonly list: () => Promise<ClaudeCodeAccount[]>
  readonly read: (source: string) => Promise<ClaudeCodeCredentials | null>
  readonly write: (source: string, credentials: ClaudeCodeCredentials) => Promise<boolean>
}

export interface ClaudeCodeCredentialStore {
  readonly accounts: () => Promise<ClaudeCodeAccount[]>
  readonly resolve: (source: string) => Promise<ClaudeCodeCredentials | null>
  readonly reload: (source: string) => Promise<ClaudeCodeCredentials | null>
  readonly refresh: (source: string) => Promise<ClaudeCodeCredentials | null>
}

export interface ClaudeCodeRequestEvent {
  readonly event: string
  readonly data?: Readonly<Record<string, unknown>>
}

const oauthURL = "https://claude.ai/v1/oauth/token"
const oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const expiryBuffer = 60_000
const cacheTTL = 30_000
const refreshing = new Map<string, Promise<ClaudeCodeCredentials | null>>()

export function parseClaudeCodeCredentials(raw: string): ClaudeCodeCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!record(parsed)) return null
  const value = record(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed
  if (record(parsed.mcpOAuth) && typeof value.accessToken !== "string") return null
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken.trim() ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number"
  )
    return null
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: Math.trunc(value.expiresAt),
    subscriptionType: typeof value.subscriptionType === "string" ? value.subscriptionType : undefined,
  }
}

export function buildClaudeCodeAccountLabels(credentials: ReadonlyArray<ClaudeCodeCredentials>) {
  const base = credentials.map((item) =>
    item.subscriptionType
      ? `Claude ${item.subscriptionType.charAt(0).toUpperCase()}${item.subscriptionType.slice(1)}`
      : "Claude",
  )
  const counts = new Map<string, number>()
  base.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1))
  const seen = new Map<string, number>()
  return base.map((label) => {
    if ((counts.get(label) ?? 0) === 1) return label
    const index = (seen.get(label) ?? 0) + 1
    seen.set(label, index)
    return `${label} ${index}`
  })
}

export function buildClaudeCodeKeychainUpdate(source: string, account: string, value: string) {
  const quote = (input: string) => `"${input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  return {
    command: "/usr/bin/security",
    args: ["-i"] as const,
    input: `add-generic-password -s ${quote(source)} -a ${quote(account)} -U -X ${Buffer.from(value).toString("hex")}\n`,
  }
}

export function createClaudeCodeCredentialStore(input: {
  readonly source: ClaudeCodeCredentialSource
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly cacheTTL?: number
  readonly onEvent?: (event: ClaudeCodeRequestEvent) => void
}): ClaudeCodeCredentialStore {
  const fetcher = input.fetch ?? fetch
  const now = input.now ?? Date.now
  const ttl = input.cacheTTL ?? cacheTTL
  const cache = new Map<string, { readonly credentials: ClaudeCodeCredentials; readonly cachedAt: number }>()
  const fresh = (value: ClaudeCodeCredentials) => value.expiresAt > now() + expiryBuffer
  const remember = (source: string, credentials: ClaudeCodeCredentials) => {
    cache.set(source, { credentials, cachedAt: now() })
    return credentials
  }

  const refreshCurrent = async (source: string, current: ClaudeCodeCredentials) => {
    const key = JSON.stringify([source, current.accessToken, current.refreshToken])
    const active = refreshing.get(key)
    if (active) return active
    const operation = (async () => {
      if (current.refreshToken) {
        const refreshed = await refreshOAuth(current.refreshToken, fetcher, now())
        const next = refreshed ? { ...refreshed, subscriptionType: current.subscriptionType } : null
        if (next && fresh(next)) {
          const latest = await input.source.read(source)
          if (!latest || latest.accessToken !== current.accessToken || latest.refreshToken !== current.refreshToken)
            return null
          const written = await input.source.write(source, next)
          input.onEvent?.({
            event: "oauth-refresh",
            data: { source, written },
          })
          return remember(source, next)
        }
      }
      return null
    })().finally(() => refreshing.delete(key))
    refreshing.set(key, operation)
    return operation
  }

  const reload = async (source: string) => {
    let credentials: ClaudeCodeCredentials | null
    try {
      credentials = await input.source.read(source)
    } catch {
      cache.delete(source)
      return null
    }
    if (!credentials || !credentials.accessToken.trim() || !fresh(credentials)) {
      cache.delete(source)
      return null
    }
    return remember(source, credentials)
  }

  const resolve = async (source: string) => {
    const time = now()
    const cached = cache.get(source)
    if (cached && time - cached.cachedAt < ttl && fresh(cached.credentials)) return cached.credentials
    let current: ClaudeCodeCredentials | null
    try {
      current = await input.source.read(source)
    } catch {
      current = cached?.credentials ?? null
    }
    if (!current) {
      cache.delete(source)
      return null
    }
    if (fresh(current)) return remember(source, current)
    return refreshCurrent(source, current)
  }

  return {
    accounts: async () => {
      const discovered = await input.source.list()
      for (const source of cache.keys()) {
        if (!discovered.some((account) => account.source === source)) cache.delete(source)
      }
      discovered.forEach((account) => {
        if (fresh(account.credentials)) remember(account.source, account.credentials)
      })
      return discovered
    },
    resolve,
    reload,
    refresh: async (source) => {
      let current: ClaudeCodeCredentials | null
      try {
        current = await input.source.read(source)
      } catch {
        current = cache.get(source)?.credentials ?? null
      }
      if (!current) {
        cache.delete(source)
        return null
      }
      return refreshCurrent(source, current)
    },
  }
}

export function parseClaudeCodeOAuthResponse(
  raw: string,
  refreshToken: string,
  now = Date.now(),
): ClaudeCodeCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!record(parsed) || typeof parsed.access_token !== "string" || !parsed.access_token.trim()) return null
  const expires = typeof parsed.expires_in === "number" ? parsed.expires_in : 36_000
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : refreshToken,
    expiresAt: Math.trunc(now + expires * 1_000),
  }
}

async function refreshOAuth(refreshToken: string, fetcher: typeof fetch, now: number) {
  try {
    const response = await fetcher(oauthURL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oauthClientID,
        refresh_token: refreshToken,
      }),
    })
    if (!response.ok) return null
    return parseClaudeCodeOAuthResponse(await response.text(), refreshToken, now)
  } catch {
    return null
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
