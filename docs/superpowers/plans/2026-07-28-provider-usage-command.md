# Provider Usage Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace provider usage in the sidebar with a hidden-when-empty `Provider Usage` command that reports unique providers used by currently running sessions in the current session family.

**Architecture:** Add a focused session provider-usage module containing pure active-provider/visibility helpers, an async generation guard, a read-only dialog renderer, and the session-scoped command controller. The controller derives unique running provider IDs from `useData()`, probes `useClient().api.providerUsage.get`, registers the command only when a non-unsupported result exists, and refreshes the same provider set when the dialog opens. Existing core credential-level single-flight caching remains the concurrency authority.

**Tech Stack:** TypeScript, SolidJS, OpenTUI Solid components, Bun test, existing YCoding promise client and provider-usage formatting utilities.

## Global Constraints

- Edit directly on `main`.
- Leave the unrelated untracked `.okf/` directory untouched.
- Only currently running root/subagent sessions contribute providers.
- Deduplicate by provider ID; do not sum or average provider usage across sessions.
- Hide unsupported providers.
- Render `Usage unavailable` for unauthorized and error snapshots.
- Hide the command when no qualifying active provider exists.
- Remove provider usage from the sidebar and do not add it to the subagent footer.

---

### Task 1: Active-provider selection and request-race helpers

**Files:**
- Create: `packages/tui/src/routes/session/provider-usage.tsx`
- Create: `packages/tui/test/cli/tui/provider-usage-command.test.tsx`

**Interfaces:**
- Consumes: `SessionInfo`, `ProviderUsageGetOutput`, session family IDs, `data.session.status(sessionID)`.
- Produces:
  - `runningProviderIDs(sessionIDs, getSession, getStatus): string[]`
  - `visibleProviderSnapshots(snapshots): ProviderUsageSnapshot[]`
  - `createProviderUsageGenerationGuard(): { next(): number; current(token: number): boolean; invalidate(): void }`

- [ ] **Step 1: Write failing pure-function tests**

Add tests that prove:

```ts
expect(
  runningProviderIDs(
    ["root", "child-a", "child-b", "idle"],
    (id) => sessions[id],
    (id) => statuses[id],
  ),
).toEqual(["anthropic", "openai"])
```

The fixture must include two running sessions using `anthropic`, one running session using `openai`, and one idle session using another provider. Add visibility tests asserting `unsupported` is omitted while `available`, `stale`, `unauthorized`, and `error` remain. Add a generation-guard test in which token 1 becomes stale after token 2 is issued.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
bun test packages/tui/test/cli/tui/provider-usage-command.test.tsx
```

Expected: FAIL because the new module and exported helpers do not exist.

- [ ] **Step 3: Implement minimal helpers**

Implement provider selection without mutating source arrays:

```ts
export function runningProviderIDs(
  sessionIDs: readonly string[],
  getSession: (sessionID: string) => Pick<SessionInfo, "model"> | undefined,
  getStatus: (sessionID: string) => string,
) {
  return [...new Set(
    sessionIDs.flatMap((sessionID) => {
      if (getStatus(sessionID) !== "running") return []
      const providerID = getSession(sessionID)?.model?.providerID
      return providerID ? [providerID] : []
    }),
  )].toSorted()
}
```

Filter snapshots with `snapshot.status !== "unsupported"`. Implement the generation guard with a monotonic integer; `invalidate()` increments it.

- [ ] **Step 4: Run the focused test and verify pass**

Run the same Bun test. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/routes/session/provider-usage.tsx packages/tui/test/cli/tui/provider-usage-command.test.tsx
git commit -m "test: define active provider usage behavior"
```

---

### Task 2: Dedicated Provider Usage dialog

**Files:**
- Modify: `packages/tui/src/routes/session/provider-usage.tsx`
- Modify: `packages/tui/test/cli/tui/provider-usage-command.test.tsx`
- Reuse: `packages/tui/src/util/provider-usage.ts`

**Interfaces:**
- Consumes: `ProviderUsageSnapshot[]`, `formatReset`, `formatWindowValue`, `freshnessLabel`, `progressBar`, `stabilityLabel`, `usageSeverity`.
- Produces:
  - `ProviderUsageDialogContent(props: { snapshots: Accessor<readonly ProviderUsageSnapshot[]>; now?: Accessor<number>; refreshing?: Accessor<boolean> }): JSX.Element`
  - `ProviderUsageDialog(props: { providerIDs: readonly string[]; initialSnapshots: readonly ProviderUsageSnapshot[] }): JSX.Element`

- [ ] **Step 1: Write failing dialog rendering tests**

Render `ProviderUsageDialogContent` under the existing config/theme test providers. Assert an available percent window renders its provider label, progress bar, formatted percent, and reset label. Assert an unauthorized and an error snapshot each render `Usage unavailable`, while unsupported snapshots are absent.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
bun test packages/tui/test/cli/tui/provider-usage-command.test.tsx
```

Expected: FAIL because dialog content is not implemented.

- [ ] **Step 3: Implement the read-only dialog content**

Use the established non-select dialog layout from `DialogStatus`: title row, `esc` close hint, vertical provider sections, contextual elevated theme, and no selectable rows. For available/stale snapshots, render percentage bars and all formatted window values. For unauthorized/error snapshots, render exactly `Usage unavailable` and no fake zero values.

- [ ] **Step 4: Implement refresh-on-open with stale-result protection**

`ProviderUsageDialog` must:

```ts
const client = useClient()
const [snapshots, setSnapshots] = createSignal(visibleProviderSnapshots(props.initialSnapshots))
const guard = createProviderUsageGenerationGuard()

onMount(() => {
  const token = guard.next()
  void Promise.all(
    props.providerIDs.map((providerID) => client.api.providerUsage.get({ providerID, refresh: true })),
  ).then((results) => {
    if (!guard.current(token)) return
    setSnapshots(visibleProviderSnapshots(results.map((result) => result.data)))
  })
})
onCleanup(() => guard.invalidate())
```

Catch request failures and convert them to no destructive UI update; API-level unauthorized/error snapshots remain visible as `Usage unavailable`.

- [ ] **Step 5: Run the focused test and verify pass**

Run the focused Bun test. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/routes/session/provider-usage.tsx packages/tui/test/cli/tui/provider-usage-command.test.tsx
git commit -m "feat: add provider usage dialog"
```

---

### Task 3: Session command registration and sidebar removal

**Files:**
- Modify: `packages/tui/src/routes/session/provider-usage.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx`
- Modify: `packages/tui/src/plugin/builtins.ts`
- Delete: `packages/tui/src/feature-plugins/sidebar/provider-usage.tsx`
- Delete: `packages/tui/test/cli/tui/provider-usage-sidebar.test.tsx`
- Modify: `packages/tui/test/cli/tui/provider-usage-command.test.tsx`

**Interfaces:**
- Consumes: `useRouteData("session")`, `useData()`, `useClient()`, `useDialog()`, `Keymap.createLayer()`.
- Produces: `ProviderUsageCommand(): JSX.Element` mounted once inside the session route.

- [ ] **Step 1: Write failing command visibility/controller tests**

Test the exported command-state helper or controller boundary so that:

- no running providers produces no command;
- only unsupported snapshots produces no command;
- an available, stale, unauthorized, or error snapshot produces the `session.provider-usage` command;
- duplicate running sessions using one provider issue one provider probe;
- a late result for an older provider set cannot replace the newest snapshots.

Also add a source-level assertion that `packages/tui/src/plugin/builtins.ts` does not contain `SidebarProviderUsage` or `sidebar/provider-usage`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
bun test packages/tui/test/cli/tui/provider-usage-command.test.tsx
```

Expected: FAIL because command registration and sidebar removal are incomplete.

- [ ] **Step 3: Implement the session-scoped command controller**

`ProviderUsageCommand` must derive family IDs reactively:

```ts
const family = createMemo(() => data.session.family(route.sessionID))
const providerIDs = createMemo(() =>
  runningProviderIDs(family(), data.session.get, data.session.status),
)
```

Probe each unique ID once with `client.api.providerUsage.get({ providerID })`. Use a generation token for every provider-set change. Register one global keymap layer whose command array is empty until `visibleProviderSnapshots(snapshots()).length > 0`; otherwise register:

```ts
{
  id: "session.provider-usage",
  title: "Provider Usage",
  group: "Session",
  palette: true,
  bind: false,
  run: () => dialog.replace(() => (
    <ProviderUsageDialog providerIDs={providerIDs()} initialSnapshots={snapshots()} />
  )),
}
```

When provider IDs become empty, invalidate pending probes and clear snapshots immediately.

- [ ] **Step 4: Mount the controller and remove sidebar integration**

Import and render `<ProviderUsageCommand />` beside `<SessionMemoryCommand sessionID={route.sessionID} />`. Remove the provider-usage import and array entry from `plugin/builtins.ts`. Delete the obsolete sidebar component and test.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun test packages/tui/test/cli/tui/provider-usage-command.test.tsx
bun run --cwd packages/tui typecheck
```

Expected: all pass.

- [ ] **Step 6: Run integration verification**

Run:

```bash
bun test packages/tui/test/cli/tui
bun test packages/tui/test/app-lifecycle.test.tsx
bun run typecheck
bun run lint
bun run check:ycoding-workspace
bun run check:ycoding-brand
bun run --cwd packages/client generate
git diff --exit-code -- packages/client/src/effect/generated/client.ts packages/client/src/promise/generated/client.ts
```

Expected: zero test failures, typecheck success, lint exit code 0, both repository checks pass, and no generated-client drift.

- [ ] **Step 7: Verify diff hygiene and commit**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Confirm `.okf/` remains untracked and unstaged. Then:

```bash
git add packages/tui/src/routes/session/provider-usage.tsx packages/tui/src/routes/session/index.tsx packages/tui/src/plugin/builtins.ts packages/tui/test/cli/tui/provider-usage-command.test.tsx packages/tui/src/feature-plugins/sidebar/provider-usage.tsx packages/tui/test/cli/tui/provider-usage-sidebar.test.tsx
git commit -m "feat: move provider usage to command palette"
```
