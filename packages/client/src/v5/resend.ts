import { V5ClientError, unsentReason } from "./error.js"

type Path = readonly string[]

export type ResendRequest<Client, Revision> = {
  readonly operation: string
  readonly args: readonly unknown[]
  readonly issuedRevision: Revision
  readonly issuedOn: Client
  readonly target: Client
}

export type ResendPolicy<Client, Revision> = {
  readonly reconnected: (signal?: AbortSignal) => Promise<void>
  readonly revision: (client: Client) => Revision
  readonly admit: (request: ResendRequest<Client, Revision>) => boolean | Promise<boolean>
}

const isResendable = (error: unknown): error is V5ClientError =>
  error instanceof V5ClientError && error.status === "unsent" && error.resendable

const isNamespace = (value: unknown): value is object =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

const signalOf = (args: readonly unknown[]) => {
  const last = args.at(-1)
  return typeof last === "object" && last !== null && "signal" in last && last.signal instanceof AbortSignal
    ? last.signal
    : undefined
}

export function resendUnsent<Client extends object, Revision>(
  current: () => Client,
  policy: ResendPolicy<Client, Revision>,
): Client {
  const resolve = (path: Path) =>
    path.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], current())

  const invoke = (path: Path, args: readonly unknown[]) => {
    const parent = resolve(path.slice(0, -1)) as Record<string, (...input: unknown[]) => unknown>
    return parent[path.slice(-1).join("")]?.call(parent, ...args)
  }

  const method = (path: Path) =>
    new Proxy(() => undefined, {
      apply(_, __, args) {
        const issuedOn = current()
        const issuedRevision = policy.revision(issuedOn)
        const result = invoke(path, args)
        if (!(result instanceof Promise)) return result
        return result.catch(async (error: unknown) => {
          const signal = signalOf(args)
          if (!isResendable(error) || signal?.aborted) throw error
          await policy.reconnected(signal).catch(() => {
            throw error
          })
          const target = current()
          const operation = error.operation ?? path.join(".")
          const admitted = await policy.admit({ operation, args, issuedRevision, issuedOn, target })
          if (!admitted || current() !== target) throw new V5ClientError("unsent", operation, unsentReason.changed)
          return invoke(path, args)
        })
      },
    })

  const namespace = (path: Path): object =>
    new Proxy(
      {},
      {
        get(_, key) {
          if (typeof key === "symbol") return Reflect.get(resolve(path) as object, key)
          const value = (resolve(path) as Record<string, unknown>)[key]
          if (typeof value === "function") return method([...path, key])
          if (isNamespace(value)) return namespace([...path, key])
          return value
        },
      },
    )

  return namespace([]) as Client
}
