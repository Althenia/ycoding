export type McpClientKind = "dcr" | "cimd"

export type McpClientRow = {
  readonly id: string
  readonly kind: McpClientKind
  readonly name: string
  readonly redirectUris: readonly string[]
  readonly authMethod: "none"
  readonly createdAt: number
  readonly firstAuthorizedAt?: number
}

export type McpDeviceRow = {
  readonly deviceID: string
  readonly enabled: boolean
  readonly epoch: string
  readonly updatedAt: number
}

export type McpAuthorizationStage = "notice" | "google" | "exchanging" | "consent"

export type McpAuthorizationRow = {
  readonly id: string
  readonly clientID: string
  readonly deviceID: string
  readonly resource: string
  readonly scope: string
  readonly redirectUri: string
  readonly clientState?: string
  readonly codeChallenge: string
  readonly stage: McpAuthorizationStage
  readonly googleStateHash?: string
  readonly googleNonce?: string
  readonly googleVerifier?: string
  readonly csrfHash?: string
  readonly ownerID?: string
  readonly epoch: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly consumedAt?: number
}

export type McpGrantRow = {
  readonly id: string
  readonly clientID: string
  readonly deviceID: string
  readonly ownerID: string
  readonly resource: string
  readonly scope: string
  readonly epoch: string
  readonly consentedAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
}

export type McpCodeRow = {
  readonly hash: string
  readonly grantID: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly consumedAt?: number
}

export type McpTokenKind = "access" | "refresh"

export type McpTokenRow = {
  readonly hash: string
  readonly grantID: string
  readonly kind: McpTokenKind
  readonly createdAt: number
  readonly expiresAt: number
  readonly consumedAt?: number
  readonly revokedAt?: number
  readonly rotatedTo?: string
}

export type McpExpiredCounts = {
  readonly authorizations: number
  readonly codes: number
  readonly tokens: number
  readonly grants: number
  readonly clients: number
}

export type McpStore = {
  readonly getDevice: (deviceID: string) => Promise<McpDeviceRow | undefined>
  readonly setDevice: (input: {
    readonly deviceID: string
    readonly enabled: boolean
    readonly epoch: string
    readonly now: number
  }) => Promise<void>
  readonly saveClient: (row: McpClientRow, limit: number) => Promise<boolean>
  readonly findClient: (id: string) => Promise<McpClientRow | undefined>
  readonly countPendingClients: () => Promise<number>

  readonly insertAuthorization: (row: McpAuthorizationRow) => Promise<void>
  readonly findAuthorization: (id: string) => Promise<McpAuthorizationRow | undefined>
  readonly beginGoogle: (input: {
    readonly id: string
    readonly csrfHash: string
    readonly stateHash: string
    readonly nonce: string
    readonly verifier: string
    readonly now: number
  }) => Promise<boolean>
  readonly takeGoogle: (input: {
    readonly id: string
    readonly stateHash: string
    readonly now: number
  }) => Promise<boolean>
  readonly bindOwner: (input: {
    readonly id: string
    readonly ownerID: string
    readonly csrfHash: string
    readonly now: number
  }) => Promise<boolean>
  readonly burnAuthorization: (id: string, now: number) => Promise<void>
  readonly denyConsent: (input: {
    readonly id: string
    readonly csrfHash: string
    readonly now: number
  }) => Promise<boolean>
  readonly allowConsent: (input: {
    readonly id: string
    readonly csrfHash: string
    readonly now: number
    readonly grant: McpGrantRow
    readonly code: McpCodeRow
  }) => Promise<boolean>

  readonly findGrant: (id: string) => Promise<McpGrantRow | undefined>
  readonly findCode: (hash: string) => Promise<{ readonly code: McpCodeRow; readonly grant: McpGrantRow } | undefined>
  readonly findToken: (
    hash: string,
  ) => Promise<{ readonly token: McpTokenRow; readonly grant: McpGrantRow } | undefined>
  readonly exchangeCode: (input: {
    readonly codeHash: string
    readonly now: number
    readonly access: McpTokenRow
    readonly refresh: McpTokenRow
  }) => Promise<boolean>
  readonly rotateRefresh: (input: {
    readonly tokenHash: string
    readonly now: number
    readonly access: McpTokenRow
    readonly refresh: McpTokenRow
  }) => Promise<boolean>
  readonly revokeGrant: (id: string, now: number) => Promise<void>
  readonly deleteDeviceGrants: (deviceID: string) => Promise<void>
  readonly deleteExpired: (now: number, retentionMs: number, limit: number) => Promise<McpExpiredCounts>
}
