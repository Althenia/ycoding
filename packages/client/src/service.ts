/** Connection details for a local YCoding service. */
export type Endpoint = {
  /** Base URL of the service. */
  readonly url: string
  /** Authentication required by the service, when configured. */
  readonly auth?: {
    /** HTTP authentication scheme. */
    readonly type: "basic"
    /** Basic authentication username. */
    readonly username: string
    /** Basic authentication password. */
    readonly password: string
  }
}

/** Options used to discover the local YCoding service. */
export type DiscoverOptions = {
  /** Absolute registration file path. Defaults to the XDG state directory. */
  readonly file?: string
  /** Required service version. */
  readonly version?: string
}

/** Reason ensuring the service requires a new process. */
export type EnsureReason = "missing" | "version-mismatch"

/** Options used to ensure the local YCoding service is running. */
export type EnsureOptions = DiscoverOptions & {
  /** Service command and arguments. Defaults to `ycoding serve --service`. */
  readonly command?: ReadonlyArray<string>
  /** Called once before spawning a new service process. */
  readonly onStart?: (reason: EnsureReason, previousVersion?: string) => void
  /** Base path used for bounded child startup diagnostics. */
  readonly startupErrorFile?: string
}

/** Options used to stop the local YCoding service. */
export type StopOptions = {
  /** Absolute registration file path. Defaults to the XDG state directory. */
  readonly file?: string
}

/** Contents of the local service registration file. */
export type Info = {
  /** Unique service instance identifier. */
  readonly id?: string
  /** YCoding version served by the process. */
  readonly version?: string
  /** Base URL advertised by the service. */
  readonly url: string
  /** Operating system process identifier. */
  readonly pid: number
  /** Private service password, when authentication is enabled. */
  readonly password?: string
}
