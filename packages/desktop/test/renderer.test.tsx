import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const read = (file: string) => fs.readFile(path.join(root, file), "utf8")

test("the rail takes its groups from the pure railGroups and sends search, cursor and pin requests", async () => {
  const [source, style] = await Promise.all([read("src/renderer.tsx"), read("src/style.css")])
  expect(source).toContain("railGroups(items(), activity())")
  expect(source).toContain("const sessionsQuery = (search = \"\") =>")
  expect(source).toContain("api.sessions(search ? { search } : {})")
  expect(source).toContain("api.sessions({ revision: current.revision, cursor })")
  expect(source).toContain("api.pin({ sessionID: row.id, revision: first.revision, pinned })")
  expect(source).toContain("setTimeout(() => setApplied(next.value), 250)")
  expect(source).toContain("<Show when={state()?.next !== undefined}>")
  expect(source).toContain("Load more")
  expect(source).toContain("setPaging(undefined); refresh([\"sessions\"])")
  expect(source).not.toMatch(/\.data\?\.data|data\.data/)
  expect(source).toContain("api.session({ sessionID: props.sessionID })")
  expect(source).toContain("data.revision === connection().revision && data.item.id === props.sessionID")
  expect(source).toContain('refresh(["session", ...scope(), sessionID])')
  expect(source).toContain('refresh(["session", ...scope(), props.sessionID])')
  expect(source).toContain("Refresh Session")
  expect(source).not.toContain("sessions.result().data?.items.find")
  expect(style).toMatch(/\.workspace__pin, \.workspace__more, \.workspace__session/)
})

test("Needs action and Running come from live events and never from time.active", async () => {
  const source = await read("src/renderer.tsx")
  for (const type of ["permission.asked", "question.asked", "guardrail.asked", "form.created", "session.execution.started", "session.idle"]) expect(source).toContain(`"${type}"`)
  expect(source).not.toMatch(/time\.active\s*(!==|===|!=|==)/)
  expect(source).toContain("Earlier status is unavailable")
  expect(source).toContain("setActivity(noActivity)")
})

test("the interface offers only controls the frozen bridge supports", async () => {
  const [source, bridge] = await Promise.all([read("src/renderer.tsx"), read("src/bridge.ts")])
  const calls = [...source.matchAll(/\bapi\.([a-zA-Z]+)\(/g)].map((match) => match[1])
  const exposed = new Set([...bridge.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((match) => match[1]))
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) expect(exposed.has(call)).toBe(true)
  expect(source).toContain("guardrail review or question that the desktop app cannot answer yet")
})

test("timed-out requests clear attention and deferred ones do not", async () => {
  const source = await read("src/renderer.tsx")
  const settled = /const settled = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? ""
  for (const type of ["question.timed_out", "form.timed_out", "permission.cancelled", "session.guardrail.decided"]) expect(settled).toContain(`"${type}"`)
  expect(settled).not.toContain("deferred")
  expect(source).toContain("[...current.waiting.values()].some((requests) => requests.has(requestID))")
})

test("pending requests are answered only with explicit choices, guarded by Session and revision", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain('queryFn: () => api.requests(props.sessionID)')
  expect(source).toContain("data?.sessionID === props.sessionID && data.revision === connection().revision")
  for (const label of ["Reject", "Allow once", "Always allow", "Send answer", "Cancel form"]) expect(source).toContain(`>${label}</button>`)
  expect(source).toContain('kind: "permission", sessionID: props.data.sessionID, revision: props.data.revision')
  expect(source).toContain('kind: "form", sessionID: props.data.sessionID, revision: props.data.revision')
  expect(source).toContain('kind: "form-cancel", sessionID: props.data.sessionID, revision: props.data.revision')
  expect(source.match(/api\.reply\(/g)?.length).toBe(1)
  expect(source).toContain("props.updatedAt <= (held().get(id)?.at ?? -1)")
  expect(source).toContain("<Show when={props.request.save?.length}><button")
  expect(source).toContain("The request is still pending. Review your answer and try again.")
  expect(source).toContain("A reply was not confirmed and that request is no longer pending.")
  expect(source).toContain("if (working()) return")
})

test("external form steps need an unchecked acknowledgement and are never opened", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).not.toContain("Acknowledge:")
  expect(source).toContain("I have completed this step")
  expect(source).toContain("checked={props.value === true}")
  expect(source).toContain('item.type === "external" || item.required ? " (required)"')
  expect(source).not.toMatch(/window\.open|location\.href|<a\s[^>]*href/)
  expect(source).toContain("const errorId = (scope: string, index: number) => `${scope}-${index}-error`")
  expect(source).toContain("props.form.fields.indexOf(item)")
})

test("Stop calls interrupt once per activation and never claims the response stopped", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("await api.interrupt(props.sessionID)")
  expect(source).toContain("if (stopping() || !reading()) return")
  expect(source).toContain("Stop requested. Check the transcript to confirm the response ended.")
})

test("context comes from reported diagnostics and is unknown when none are reported", async () => {
  const [source, styles] = await Promise.all([read("src/renderer.tsx"), read("src/style.css")])
  expect(source).toContain("message.diagnostics?.contextLimit")
  expect(source).toContain("message.tokens.input + message.tokens.output + message.tokens.reasoning + message.tokens.cache.read + message.tokens.cache.write")
  expect(source).toContain("Context unknown")
  expect(source).toContain("the conversation was compacted after")
  expect(source).toContain("the model changed after")
  expect(source).toContain("· latest response</summary>")
  expect(source).toContain("<Show when={total() > 0 ? value().breakdown : undefined}>")
  expect(source).toContain("A subagent Session of this chat is waiting for you.")
  const imported = /import \{([^}]*)\} from "\.\/form-rules"/.exec(source)?.[1] ?? ""
  for (const name of ["activeFields", "buildAnswer", "initialValues", "problemOf", "valueFor", "withValue", "invalidIndexes", "restoresFocus"]) expect(imported).toMatch(new RegExp(`\\b${name}\\b`))
  expect(source).toContain("aria-invalid={props.invalid}")
  expect(source).toContain("aria-describedby={described()}")
  expect(source).toContain("Session tokens")
  expect(source).not.toContain("Context window unavailable")
  expect(styles).toContain(".context__used { font-size: 36px; line-height: 40px; font-weight: 500;")
  expect(styles).toContain(".context__capacity { font-size: 13px;")
})

test("the narrow drawer makes the main column inert and reasoning-only turns say so", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain('createEffect(() => main?.toggleAttribute("inert", railOpen() && drawer()))')
  expect(source).not.toContain("attr:inert")
  expect(source).toContain("Reasoning is not shown in the desktop app.")
})

test("repeat announcements are new nodes and opening a Session announces nothing historic", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain('refetchOnMount: "always"')
  expect(source).toContain("!result.isFetchedAfterMount")
  expect(source).toContain("<Show when={announcement()} keyed>")
})

test("sending keeps the prompt identity and locks unconfirmed drafts", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("promptID: `msg_${crypto.randomUUID()}`")
  expect(source).toContain("sessionID: `ses_${crypto.randomUUID()}`")
  expect(source).toContain("readOnly={props.locked}")
  expect(source).toContain('disabled={sending() || !reading() || (!pending() && !text().trim())}')
  expect(source).toContain("pendings.set(props.sessionID, value)")
})

test("results from a previous connection generation are ignored and unconfirmed sends are flagged, not replayed", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("if (connection().generation !== generation) return\n        setNewPending({ ...draft, created: true })")
  expect(source).toContain("if (connection().generation !== generation) return\n      setNewPending(undefined)")
  expect(source).toContain("if (connection().generation !== generation) return\n      hold(undefined)")
  expect(source).toContain("connection().generation !== generation || !samePaging(state(), current)) return")
  expect(source).toContain("connection().generation === generation && samePaging(state(), current)")
  expect(source).toContain("unconfirmed.add(sessionID)")
  expect(source).toContain("Check the transcript before sending again.")
  expect(source).toContain("The private backend is not running. Start it again to continue; unsent drafts are kept.")
  expect(source).toContain('queryKey: ["messages", ...scope(), props.sessionID]')
  expect(source).toContain("api.onResync(")
})

test("unknown message types are labelled and the transcript is not a live region", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("entry is not shown in the desktop app.")
  expect(source).not.toContain('role="log"')
  expect(source).not.toContain('aria-live="polite"')
  expect(source).toContain("finished a response.")
  expect(source).toContain('<kbd>{mac ? "⌘N" : "Ctrl N"}</kbd>')
})

test("the transcript keeps the reader's position and row identity", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("<Index each={turns()}>")
  expect(source).toContain("scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48")
  expect(source).toContain("if (following()) toEnd()")
  expect(source).toContain("Jump to latest")
  expect(source).toContain("ref={focusHeading}")
})

test("the command palette is a labelled modal combobox with keyboard navigation and focus return", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("dialog?.showModal()")
  expect(source).toContain('role="combobox"')
  expect(source).toContain('role="listbox"')
  expect(source).toContain("aria-activedescendant")
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) expect(source).toContain(`"${key}"`)
  expect(source).toContain('key === "k" && command')
  expect(source).toContain('key === "p" && event.ctrlKey && !event.metaKey')
  expect(source).toContain("opener.focus()")
  expect(source).toContain("Searches the most recent Sessions only")
})

test("the narrow layout turns the rail into a drawer and coarse pointers get full-size targets", async () => {
  const [source, styles] = await Promise.all([read("src/renderer.tsx"), read("src/style.css")])
  expect(source).toContain('aria-expanded={railOpen()}')
  expect(source).toContain("Back to chat")
  expect(styles).toMatch(/@media \(max-width: 48rem\)[\s\S]*\.workspace__rail\[data-open\] \{ display: grid; \}/)
  expect(styles).toMatch(/@media \(pointer: coarse\)[\s\S]*\.workspace__session[\s\S]*min-block-size: var\(--yc-hit-min\)/)
  expect(styles).toContain(".conversation__scroll { min-block-size: 0; overflow-y: auto;")
  expect(styles).toContain('.transcript__turn[data-speaker="user"] { justify-self: end;')
})

test("the design document records the rules the interface implements", async () => {
  const design = await read("DESIGN.md")
  for (const id of ["D9", "D10", "D11", "D12", "D13"]) expect(design).toContain(`| ${id} | approved |`)
  expect(design).toContain("Needs action, Running, Pinned, Recent")
  expect(design).toContain("## Bridge gaps")
})

test("the model picker uses the catalog revision, stops while running and reports every result", async () => {
  const [source, style] = await Promise.all([read("src/renderer.tsx"), read("src/style.css")])
  expect(source).toContain("api.models(props.sessionID)")
  expect(source).toContain("found.revision === connection().revision")
  expect(source).toContain("api.switchModel({ sessionID: props.sessionID, revision: found.revision, model })")
  expect(source).toContain("const blocked = () => props.running || data()?.running === true")
  expect(source).toContain("Stop the running chat before switching models.")
  expect(source).toContain("catalog.refetch(); refresh([\"sessions\"])")
  expect(source).toContain('failure(catalog.result().error, "Models could not be read. Refresh to retry.")')
  expect(source).toContain("catalog.result().isError ? undefined : catalog.result().data")
  expect(source).toContain("visibleModels(data()?.models ?? [], data()?.current)")
  expect(source).toContain("<Show when={data() && blocked()}>")
  expect(source.match(/Stop the running chat before switching models\./g)?.length).toBe(1)
  expect(source).toContain("Refresh models")
  expect(source).toContain("<ModelPicker sessionID={props.sessionID} model={item().model} running={running()} />")
  expect(source).not.toContain("Changing it is not available in the desktop app")
  expect(style).toMatch(/\.model-picker__form select \{[^}]*text-overflow: ellipsis/)
})

test("a form submits unless locked, reveals every error and keeps focus after a lock clears", async () => {
  const source = await read("src/renderer.tsx")
  expect(source).toContain("disabled={props.locked}>Send answer")
  expect(source).not.toContain("issues().length > 0}>Send answer")
  expect(source).toContain("invalidIndexes(props.form.fields, values()).length")
  expect(source).toContain('[aria-invalid="true"]')
  expect(source).toContain('role="alert" class="desktop__error">{text()}</p>')
  expect(source.match(/unlockFocus\(\(\) => props\.locked/g)?.length).toBe(2)
  expect(source.match(/tabindex="-1" ref=\{heading\}/g)?.length).toBe(2)
})
