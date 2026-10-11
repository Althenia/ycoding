export class RemoteSetupError extends Error {
  override readonly name = "RemoteSetupError"
}

export type RemoteDiagnostic = (message: string, fields?: Readonly<Record<string, string | number | boolean>>) => void
