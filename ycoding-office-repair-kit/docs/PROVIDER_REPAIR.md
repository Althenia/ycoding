# Real provider integration repair

**Required by the original request:** exercise the actual desktop-to-provider flow, not types or a fixture. **Current failure cause: unknown.** The provider/model text shown in a screenshot is not proof of a configured or working provider.

## Authoritative route

```text
Godot composer and session selection
  → existing application/controller/transport
  → configured local YCoding service public API
  → current runtime configuration + credential resolution
  → actual provider request and existing tool/guardrail path
  → response/event handling + canonical durable state
  → Godot transcript, office activity, error/stop UI
```

Keep one runtime and credential owner. Do not call the remote model API directly from Godot to “fix” the service integration. Retain local HTTP and existing authentication; no new proxy/capability infrastructure is necessary without a demonstrated failure.

## Boundary-by-boundary reproduction

1. Verify service discovery/startup and its actual endpoint/auth contract. Distinguish service not running, wrong endpoint, incompatible API shape and local-service unauthorized responses.
2. Compare desktop and TUI using the **same repository/location, session context, effective provider/model, configuration scope and service process**. A GUI launch may have a different environment than an interactive shell. Inspect only necessary key presence/ownership—not values or a full environment dump.
3. Inspect catalog/config loading, saved credentials and precedence in the real code. Never assume `.env`, shell profile or another provider's configuration applies. Use the existing supported config mechanism; do not source arbitrary shell text from a GUI process.
4. Trace displayed selection to the effective request. Preserve provider-qualified model identifiers and model-specific optional parameters. Reject invalid selections with a useful error; never substitute an unrelated model silently.
5. Trace a normal composer submission through admitted input, actual execution, stream/response settlement and persisted transcript. Correlate safe session/message/request identifiers. A successful admission response is not proof that a provider call finished.
6. Run stop/cancellation and reconnect against the same path. Reconcile ambiguous timeout outcomes before retrying. Reuse existing input identity semantics where verified; avoid accidental duplicate side effects or another paid request.

## Minimal authorized live verification

Use an already configured provider/credential only, through the desktop. Make one small bounded prompt such as “Reply with a single short confirmation.” Cap output with the runtime's supported request controls; do not invent fields. Do not purchase credits, change billing, raise limits or expose credentials. Record provider/model, source scope, safe identifiers, start/end times, terminal state and evidence paths. A plain-text smoke verifies connectivity only; tool/approval behavior needs separate controlled tests.

After fixing connectivity, verify at least: real streamed updates where supported; cancel/stop; saved configuration and effective selection after restart; history re-open; provider error without demo fallback. Where tools are configured, use a disposable workspace and one harmless read/test operation to verify the real tool/permission path. Do not mutate the user's project merely to prove tools work.

If credentials or provider capacity are unavailable, complete all source/layout/unit/integration repairs that do not require them. Mark live verification **blocked**, specify the smallest missing input and preserve truthful errors. Never mark the provider gate complete based on a simulation. A reference screenshot about another application's usage limit is not a YCoding root-cause diagnosis.

## Error handling matrix

| Failure | Expected desktop behavior | Must not do |
|---|---|---|
| Local service unavailable | Connection/retry action; preserve draft; no active fake workers | Switch to demo |
| Missing config/credentials | Open the relevant supported configuration flow | Hardcode keys or claim success |
| Local service 401/403 | Correct connection/auth path, distinguish from provider auth | Blame the model without evidence |
| Provider auth/model error | Sanitized actionable message and effective provider/model | Silently switch model/provider |
| Rate limit/quota | Surface retry/reset information only when actually supplied | Invent reset times or replay fake output |
| Timeout/disconnect | Uncertain/reconnecting state; reconcile admitted/active work | Blind duplicate prompt submission |
| Malformed/partial stream | Preserve valid partial text and show incomplete/error status | Mark finished from EOF alone |
| Cancellation | Acknowledge runtime stop/settlement; keep appropriate partial history | Stop animation only |
| Tool permission/review | Show actual pending interaction and permitted answers | Auto-approve hard review |

## Evidence and privacy

Use [tracking/provider_verification.json](../tracking/provider_verification.json) and evidence records. Tests use safe fixtures only in isolated test contexts. Store sanitized logs, not headers, API keys, raw request bodies, credential files or sensitive tool output. A response excerpt can itself contain secrets; inspect before attaching evidence. This kit's scanner deliberately emits category/line references rather than source snippets.
