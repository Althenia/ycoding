export type InviteRow = {
  readonly id: string
  readonly label: string | null
  readonly createdAt: number
  readonly redeemedAt: number | null
  readonly userID: string | null
}

export type InviteStore = {
  readonly create: (row: { readonly id: string; readonly tokenHash: string; readonly label: string | null; readonly createdAt: number }) => Promise<void>
  readonly list: () => Promise<readonly InviteRow[]>
  readonly find: (id: string) => Promise<InviteRow | undefined>
  readonly redeem: (tokenHash: string, input: { readonly userID: string; readonly keyHash: string; readonly sessionHash: string;
    readonly now: number; readonly expiresAt: number }) => Promise<boolean>
  readonly signIn: (keyHash: string, input: { readonly sessionHash: string; readonly now: number; readonly expiresAt: number }) => Promise<boolean>
  readonly delete: (id: string, userID: string | null) => Promise<boolean>
}
