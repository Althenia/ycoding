import { ClientError, type TelemetryClientSample, type TelemetryConsentState } from "@ycoding-ai/client"
import { createContext, createEffect, createSignal, onCleanup, Show, useContext, type ParentProps } from "solid-js"
import { useClient } from "./client"
import { useToast } from "../ui/toast"
import { DialogTelemetryConsent } from "../component/dialog-telemetry-consent"
import { DataProvider } from "./data"

type TelemetryContext = {
  record: (metric: TelemetryClientSample["metric"], durationMs: number, at?: number) => void
  consent: () => TelemetryConsentState["consent"]
  decided: () => boolean
  toggle: () => void
  decide: (enabled: boolean) => void
  error: () => unknown
}

const Context = createContext<TelemetryContext>()

export function TelemetryProvider(props: ParentProps) {
  const client = useClient()
  const [consent, setConsent] = createSignal<TelemetryConsentState["consent"]>()
  const [decided, setDecided] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let consentReadStarted = false
  let queue: TelemetryClientSample[] = []
  let flushing = false

  const read = () =>
    client.api.server.telemetry.consent
      .get()
      .then((result) => {
        setConsent(result.consent)
        setDecided(true)
        if (!result.consent?.enabled) queue = []
      })
      .catch(setError)

  onCleanup(client.event.on("server.connected", () => {
    if (consentReadStarted) return
    consentReadStarted = true
    void read()
  }))

  const toggle = () => {
    void client.api.server.telemetry.consent.get()
      .then((state) => client.api.server.telemetry.consent.set({ enabled: !state.consent?.enabled, noticeVersion: 1 }))
      .then((value) => {
        setConsent(value)
        setDecided(true)
        if (!value.enabled) queue = []
      })
      .catch(setError)
  }

  const decide = (enabled: boolean) => {
    void client.api.server.telemetry.consent
      .set({ enabled, noticeVersion: 1 })
      .then((value) => {
        setConsent(value)
        setDecided(true)
        if (!value.enabled) queue = []
      })
      .catch(setError)
  }

  const flush = () => {
    if (!consent()?.enabled || flushing || queue.length === 0) return
    const samples = queue.splice(0, 20)
    flushing = true
    void client.api.server.telemetry.append({ samples }).catch((error: unknown) => {
      if (
        error instanceof ClientError &&
        error.reason === "UnexpectedStatus" &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "status" in error.cause &&
        error.cause.status === 403
      ) {
        queue = []
        void read()
        return
      }
      setError(error)
    }).finally(() => {
      flushing = false
    })
  }

  const interval = setInterval(flush, 10_000)
  interval.unref()
  onCleanup(() => clearInterval(interval))

  return (
    <Context.Provider
      value={{
        consent,
        decided,
        toggle,
        decide,
        error,
        record(metric, durationMs, at = Date.now()) {
          if (!consent()?.enabled) return
          queue.push({ kind: "client", surface: "tui", metric, at: new Date(at).toISOString(), durationMs: Math.min(600_000, Math.max(0, Math.round(durationMs))) })
        },
      }}
    >
      {props.children}
    </Context.Provider>
  )
}

export function TelemetryControls() {
  const telemetry = useTelemetry()
  const toast = useToast()
  const [noticeShown, setNoticeShown] = createSignal(false)
  let reportedError: unknown

  createEffect(() => {
    const error = telemetry.error()
    if (!error || error === reportedError) return
    reportedError = error
    toast.error(error)
  })

  createEffect(() => {
    if (!telemetry.decided() || telemetry.consent() || noticeShown()) return
    setNoticeShown(true)
  })

  return (
    <Show when={noticeShown() && !telemetry.consent()}>
      <DialogTelemetryConsent onSelect={telemetry.decide} />
    </Show>
  )
}

export function TelemetryDataProvider(props: ParentProps) {
  const telemetry = useTelemetry()
  return <DataProvider recordTelemetry={telemetry.record}>{props.children}</DataProvider>
}

export function useTelemetry() {
  const value = useContext(Context)
  if (!value) throw new Error("useTelemetry must be used within TelemetryProvider")
  return value
}
