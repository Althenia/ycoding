import { createMutation } from "@tanstack/solid-query"
import { useStore } from "@tanstack/solid-store"
import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { RemoteLatencySample } from "@ycoding-ai/remote"
import { Icon } from "../../ui/icon"
import { CustomSelect } from "../../ui/custom-select"
import { Modal } from "../../ui/modal"
import { pwaInstall } from "../../pwa/install"
import { InstallPWAButton } from "../../pwa/install-button"
import { useTheme } from "../../theme/theme-store"
import { normalizeSchemePreference, type ThemePreference } from "../../theme/theme"
import { SCHEMES, SCHEME_IDS } from "../../theme/schemes"
import { useRemote } from "../context"
import { deviceAliasLimit } from "../device-alias"
import { createRemoteQuery } from "../query"
import { keepAwakeView } from "../keep-awake"
import { keepAwakeState } from "../queries"
import { createPushHttp, createRemoteHttp } from "../http"
import { browserPushPlatform, disablePush, enablePush, pushStatusView, savePushCategories, syncPushState, type PushPlatform, type PushStatus } from "../push"
import type { OfficeSettingsStore, WorkspacePresentation } from "../office/storage"
import type { OfficePreferences } from "../office/types"
import {
  accountReadState,
  accountSectionView,
  deviceAvailabilityView,
  devicePickerNote,
  enrollmentInstructions,
  type EnrollmentInstructions,
} from "../view-model"
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  describeNotificationPermission,
  createNotificationPreferences,
  readNotificationPreferences,
  NOTIFICATION_STORAGE_KEY,
  pushCategoriesFor,
  type NotificationCategory,
  type NotificationChannel,
} from "../preferences"
import "./settings.css"
import "./device-alias.css"

const themeOptions: readonly { readonly id: ThemePreference; readonly label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
]

const schemeOptions = SCHEME_IDS.map((id) => ({ value: id, label: SCHEMES[id].label }))

export function MachineSettings(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const [draft, setDraft] = createSignal("")
  const selectedDevice = () => state().devices.find((device) => device.id === state().activeDeviceID)
  createEffect(() => {
    const deviceID = state().activeDeviceID
    setDraft(deviceID === undefined ? "" : remote.deviceAliases()[deviceID] ?? "")
  })
  const reachable = () => state().activeDeviceID !== undefined && state().transport.kind === "open" && state().connection.kind === "connected"
  const keepAwake = createRemoteQuery(remote.store.queryClient, () => remote.queries.keepAwake(remote.scope(), reachable()))
  const setKeepAwake = createMutation(() => remote.queries.keepAwakeMutation(remote.scope()))
  const awake = () => keepAwakeView({ keepAwake: keepAwakeState(keepAwake()), reachable: reachable() })
  const availability = () => deviceAvailabilityView(accountReadState({ connection: state().connection, owner: state().owner }), state().devices.length, {
    devices: state().devices.map((device) => ({ ...device, name: remote.deviceName(device) })), activeDeviceID: state().activeDeviceID, sessionCount: state().sessions.length,
    unreachable: state().connection.kind === "offline",
  })
  const saveAlias = (value: string) => {
    const deviceID = state().activeDeviceID
    if (deviceID === undefined) return
    remote.setDeviceAlias(deviceID, value)
    setDraft(remote.deviceAliases()[deviceID] ?? "")
  }
  return <Section id="machine-settings" category="Machine" title="Machine" hint="Choose an online machine to access its Sessions.">
    <CustomSelect class="remote-device__select" surfaceClass="remote-device__surface" label="Machine"
      sheetTitle="Select Active Machine" sheetSubtitle="Online machines you can connect to"
      value={state().activeDeviceID} placeholder={availability().placeholder} disabled={!availability().selectable}
      options={state().devices.filter((device) => device.status === "active" && device.online).map((device) => ({ value: device.id, label: remote.deviceName(device), badge: "Online" }))}
      onChange={(deviceID) => remote.store.connect(deviceID)}
      footer={devicePickerNote(state().devices)} />
    <Show when={selectedDevice()}>
      {(device) => <form class="defs__row device-alias" onSubmit={(event) => { event.preventDefault(); saveAlias(draft()) }}>
        <label class="defs__key" for="device-display-name">Display name</label>
        <span class="defs__value">
          <span id="device-display-name-hint" class="field__hint">Only this browser; the machine keeps its hostname {device().name}</span>
          <input id="device-display-name" class="input" aria-describedby="device-display-name-hint" value={draft()} maxLength={deviceAliasLimit}
            onInput={(event) => setDraft(event.currentTarget.value)} />
          <span class="device-alias__actions">
            <button type="submit" class="button button--secondary">Save</button>
            <button type="button" class="button button--ghost" onClick={() => saveAlias("")}>Clear</button>
          </span>
        </span>
      </form>}
    </Show>
    <div class="defs__row" aria-busy={awake().busy}>
      <span class="defs__key" id="machine-awake-label">Keep machine awake</span>
      <span class="defs__value">
        <label class="switch">
          <input type="checkbox" aria-labelledby="machine-awake-label" aria-describedby="machine-awake-status machine-awake-caveat"
            checked={awake().checked} disabled={awake().disabled}
            onChange={(event) => {
              setKeepAwake.mutate(event.currentTarget.checked)
              event.currentTarget.checked = awake().checked
            }} />
          <span>{awake().label}</span>
        </label>
        <Show when={awake().retry}>
          <button type="button" class="button button--secondary button--small" aria-label="Retry Keep machine awake"
            onClick={() => void keepAwake().refetch()}>Retry</button>
        </Show>
        <span id="machine-awake-status" class="field__hint machine-awake__status" data-tone={awake().tone} role="status" aria-live="polite">{awake().detail}</span>
        <span id="machine-awake-caveat" class="field__hint machine-awake__caveat">{awake().caveat}</span>
      </span>
    </div>
  </Section>
}

export function AppSettings(): JSX.Element {
  return <Section id="app-settings" category="App" title="App" hint="Install the remote workspace for a separate app window.">
    <div class="defs__row">
      <span class="defs__key">Mode</span>
      <span class="defs__value" role="status">{pwaInstall.isInstalled() ? "Installed app" : "Browser"}</span>
    </div>
    <Show when={pwaInstall.canInstall()}>
      <div class="defs__row">
        <span class="defs__key">Install</span>
        <span class="defs__value"><InstallPWAButton /></span>
      </div>
    </Show>
  </Section>
}

export function LatencySettings(): JSX.Element {
  const remote = useRemote()
  const generation = remote.select((state) => state.generation)
  const [report, setReport] = createSignal(remote.store.latency.snapshot())
  const [copyStatus, setCopyStatus] = createSignal("")
  const [saved, setSaved] = createSignal<{
    readonly status: "idle" | "loading" | "ready" | "unavailable" | "unsupported" | "unknown" | "failed"
    readonly data: readonly { readonly receivedAt: number; readonly sample: RemoteLatencySample }[]
    readonly next?: string
  }>({ status: "idle", data: [] })
  let field: HTMLTextAreaElement | undefined
  let mounted = true
  createEffect(() => {
    generation()
    setSaved({ status: "idle", data: [] })
  })
  onMount(() => {
    let frame: number | undefined
    const unsubscribe = remote.store.latency.subscribe(() => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        setReport(remote.store.latency.snapshot())
        setCopyStatus("")
      })
    })
    onCleanup(() => {
      mounted = false
      unsubscribe()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })
  const text = () => JSON.stringify({ version: 1, ...report() }, null, 2)
  const savedText = () => JSON.stringify({ data: saved().data, cursor: saved().next === undefined ? {} : { next: saved().next } }, null, 2)
  const readSaved = async (before?: string) => {
    if (saved().status === "loading") return
    const generation = remote.state().generation
    setSaved({ ...saved(), status: "loading" })
    const outcome = await remote.store.readStoredLatency(before)
    if (!mounted || remote.state().generation !== generation) return
    if (outcome.status !== "ok") {
      setSaved({ ...saved(), status: outcome.status })
      return
    }
    setSaved({ status: "ready", data: outcome.data, next: outcome.next })
  }
  const copy = () => {
    if (!navigator.clipboard) {
      field?.select()
      setCopyStatus("Select and copy the report text.")
      return
    }
    void navigator.clipboard.writeText(text()).then(
      () => setCopyStatus("Copied latency report."),
      () => { field?.select(); setCopyStatus("Copy unavailable. Select and copy the report text.") },
    )
  }
  return <Section id="latency-settings" category="Diagnostics" title="Web latency" hint="Fixed, anonymous timings are sent through the relay to the selected machine's SQLite, never stored by the relay.">
    <div class="defs">
      <div class="defs__row" aria-busy={remote.state().telemetryConsent.status === "loading"}>
        <span class="defs__key" id="telemetry-consent-label">Save telemetry on this machine</span>
        <span class="defs__value">
          <label class="switch">
            <input type="checkbox" aria-labelledby="telemetry-consent-label" aria-describedby="telemetry-consent-help telemetry-consent-status"
              checked={remote.state().telemetryConsent.consent?.enabled ?? remote.state().telemetryConsent.status === "enabled"} disabled={remote.state().transport.kind !== "open" || ["loading", "unsupported", "failed"].includes(remote.state().telemetryConsent.status)}
              onChange={(event) => { void remote.store.setTelemetryConsent(event.currentTarget.checked) }} />
            <span>{remote.state().telemetryConsent.consent?.enabled ?? remote.state().telemetryConsent.status === "enabled" ? "On" : remote.state().telemetryConsent.status === "disabled" || remote.state().telemetryConsent.consent?.enabled === false ? "Off" : remote.state().telemetryConsent.status === "undecided" ? "Not decided" : "Unavailable"}</span>
          </label>
          <span class="field__hint" id="telemetry-consent-help">Save usage, speed, and latency for each provider, model, and profile on this machine only. Nothing leaves your machine.</span>
          <span class="field__hint" id="telemetry-consent-status" role="status" aria-live="polite">{remote.state().telemetryConsent.error ?? (remote.state().telemetryConsent.status === "unsupported" ? "Update YCoding on this machine to manage telemetry consent." : remote.state().telemetryConsent.status === "failed" ? "Could not confirm the telemetry setting." : "")}</span>
        </span>
      </div>
      <div class="defs__row">
        <span class="defs__key">Measurements</span>
        <span class="defs__value">Queue time is local pacing. Settlement time includes network, relay, machine, response assembly, or time until a timeout or disconnect; it does not isolate model time or screen paint.
          {report().longTasksSupported ? " Browser long tasks show main-thread blocks of at least 50 ms." : " Browser long tasks are unreported here."}</span>
      </div>
      <div class="defs__row">
        <label class="defs__key" for="latency-report">Report</label>
        <span class="defs__value">
          <span class="field__hint">{report().samples.length === 0 ? "No samples yet." : `Latest ${report().samples.length} samples (up to 60).`} Cleared on machine switch, sign-out, or reload. Clearing this tab does not delete saved machine samples.</span>
          <textarea ref={field} id="latency-report" class="textarea latency-settings__report" aria-label="Web latency report" readOnly value={text()} rows={8} />
          <button type="button" class="button button--secondary button--small" aria-label="Copy latency report" onClick={copy}>Copy report</button>
          <button type="button" class="button button--ghost button--small" aria-label="Clear latency report" disabled={report().samples.length === 0}
            onClick={() => { remote.store.latency.clear(); setReport(remote.store.latency.snapshot()); setCopyStatus("Cleared this tab; saved machine samples remain.") }}>Clear this tab</button>
          <span class="field__hint" role="status" aria-live="polite">{copyStatus()}</span>
        </span>
      </div>
      <div class="defs__row">
        <span class="defs__key">Machine save</span>
        <span class="defs__value" role="status">{remote.state().telemetryConsent.status !== "enabled" ? "Saving requires this consent." : ({ idle: "Waiting for samples.", saving: "Saving on this machine…", saved: "Latest batch saved on this machine.", waiting: "Waiting for this machine to reconnect.", unsupported: "Update YCoding on this machine to save Web latency.", unknown: "Last save was not confirmed; it will not be replayed.", failed: "Machine save failed; inspect this tab's report." } as const)[remote.state().latencySync]}</span>
      </div>
      <div class="defs__row">
        <span class="defs__key">Saved on machine</span>
        <span class="defs__value">
          <button type="button" class="button button--secondary button--small" aria-label="Read saved latency"
            disabled={remote.state().transport.kind !== "open" || saved().status === "loading"}
            onClick={() => void readSaved()}>Read saved report</button>
          <span class="field__hint" role="status" aria-live="polite">{({ idle: "Read this machine's recent samples when connected.", loading: "Reading saved samples…", ready: saved().data.length === 0 ? "No saved samples on this machine." : `${saved().data.length} saved samples on this page.`, unavailable: "Reconnect to read this machine's samples.", unsupported: "Update YCoding on this machine to read saved samples.", unknown: "Could not confirm this read; retry when connected.", failed: "Saved samples could not be read; try again." } as const)[saved().status]}</span>
          <Show when={saved().status === "ready" || saved().data.length > 0}>
            <textarea class="textarea latency-settings__report" aria-label="Machine latency report" readOnly value={savedText()} rows={8} />
            <Show when={saved().next}>{(next) => <button type="button" class="button button--secondary button--small" aria-label="Load older latency" onClick={() => void readSaved(next())}>Load older</button>}</Show>
          </Show>
        </span>
      </div>
    </div>
  </Section>
}

export function moveRadio(event: KeyboardEvent, index: number, count: number, select: (next: number) => void) {
  const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % count
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + count) % count
    : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined
  if (next === undefined) return
  event.preventDefault()
  select(next)
  if (event.currentTarget instanceof HTMLButtonElement) {
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }
}

function Section(props: {
  readonly id: string
  readonly category: string
  readonly title: string
  readonly hint: string
  readonly children: JSX.Element
}): JSX.Element {
  return (
    <section class="settings__section" aria-labelledby={props.id}>
      <div class="settings__head">
        <p class="settings__category">{props.category}</p>
        <h2 id={props.id}>{props.title}</h2>
        <p class="settings__hint">{props.hint}</p>
      </div>
      {props.children}
    </section>
  )
}

/**
 * The account section shows the account it knows or one message about why it cannot. The
 * message carries its own actions, so a browser whose account read has not settled is
 * never reported as signed out: it is offered a retry instead.
 */
export function AccountSettings(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const account = () =>
    accountSectionView(accountReadState({ connection: state().connection, owner: state().owner }), remote.authError)
  const signedIn = () => account().kind === "signed-in"
  const detail = () => {
    const view = account()
    return view.kind === "message" ? view.detail : ""
  }
  const expiry = () => {
    const view = account()
    return view.kind === "signed-in" ? new Date(view.expiresAt).toLocaleString() : undefined
  }
  const actions = (): readonly string[] => {
    const view = account()
    return view.kind === "message" ? view.actions : []
  }
  return (
    <Section
      id="account-settings"
      category="Account"
      title="Account"
      hint="This workspace reaches your machines with the account this browser is signed in with."
    >
      <div class="account-card">
        <div class="defs__row">
          <span class="defs__key">Account</span>
          <span class="defs__value">
            <strong>{signedIn() ? state().owner?.id : detail()}</strong>
            <Show when={signedIn()}><span class="chip">Signed in</span></Show>
          </span>
        </div>
        <Show when={expiry()}>
          {(label) => (
            <div class="defs__row">
              <span class="defs__key">Session expires</span>
              <span class="defs__value">{label()}</span>
            </div>
          )}
        </Show>
        <div class="defs__row">
          <span class="defs__key">Actions</span>
          <span class="defs__value">
            <Show when={signedIn()}>
              <button type="button" class="button button--secondary button--small" onClick={() => void remote.store.logout()}>
                Sign out
              </button>
              <button type="button" class="button button--ghost button--small" onClick={() => void remote.store.load()}>
                <Icon name="refresh" size={16} />
                Refresh account
              </button>
            </Show>
            <Show when={actions().includes("retry")}>
              <button type="button" class="button button--secondary button--small" onClick={() => void remote.store.load()}>
                Retry account check
              </button>
            </Show>
          </span>
        </div>
      </div>
    </Section>
  )
}

/**
 * One-use enrollment. The code is shown once beside its own copy control and never placed
 * on a command line: the enroll command carries only the enrollment identifier and the
 * relay origin, because the CLI reads the code from a hidden prompt.
 */
export function DeviceSettings(): JSX.Element {
  const remote = useRemote()
  const http = createRemoteHttp()
  const [enrollment, setEnrollment] = createSignal<EnrollmentInstructions | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [removal, setRemoval] = createSignal<{ readonly id?: string; readonly name: string; readonly trigger: HTMLButtonElement }>()
  const [removing, setRemoving] = createSignal(false)
  const [removalError, setRemovalError] = createSignal<string>()
  const state = () => remote.state()
  const devices = () => deviceAvailabilityView(accountReadState({ connection: state().connection, owner: state().owner }), state().devices.length)
  const remove = async (dismiss: () => void) => {
    const selected = removal()
    if (!selected || removing()) return
    setRemoving(true)
    const result = await http.removeRevokedDevices(selected.id)
    if (!result.ok) {
      setRemovalError(result.message)
      setRemoving(false)
      return
    }
    await remote.store.load()
    setRemoving(false)
    setRemovalError(undefined)
    dismiss()
    queueMicrotask(() => (document.querySelector<HTMLButtonElement>('button[aria-label="Remove all revoked devices"]') ??
      document.querySelector<HTMLButtonElement>('.settings__section[aria-labelledby="device-settings"] .defs button'))?.focus())
  }
  return (
    <Section
      id="device-settings"
      category="Devices"
      title="Devices"
      hint={
        devices().hint.length > 0
          ? devices().hint
          : "A machine appears here after the CLI enrolls it with a one-use code."
      }
    >
      <p class="device-access-note">
        <Icon name="shield" size={16} />
        All existing and future Sessions are accessible while this device is connected.
      </p>
      <Show when={state().devices.length > 0}>
        <div class="device-table" role="table" aria-label="Registered devices">
          <div class="device-table__head" role="row">
            <span role="columnheader">Device name</span>
            <span role="columnheader">Registration</span>
            <span role="columnheader">Connection</span>
            <span role="columnheader">Last seen</span>
            <span role="columnheader">Action</span>
          </div>
          <For each={state().devices}>
            {(device) => (
              <div class="device" role="row">
                <div class="device__body" role="cell">
                  <span class="device__name" title={device.name}>{remote.deviceName(device)}</span>
                  <Show when={remote.deviceName(device) !== device.name}><span class="device__hostname">{device.name}</span></Show>
                </div>
                <span class="device__registration" role="cell">{device.status === "revoked" ? "Revoked" : "Enrolled"}</span>
                <span class="device__connection" role="cell">
                  <span class={`status-dot status-dot--${device.status === "active" && device.online ? "online" : "offline"}`} aria-hidden="true" />
                  {device.status === "revoked" ? "Disconnected" : device.online ? "Online" : "Offline"}
                </span>
                <span class="device__last-seen" role="cell">
                  {device.lastSeenAt === undefined ? "Not reported" : new Date(device.lastSeenAt).toLocaleString()}
                </span>
                <Show when={device.status === "active"}>
                  <span class="device__action" role="cell">
                    <button
                      type="button"
                      class="button button--danger button--small"
                      onClick={() => void remote.store.revokeDevice(device.id)}
                    >
                      Revoke
                    </button>
                  </span>
                </Show>
                <Show when={device.status === "revoked"}>
                  <span class="device__action" role="cell">
                    <button type="button" class="button button--secondary button--small" aria-label={`Remove ${device.name}`}
                      disabled={removing()} onClick={(event) => { setRemovalError(undefined); setRemoval({ id: device.id, name: device.name, trigger: event.currentTarget }) }}>
                      Remove
                    </button>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={state().devices.some((device) => device.status === "revoked")}>
        <div class="device-cleanup-actions">
          <button type="button" class="button button--secondary button--small" aria-label="Remove all revoked devices"
            disabled={removing()} onClick={(event) => { setRemovalError(undefined); setRemoval({ name: "all revoked devices", trigger: event.currentTarget }) }}>
            Remove all revoked devices
          </button>
        </div>
      </Show>
      <Show when={removalError() && removal() === undefined}><p class="settings__hint" role="alert">{removalError()}</p></Show>
      <Show when={removal()} keyed>
        {(selected) => {
          let close: (() => void) | undefined
          return <Modal label={selected.id === undefined ? "Remove all revoked devices" : "Remove revoked device"}
            returnFocus={selected.trigger} onClose={() => setRemoval(undefined)} requestClose={(handoff) => { close = handoff }}>
            <p>{selected.id === undefined
              ? "Remove all revoked machines from this account? Enrolled machines stay registered."
              : `Remove ${selected.name} from this account? This cannot be undone.`}</p>
            <Show when={removalError()}><p class="settings__hint" role="alert">{removalError()}</p></Show>
            <div class="device-cleanup-actions">
              <button type="button" class="button button--secondary" onClick={() => close?.()}>Cancel</button>
              <button type="button" class="button button--danger" data-confirm-remove disabled={removing()} onClick={() => void remove(() => close?.())}>
                {removing() ? "Removing…" : selected.id === undefined ? "Remove revoked devices" : "Remove device"}
              </button>
            </div>
          </Modal>
        }}
      </Show>
      <div class="defs">
        <div class="defs__row">
          <span class="defs__key">Enrollment</span>
          <span class="defs__value">
            <button
              type="button"
              class="button button--secondary button--small"
              onClick={() => {
                setError(undefined)
                void remote.store.createEnrollment().then((result) => {
                  if (!result.ok) {
                    setError(result.message)
                    return
                  }
                  setEnrollment(enrollmentInstructions(result.value, window.location.origin))
                })
              }}
            >
              <Icon name="key" size={16} />
              Create enrollment code
            </button>
          </span>
        </div>
      </div>
      <Show when={error()}>
        <p class="settings__hint" role="status">
          {error()}
        </p>
      </Show>
      <Show when={enrollment()}>
        {(handoff) => (
          <>
            <figure class="code-block">
              <figcaption class="code-block__head">
                <span class="code-block__label">On the machine running YCoding</span>
                <button
                  type="button"
                  class="button button--ghost button--small code-block__copy"
                  onClick={() => void navigator.clipboard?.writeText(handoff().command)}
                >
                  <Icon name="copy" size={16} />
                  Copy command
                </button>
              </figcaption>
              <pre tabindex="0">
                <code>{handoff().command}</code>
              </pre>
            </figure>
            <div class="defs">
              <div class="defs__row">
                <span class="defs__key">Enrollment ID</span>
                <span class="defs__value">{handoff().enrollmentID}</span>
              </div>
              <div class="defs__row">
                <span class="defs__key">Enrollment code (shown once)</span>
                <span class="defs__value">
                  <code>{handoff().code}</code>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    onClick={() => void navigator.clipboard?.writeText(handoff().code)}
                  >
                    <Icon name="copy" size={16} />
                    Copy code
                  </button>
                </span>
              </div>
              <div class="defs__row">
                <span class="defs__key">Handoff</span>
                <span class="defs__value">
                  <button type="button" class="button button--ghost button--small" onClick={() => setEnrollment(undefined)}>
                    Hide
                  </button>
                </span>
              </div>
            </div>
            <p class="settings__hint">
              Enter this code at the command's hidden prompt before {new Date(handoff().expiresAt).toLocaleTimeString()}. The
              command never carries it, and the code cannot be displayed again.
            </p>
          </>
        )}
      </Show>
    </Section>
  )
}

/**
 * Theme and color scheme are reachable from Settings at every width, because below 480 the
 * header control is absent and this group is the only path. Theme is a real three-option
 * control; the scheme is a select so more schemes add options, not controls. Both stored
 * choices resolve before the first paint.
 */
export function AppearanceSettings(): JSX.Element {
  const theme = useTheme()
  return (
    <Section
      id="appearance-settings"
      category="Appearance"
      title="Appearance"
      hint="Light, dark, or system, and a color scheme. One Dark Pro paints dark mode only. With System and the default scheme, a system request for more contrast applies High contrast. The choices are stored in this browser and applied before the first paint."
    >
      <div class="list appearance-segments">
        <div class="list__row">
          <span class="list__label" id="theme-label">
            Theme
          </span>
          <span class="list__control filters" role="radiogroup" aria-labelledby="theme-label">
            <For each={themeOptions}>
              {(option, index) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme.preference() === option.id}
                  tabIndex={theme.preference() === option.id ? 0 : -1}
                  class={`filters__option${theme.preference() === option.id ? " filters__option--active" : ""}`}
                  onClick={() => theme.setPreference(option.id)}
                  onKeyDown={(event) => moveRadio(event, index(), themeOptions.length, (next) => {
                    const selected = themeOptions[next]
                    if (selected) theme.setPreference(selected.id)
                  })}
                >
                  <Icon name={option.id === "system" ? "monitor" : option.id === "light" ? "sun" : "moon"} size={16} />
                  {option.label}
                </button>
              )}
            </For>
          </span>
        </div>
      </div>
      <div class="list">
        <div class="list__row">
          <span class="list__label">
            Color scheme
          </span>
          <span class="list__control">
            <CustomSelect
              class="scheme-select"
              label="Color scheme"
              sheetTitle="Select Color Scheme"
              sheetSubtitle="Applies on top of Light, Dark, or System"
              value={theme.scheme()}
              placeholder="Default"
              options={schemeOptions}
              onChange={(id) => theme.setScheme(normalizeSchemePreference(id))}
            />
          </span>
        </div>
      </div>
    </Section>
  )
}

const presentationOptions: readonly { readonly id: WorkspacePresentation; readonly label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "office", label: "Office" },
]
const motionOptions: readonly { readonly id: OfficePreferences["motion"]; readonly label: string }[] = [
  { id: "system", label: "Follow system" },
  { id: "reduced", label: "Reduce" },
]
const bubbleOptions: readonly { readonly id: OfficePreferences["bubbles"]; readonly label: string }[] = [
  { id: "off", label: "Off" },
  { id: "status", label: "Status" },
  { id: "excerpt", label: "Completed text" },
]
const switchOptions: readonly { readonly id: boolean; readonly label: string }[] = [
  { id: true, label: "On" },
  { id: false, label: "Off" },
]
const qualityOptions: readonly { readonly id: OfficePreferences["quality"]; readonly label: string }[] = [
  { id: "standard", label: "Standard · 30 FPS" },
  { id: "battery", label: "Battery · 20 FPS" },
]

export function OfficeSettings(props: { readonly office: OfficeSettingsStore }): JSX.Element {
  const [reset, setReset] = createSignal(false)
  const preferences = () => props.office.preferences()
  return (
    <Section
      id="office-settings"
      category="Office"
      title="Office"
      hint="Presentation choices for the Office view, stored in this browser. They never change Sessions, drafts, requests, or your account."
    >
      <div class="list office-settings">
        <ChoiceRow id="office-view" label="Workspace view" detail="Conversation stays the default. Office shows the same Session, requests, and composer." options={presentationOptions} value={props.office.presentation()} onChange={props.office.present} />
        <ChoiceRow id="office-motion" label="Motion" detail="Your system's reduced-motion setting always applies." options={motionOptions} value={preferences().motion} onChange={(motion) => props.office.update({ motion })} />
        <ChoiceRow id="office-bubbles" label="Bubbles" detail="Status describes reported activity. Completed text shows short excerpts of finished replies above characters." options={bubbleOptions} value={preferences().bubbles} onChange={(bubbles) => props.office.update({ bubbles })} />
        <ChoiceRow id="office-labels" label="Character labels" detail="The office session list always stays labelled." options={switchOptions} value={preferences().labels} onChange={(labels) => props.office.update({ labels })} />
        <ChoiceRow id="office-follow" label="Follow selected character" detail="Panning pauses following until you select a character again." options={switchOptions} value={preferences().followSelected} onChange={(followSelected) => props.office.update({ followSelected })} />
        <ChoiceRow id="office-quality" label="Rendering quality" detail="Changing quality restarts only the office renderer, not the connection." options={qualityOptions} value={preferences().quality} onChange={(quality) => props.office.update({ quality })} />
        <div class="list__row">
          <span class="list__label" id="office-reset">
            Reset office appearance
            <span class="list__detail" id="office-reset-detail">Restores these defaults and recenters the office. Sessions, drafts, and your account stay unchanged.</span>
          </span>
          <span class="list__control">
            <button
              type="button"
              class="button button--secondary button--small"
              aria-describedby="office-reset-detail"
              onClick={() => {
                props.office.reset()
                setReset(true)
              }}
            >
              Reset
            </button>
          </span>
        </div>
      </div>
      <Show when={reset()}>
        <p class="settings__hint" role="status">Office appearance reset.</p>
      </Show>
    </Section>
  )
}

function ChoiceRow<Value extends string | boolean>(props: {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly options: readonly { readonly id: Value; readonly label: string }[]
  readonly value: Value
  readonly onChange: (value: Value) => void
}): JSX.Element {
  return (
    <div class="list__row">
      <span class="list__label">
        <span id={`${props.id}-label`}>{props.label}</span>
        <span class="list__detail" id={`${props.id}-detail`}>{props.detail}</span>
      </span>
      <span class="list__control filters" role="radiogroup" aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-detail`}>
        <For each={props.options}>
          {(option, index) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.value === option.id}
              tabIndex={props.value === option.id ? 0 : -1}
              class={`filters__option${props.value === option.id ? " filters__option--active" : ""}`}
              onClick={() => props.onChange(option.id)}
              onKeyDown={(event) => moveRadio(event, index(), props.options.length, (next) => {
                const selected = props.options[next]
                if (selected) props.onChange(selected.id)
              })}
            >
              {option.label}
            </button>
          )}
        </For>
      </span>
    </div>
  )
}

/**
 * Notification preferences keep the shipped per-category, per-channel matrix: every
 * category carries one switch per channel, so a category can be muted in the workspace
 * while it still raises a desktop alert. Notification permission is requested only from
 * the explicit button below.
 */
export function NotificationSettings(): JSX.Element {
  const notificationPreferences = createNotificationPreferences()
  const preferences = useStore(notificationPreferences.store)
  const [permission, setPermission] = createSignal(typeof Notification === "undefined" ? undefined : Notification.permission)
  const [pushStatus, setPushStatus] = createSignal<PushStatus>("unsupported")
  const [pushBusy, setPushBusy] = createSignal(true)
  const [pushError, setPushError] = createSignal("")
  const pushView = () => pushStatusView(pushStatus())
  const pushHttp = createPushHttp()
  let pushPlatform: PushPlatform | undefined
  let active = true

  const storedCategories = () => pushCategoriesFor(readNotificationPreferences())
  const refresh = (event: StorageEvent) => {
    if (event.key === NOTIFICATION_STORAGE_KEY || event.key === null) notificationPreferences.reload()
  }

  onMount(() => {
    pushPlatform = browserPushPlatform()
    window.addEventListener("storage", refresh)
    void syncPushState(pushPlatform, pushHttp, storedCategories).then((status) => {
      if (!active) return
      setPushStatus(status)
      setPushBusy(false)
    })
  })
  onCleanup(() => {
    active = false
    window.removeEventListener("storage", refresh)
  })

  const togglePush = async () => {
    if (!pushPlatform || pushBusy()) return
    setPushBusy(true)
    const result = pushStatus() === "on" ? await disablePush(pushPlatform, pushHttp) : await enablePush(pushPlatform, pushHttp, storedCategories)
    if (!active) return
    setPushStatus(result.status)
    setPushError(result.message ?? "")
    setPushBusy(false)
  }

  const update = async (category: NotificationCategory, channel: NotificationChannel) => {
    notificationPreferences.toggle(category, channel)
    const platform = pushPlatform
    if (channel !== "desktop" || !platform || (pushStatus() !== "on" && !pushBusy())) return
    const result = await savePushCategories(platform, pushHttp, storedCategories)
    if (!active || result.status === "off") return
    setPushStatus(result.status)
    setPushError(result.message ?? "")
  }

  return (
    <Section
      id="notification-settings"
      category="Notifications"
      title="Notifications"
      hint="Categories control in-app notices and System alerts. With Push to this device on, each System switch also decides which alerts reach this device while YCoding is closed. If its subscription is missing, use Re-enable to restore alerts. Reopening a session never replays a past alert."
    >
      <div class="table-scroll">
        <table class="notification-table" aria-labelledby="notification-settings">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <For each={NOTIFICATION_CHANNELS}>{(channel) => <th scope="col">{channel.label}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={NOTIFICATION_CATEGORIES}>
              {(category) => (
                <tr>
                  <th scope="row">
                    <span>{category.label}</span>
                    <span class="field__hint">{category.detail}</span>
                  </th>
                  <For each={NOTIFICATION_CHANNELS}>
                    {(channel) => (
                      <td>
                        <label class="switch">
                          <input
                            type="checkbox"
                            aria-label={`${category.label} via ${channel.label}`}
                            checked={preferences()[category.id][channel.id]}
                            onChange={() => void update(category.id, channel.id)}
                          />
                          <span class="visually-hidden">{channel.label}</span>
                        </label>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="defs">
        <div class="defs__row">
          <span class="defs__key">Push to this device</span>
          <span class="defs__value">
            <button type="button" class="button button--secondary button--small"
              aria-label="Push to this device" aria-describedby="push-device-status"
              aria-pressed={pushView().pressed} disabled={pushBusy() || pushView().disabled}
              onClick={() => void togglePush()}>{pushBusy() ? "Checking…" : pushView().label}</button>
            <span id="push-device-status" class="field__hint" role="status" aria-live="polite">{pushError() || pushView().detail}</span>
          </span>
        </div>
        <div class="defs__row">
          <span class="defs__key">System alerts</span>
          <span class="defs__value">
            <Show when={permission() === "default"}>
              <button type="button" class="button button--secondary button--small"
                onClick={() => void Notification.requestPermission().then(setPermission)}>
                <Icon name="bell" size={16} />
                Request browser permission
              </button>
            </Show>
            <span class="field__hint" role="status" aria-live="polite">{describeNotificationPermission(permission())}</span>
          </span>
        </div>
      </div>
    </Section>
  )
}
