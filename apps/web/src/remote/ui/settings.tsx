import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { CustomSelect } from "../../ui/custom-select"
import { Modal } from "../../ui/modal"
import { useTheme } from "../../theme/theme-store"
import type { ThemePreference } from "../../theme/theme"
import { useRemote } from "../context"
import { createPushHttp, createRemoteHttp } from "../http"
import { browserPushPlatform, disablePush, enablePush, pushStatusView, syncPushState, type PushPlatform, type PushStatus } from "../push"
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
  countEnabledChannels,
  describeNotificationPermission,
  readNotificationPreferences,
  toggleNotificationChannel,
  writeNotificationPreferences,
  type NotificationCategory,
  type NotificationChannel,
} from "../preferences"

const themeOptions: readonly { readonly id: ThemePreference; readonly label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
]

export function MachineSettings(): JSX.Element {
  const remote = useRemote()
  const state = () => remote.state()
  const availability = () => deviceAvailabilityView(accountReadState({ connection: state().connection, owner: state().owner }), state().devices.length, {
    devices: state().devices, activeDeviceID: state().activeDeviceID, sessionCount: state().sessions.length,
    unreachable: state().connection.kind === "offline",
  })
  return <Section id="machine-settings" category="Machine" title="Machine" hint="Choose an online machine to access its Sessions.">
    <CustomSelect class="remote-device__select" surfaceClass="remote-device__surface" label="Machine"
      sheetTitle="Select Active Machine" sheetSubtitle="Online machines you can connect to"
      value={state().activeDeviceID} placeholder={availability().placeholder} disabled={!availability().selectable}
      options={state().devices.filter((device) => device.status === "active" && device.online).map((device) => ({ value: device.id, label: device.name, badge: "Online" }))}
      onChange={(deviceID) => remote.store.connect(deviceID)}
      footer={devicePickerNote(state().devices)} />
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
  const [removal, setRemoval] = createSignal<{ readonly id?: string; readonly name: string }>()
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
                  <span class="device__name">{device.name}</span>
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
                      disabled={removing()} onClick={(event) => { event.currentTarget.focus(); setRemovalError(undefined); setRemoval({ id: device.id, name: device.name }) }}>
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
            disabled={removing()} onClick={(event) => { event.currentTarget.focus(); setRemovalError(undefined); setRemoval({ name: "all revoked devices" }) }}>
            Remove all revoked devices
          </button>
        </div>
      </Show>
      <Show when={removalError() && removal() === undefined}><p class="settings__hint" role="alert">{removalError()}</p></Show>
      <Show when={removal()} keyed>
        {(selected) => {
          let close: (() => void) | undefined
          return <Modal label={selected.id === undefined ? "Remove all revoked devices" : "Remove revoked device"}
            onClose={() => setRemoval(undefined)} requestClose={(handoff) => { close = handoff }}>
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
 * Theme is reachable from Settings at every width, because below 480 the header control
 * is absent and this group is the only path. It is a real three-option control, and the
 * stored preference keeps resolving before the first paint exactly as it shipped.
 */
export function AppearanceSettings(): JSX.Element {
  const theme = useTheme()
  return (
    <Section
      id="appearance-settings"
      category="Appearance"
      title="Appearance"
      hint="Light, dark, or system. The choice is stored in this browser and applied before the first paint."
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
  const [preferences, setPreferences] = createSignal(readNotificationPreferences())
  const [permission, setPermission] = createSignal(typeof Notification === "undefined" ? undefined : Notification.permission)
  const [pushStatus, setPushStatus] = createSignal<PushStatus>("unsupported")
  const [pushBusy, setPushBusy] = createSignal(true)
  const [pushError, setPushError] = createSignal("")
  const pushView = () => pushStatusView(pushStatus())
  const pushHttp = createPushHttp()
  let pushPlatform: PushPlatform | undefined
  let active = true
  const counts = () => countEnabledChannels(preferences())

  onMount(() => {
    pushPlatform = browserPushPlatform()
    void syncPushState(pushPlatform, pushHttp).then((status) => {
      if (!active) return
      setPushStatus(status)
      setPushBusy(false)
    })
  })
  onCleanup(() => { active = false })

  const togglePush = async () => {
    if (!pushPlatform || pushBusy()) return
    setPushBusy(true)
    const result = pushStatus() === "on" ? await disablePush(pushPlatform, pushHttp) : await enablePush(pushPlatform, pushHttp)
    if (!active) return
    setPushStatus(result.status)
    setPushError(result.message ?? "")
    setPushBusy(false)
  }

  const update = (category: NotificationCategory, channel: NotificationChannel) => {
    const next = toggleNotificationChannel(preferences(), category, channel)
    setPreferences(next)
    writeNotificationPreferences(globalThis.localStorage, next)
  }

  return (
    <Section
      id="notification-settings"
      category="Notifications"
      title="Notifications"
      hint="Categories apply to notices in this workspace and, once this browser is permitted, to desktop alerts while it is open. Push to this device can alert an installed app after it closes. If its subscription is missing, use Re-enable to restore alerts. Reopening a session never replays a past alert."
    >
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
                          onChange={() => update(category.id, channel.id)}
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
          <span class="defs__key">Desktop alerts</span>
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
      <p class="settings__hint">
        {counts()["approval-requested"] === 0
          ? "Approval requests are muted, so a blocked session will wait silently."
          : "Approval requests notify you when a decision is needed."}
      </p>
    </Section>
  )
}
