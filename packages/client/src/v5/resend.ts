import { V5ClientError, unsentReason } from "./error.js"
import { LocalTransport } from "./socket.js"

type Path = readonly string[]

export type ResendRequest<Client, Revision> = {
  readonly operation: string
  readonly args: readonly unknown[]
  readonly issuedRevision: Revision
  readonly issuedOn: Client
  readonly target: Client
  readonly error?: V5ClientError
}

export type ResendPolicy<Client, Revision> = {
  readonly reconnected: (signal?: AbortSignal) => Promise<void>
  readonly waitForChange?: (signal?: AbortSignal) => Promise<void>
  readonly revision: (client: Client) => Revision
  readonly admit: (request: ResendRequest<Client, Revision>) => boolean | Promise<boolean>
}

const isResendable = (error: unknown): error is V5ClientError =>
  error instanceof V5ClientError && (error.status === "unsent" || error.status === "unknown") && error.resendable

const isNamespace = (value: unknown): value is object =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

const signalOf = (args: readonly unknown[]) => {
  const last = args.at(-1)
  return typeof last === "object" && last !== null && "signal" in last && last.signal instanceof AbortSignal
    ? last.signal
    : undefined
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined, operation: string): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => undefined)
    throw new V5ClientError("unsent", operation, unsentReason.cancelled)
  }
  const aborted = Promise.withResolvers<never>()
  const cancel = () => aborted.reject(new V5ClientError("unsent", operation, unsentReason.cancelled))
  signal.addEventListener("abort", cancel, { once: true })
  try {
    return await Promise.race([promise, aborted.promise])
  } catch (error) {
    if (signal.aborted) throw new V5ClientError("unsent", operation, unsentReason.cancelled)
    throw error
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

const transportOf = (client: object) => {
  const transport = "transport" in client ? client.transport : undefined
  return transport instanceof LocalTransport ? transport : undefined
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
        const attempt = (): unknown => {
          const issuedOn = current()
          const issuedRevision = policy.revision(issuedOn)
          const result = invoke(path, args)
          if (!(result instanceof Promise)) return result
          return result.catch(async (error: unknown) => {
            const signal = signalOf(args)
            if (!isResendable(error)) throw error
            const operation = error.operation ?? path.join(".")
            if (signal?.aborted) throw new V5ClientError("unsent", operation, unsentReason.cancelled)
            for (;;) {
              const reconnecting = current()
              const before = transportOf(reconnecting)
              const version = before?.changeVersion
              try {
                await waitFor(policy.reconnected(signal), signal, operation)
              } catch (failure) {
                if (signal?.aborted || failure instanceof Error && failure.name === "AbortError")
                  throw new V5ClientError("unsent", operation, unsentReason.cancelled)
                if (!(failure instanceof V5ClientError) || !["unsent", "unavailable", "unknown"].includes(failure.status)) throw failure
                if (!before) throw error
                if (current() !== reconnecting || before.changeVersion !== version) continue
                await waitFor(before.waitForChange(signal), signal, operation)
                continue
              }
              const target = current()
              const transport = transportOf(target)
              const changedAt = transport?.changeVersion
              const targetRevision = policy.revision(target)
              const admitted = await waitFor(Promise.resolve(policy.admit({ operation, args, issuedRevision, issuedOn, target, error })), signal, operation)
              if (current() !== target || policy.revision(target) !== targetRevision || transport?.changeVersion !== changedAt) continue
              if (!admitted) {
                const wait = policy.waitForChange ?? (transport ? (signal?: AbortSignal) => transport.waitForChange(signal) : undefined)
                if (!wait) throw new V5ClientError("unsent", operation, unsentReason.changed)
                await waitFor(wait(signal), signal, operation)
                continue
              }
              return attempt()
            }
          })
        }
        return attempt()
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
