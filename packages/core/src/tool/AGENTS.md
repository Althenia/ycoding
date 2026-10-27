# Core Tool Architecture

This folder owns Core's one local tool representation, process and Location registration, effective lookup, and settlement.

## Representations

- `tool.ts` defines the structural canonical `Tool.make({ description, input, output, execute, toModelOutput })` declaration. Shipped built-ins and plugin tools use the same type.
- `tools.ts` exposes the registration-only `Tools.Service` view used by Location producers.
- `registry.ts` stores only canonical Location registrations, derives definitions, invokes tools, and applies generic output bounding.

Do not add a second executable entry type, registry-owned executor, authorization callback, output-path callback, or legacy normalization path.

## Construction

Tool schemas and projection use `input` and `output` terminology. A tool value carries its schemas, executor, projection, and optional catalog permission directly so separately loaded plugin package instances can exchange it structurally.

Location-scoped built-in layers acquire `Permission.Service` and every other required Location service while the layer is constructed. The executor captures those services. Permission sources are always constructed from the canonical invocation context:

```ts
const source = {
  type: "tool" as const,
  messageID: context.messageID,
  callID: context.callID,
}
```

Leaves own resolution, permission, and side-effect ordering. Translate only expected typed errors into `ToolFailure`; do not use `catchCause`, because interruption and defects must survive.

## Registration

Built-ins and plugin tools register through `Tools.Service.register({ [name]: tool })`. Registrations may provide a
namespace, which flattens direct model names to `<namespace>_<tool>`, and default into CodeMode (`codemode` defaults true;
`codemode: false` also exposes the tool on the provider's native tool list). Every visible registration remains callable through CodeMode.

Registrations are scoped:

- The latest active same-placement registration wins.
- Closing any registration removes only that registration and reveals the next active one.
- Each model request captures the effective tools it advertises; later registration changes affect later requests.

`ToolRegistry.Service` is Location-scoped. Do not make the registry process-global or construct a separate application-tool service for each Location.

## Permissions

The registry has no `Permission.Service` dependency and performs no execution authorization. An internal built-in-only operation attaches a permission action solely to preserve whole-tool definition filtering; it is not part of public `Tool.make`. Most tools default to their registered name; `edit`, `write`, and `patch` declare the shared `edit` action.

Definition filtering is catalog visibility, not execution authorization. A call still executes the captured leaf policy if it reaches settlement.

`materialize` and `available` share one visibility filter: a wholly denied permission action or a name excluded by `capabilities` (`ConfigCapabilities.allowsTool`) hides the tool from the direct list and from CodeMode. Callers pass the resolved capabilities; the registry does not read configuration.

## Output

Built-ins return complete validated domain output. Nested calls pass through registry before and after hooks and return their structured results to the program without generic model-output bounding. `ToolRegistry.Materialization.settle` bounds the outer provider-facing settlement and owns managed retention paths. Preserve the outer call ID in permission sources and use each nested invocation ID for Job and subagent operation identity. Commit each completed leaf receipt before returning to the program; fold it into the outer tool part without exposing intermediate structured receipts to the model. Full tool progress is ephemeral. A failed outer execution cannot signal completion.

Producer capture limits are separate. For example, Bash keeps `AppProcess.maxOutputBytes` and accurately reports stdout/stderr capture loss, but it does not run model-output truncation or return a managed `outputPath`.

## Current Gaps

- Future Session-scoped registrations still need an explicit canonical registration design.
- The public Session result shape currently exposes managed `outputPaths`; full storage encapsulation requires a future opaque managed-output reference design.
