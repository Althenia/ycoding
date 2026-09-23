import { For, Show, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useTheme } from "../../theme/theme-store"
import type { ThemePreference } from "../../theme/theme"
import type { SessionView } from "../projection"
import { useRemote } from "../context"
import {
  accountReadState,
  accountSectionView,
  deviceAvailabilityView,
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

const autonomyOptions = [
  { level: 0 as const, label: "Standard", detail: "Manual questions and approval requests." },
  { level: 1 as const, label: "YOLO 1", detail: "Automatically answers questions." },
  { level: 2 as const, label: "YOLO 2", detail: "Answers questions and approves tool permissions." },
  { level: 3 as const, label: "YOLO 3", detail: "Also approves ordinary guardrail reviews." },
]

function permissionDescription(): string {
  if (typeof Notification === "undefined") return describeNotificationPermission(undefined)
  return describeNotificationPermission(Notification.permission)
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
            <Show when={actions().includes("sign-in")}>
              <button type="button" class="button button--primary button--small" onClick={() => remote.signIn()}>
                Sign in with Google
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
  const [enrollment, setEnrollment] = createSignal<EnrollmentInstructions | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const state = () => remote.state()
  const devices = () => deviceAvailabilityView(accountReadState({ connection: state().connection, owner: state().owner }), state().devices.length)
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
              </div>
            )}
          </For>
        </div>
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
              {(option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme.preference() === option.id}
                  class={`filters__option${theme.preference() === option.id ? " filters__option--active" : ""}`}
                  onClick={() => theme.setPreference(option.id)}
                >
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

/**
 * The autonomy of the selected session. A workspace with no selected session shows the
 * shipped placeholder: no level is invented and no goal is reported for a session this
 * browser is not watching.
 */
export function AutonomySettings(): JSX.Element {
  const remote = useRemote()
  const [goal, setGoal] = createSignal("")
  const view = () => remote.state().view
  const autonomy = () => view()?.autonomy
  return (
    <Section id="autonomy-settings" category="Autonomy" title="Autonomy" hint={autonomyHint(view())}>
      <Show when={view() !== undefined}>
        <p class="settings__hint settings__guardrail-note">Hard guardrail reviews always require a human decision, even at level 3.</p>
        <div class="defs">
          <div class="autonomy-choices" role="radiogroup" aria-label="Autonomy level">
            <For each={autonomyOptions}>
              {(option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={(autonomy()?.yolo ?? 0) === option.level}
                  class={`autonomy-choice${(autonomy()?.yolo ?? 0) === option.level ? " autonomy-choice--active" : ""}`}
                  onClick={() => void remote.store.setYolo(option.level)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.detail}</span>
                </button>
              )}
            </For>
          </div>
          <div class="defs__row">
            <span class="defs__key">Goal</span>
            <span class="defs__value">
              <input
                class="input"
                type="text"
                placeholder="Describe the objective"
                aria-label="Goal"
                value={goal()}
                onInput={(event) => setGoal(event.currentTarget.value)}
              />
              <button
                type="button"
                class="button button--primary button--small"
                disabled={goal().trim().length === 0}
                onClick={() => {
                  void remote.store.setGoal(goal().trim())
                  setGoal("")
                }}
              >
                Set goal
              </button>
              <Show when={autonomy()?.mode === "goal"}>
                <button type="button" class="button button--danger button--small" onClick={() => void remote.store.stopGoal()}>
                  Stop goal
                </button>
              </Show>
            </span>
          </div>
        </div>
      </Show>
    </Section>
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
  const [permission, setPermission] = createSignal(permissionDescription())
  const counts = () => countEnabledChannels(preferences())

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
      hint="Categories apply to notices in this workspace and, once this browser is permitted, to desktop alerts. Alerts cover live events only: reopening a session never replays one, and desktop alerts appear while this page is open because the workspace has no background push."
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
          <span class="defs__key">Desktop alerts</span>
          <span class="defs__value">
            <button
              type="button"
              class="button button--secondary button--small"
              onClick={() => {
                if (typeof Notification === "undefined") return
                void Notification.requestPermission().then(() => setPermission(permissionDescription()))
              }}
            >
              <Icon name="bell" size={16} />
              Request browser permission
            </button>
            <span class="field__hint">{permission()}</span>
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

function autonomyHint(view: SessionView | undefined): string {
  if (view === undefined) return "Select a session to read or change its autonomy state."
  const autonomy = view.autonomy
  if (autonomy === undefined) return "This connection has not reported autonomy state yet."
  if (autonomy.mode === "goal") return `Goal active: ${autonomy.goal?.text ?? ""}`
  if (autonomy.yolo === 0) return "Standard mode: every review and question waits for you."
  return `YOLO ${autonomy.yolo}: levels 1-3 answer questions, permissions, then ordinary guardrail reviews.`
}
