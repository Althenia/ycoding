# Concurrent provider profiles

## Selection boundary

The optional `profile` in [Model.Ref](../packages/schema/src/model.ts) selects a named credential within the selected provider's integration. Provider and model identifiers retain their meaning. The structured configuration model selector accepts the same field; string shorthand uses `[profile#]provider/model[#variant]`. Omitting the profile uses the provider's global default.

Sessions and subagents may select different profiles for the same provider and model concurrently. Explicit selection must not activate a provider-wide profile, rotate through accounts, or fall back to another credential. An omitted profile uses normal default resolution. Catalog profile entries expose eligible user-chosen names, whether each is the provider's active default, and optional account-specific Daybreak programs. The default flag does not describe a Session's selection. An explicit profile uses its own `daybreak` list; an absent list advertises no programs, never another profile's programs.

`GET /api/model/default` retains the model information in `data` and includes its selected model reference in `data.selection`. Consumers must preserve the selection's variant and profile rather than reconstructing a reference from model metadata.

Each eligible profile exposes optional `variants` containing only variant IDs, not account-specific settings or request overlays. Explicit profile selection uses that list; an absent or empty list advertises no effort overrides. Provider-default selection uses the model-wide variants. A model available only to a named profile remains in the catalog even when its default-account `enabled` flag is false; selecting it without that eligible profile fails rather than borrowing another account.

## Binding and lifetime

An explicit Session selection binds privately to the provider, integration, profile name, credential identity, and account generation. The public model reference contains only the profile name, not the binding. Public model selection and private binding must commit atomically; observers must not receive either transition before commit or after rollback.

The provider's active default may change without redirecting explicitly bound Sessions. Missing, renamed, removed, or replaced profiles fail before provider traffic. Deleting and recreating the same name does not authorize an existing Session to use the new account. Explicitly selecting that named profile again establishes a new binding, even when the visible model reference is unchanged.

Each physical attempt uses one consistent credential snapshot for authentication, account headers, route construction, and provenance. Same-credential refresh is coordinated across Locations; different credentials may refresh independently. A stale refresh cannot overwrite a replacement or resurrect a deleted credential. Ordinary token refresh preserves account generation; explicit credential replacement advances it.

Session adoption and admitted-input retries retain their existing first-admission semantics. Reusing a Session or input ID must not rebind an account. Explicit model selection, not retry, is the rebind boundary.

## Inheritance and replay

Existing model-precedence rules remain authoritative. An explicit profile on the selected model wins. An explicitly selected helper or subagent model with no profile uses that provider's global default, regardless of the owning Session's provider or profile. When model precedence selects the owning Session's complete model reference, its profile remains selected. A profile name is never inherited independently across providers.

Stable account identity and rotating token generation are distinct. Prompt-cache and provider-session namespaces must distinguish accounts without changing merely because an OAuth token refreshes. Provider continuation additionally retains its request, route, options, and credential-snapshot fences.

Stored profiles use their credential identity and account generation. For environment or configuration authentication, matching provenance requires the same captured effective authentication and routing context, represented only by a private domain-separated digest. Changing that authentication invalidates reuse. A provider name or environment-variable name alone is not account evidence; uncaptured authentication remains unknown.

Signed or encrypted reasoning, provider metadata, opaque provider state, response IDs, and affinity tokens may be replayed only with matching recorded account provenance. Missing provenance is not proof of a match. Ordinary transcript text and canonical tool history remain available; withholding account-bound artifacts does not delete or rewrite durable history.

Remote compaction may omit covered canonical history only when its retained artifact has matching account provenance. Otherwise request assembly retains the canonical history. Forks inherit the selected binding but remint copied message IDs without copying billing records; copied messages therefore have unknown provider provenance and cannot replay account-bound artifacts.

## Persistence and privacy

The private persistence additions are the credential account generation, Session profile binding, and provider-request assistant-message/account-provenance fields. Binding and request provenance are reconstructible from private durable facts. They must remain excluded from public event manifests, Session logs, remote catalogs, and browser state.

Migration initializes credential account generation to zero and leaves historical Session bindings and request provenance absent. It must not infer prior account ownership or rewrite history. Fresh and migrated schemas must agree, and existing credentials, token generations, and Session records must be preserved.

User-chosen profile names are display data. Catalogs must not derive them from account emails or expose credentials, credential IDs, managed account-source identifiers, or identity digests as new public model fields.

## Consumers and usage

### Remote profile connection

The web command palette exposes **Connect provider** for the selected Session or the new-session composer's selected repository. This is provider authentication on the connected backend, distinct from selecting or enrolling a machine. **Select provider and model…** selects existing credentials without activating a provider-wide profile.

Location-scoped `provider.integrations` (`GET /api/provider/integrations`) returns only [Provider.IntegrationRef](../packages/schema/src/provider.ts) mappings. Discovery waits for the plugin generation to initialize, includes providers without credentials, and excludes disabled or policy-denied provider definitions. `provider.list` describes available providers; it is not authentication discovery. Method and named-profile metadata come from the local integration APIs, without exposing credential values or identifiers.

The closed [remote operation set](../packages/remote/src/index.ts) admits `provider.auth.list`, `provider.auth.key`, `provider.auth.begin`, `provider.auth.status`, `provider.auth.complete`, and `provider.auth.cancel`. Inputs name exactly one existing Session or opaque repository workspace; the backend resolves and verifies its Location. Browser input cannot choose a directory, URL, command, or HTTP request. Key connection and attempt start require an explicit profile name. Reusing a name replaces that profile; successful connection makes it the provider's global default. Existing explicitly bound Sessions retain their binding rules.

Keys and manual authorization codes cross the authenticated owner/device relay only for the requested operation and persist on the backend through the existing credential lifecycle. The browser retains no submitted secret in preferences, mutation history, or request diagnostics. Telemetry records anonymous operation names and timings only. Remote profile metadata exposes user-chosen names and active-default flags; it excludes credential IDs, managed CLI account-source IDs, stored tokens, provider settings, and raw command diagnostics. Authentication failures use generic messages rather than provider or command output.

OAuth methods declare the optional [Integration.OAuthMethod](../packages/schema/src/integration.ts) `remote` capability explicitly. A true value asserts that authorization can complete from a different browser device; an absent or false value remains listed with local-sign-in guidance and cannot start remotely. OpenAI headless, xAI device, Copilot device, Cursor token-polling, OpenCode Console device authorization, and Claude Code isolated-account sign-in advertise this capability. Backend-loopback callback methods require sign-in on that machine. Remote authorization links must use HTTPS without embedded credentials or loopback hosts. Registered command methods accept only their existing method ID; they run on the backend, expose no command arguments or output, and may require browser interaction on that machine.

Attempts are bound to the initiating integration, target, and resolved Location in the machine connector. Cross-target, moved-Location, expired, or unknown attempts fail before completion or cancellation reaches the local API. Core owns attempt expiry and resource release; the remote bridge retains no attempt beyond its expiry and bounds its retained attempts. Closing the web dialog cancels a known pending attempt when its original connection remains available. An unconfirmed start without an attempt ID relies on backend expiry and must not be replayed automatically.

The dialog fences reads and actions to its machine connection and fences older status replies against newer settlement. Failed status reads leave an unresolved attempt available only for explicit status checking or cancellation; terminal settlement removes authorization links and code controls. Unknown key, start, completion, or cancellation outcomes never trigger automatic mutation replay. Reconnects do not resume an old dialog's mutations. Catalog refresh after successful connection supplies the existing model/profile picker with the backend's current inventory.

TUI and web model pickers must display explicit and unavailable profile selections, retain them in preferences and pending submissions, and distinguish a profile-only switch. **Use provider default** clears explicit selection. A rejected switch preserves the draft and admits no prompt under another account. Explicit reselection of the same named profile must remain available for binding recovery.

Changing model or fast mode within a provider must not clear an explicit profile merely because the target does not offer it. Retain that profile as unavailable and block sending, or require an explicit profile choice before committing the change. Choosing a different provider does not transfer the old provider's profile name.

Remote model entries carry profile-specific variant IDs and may carry `enabled: false` when only named profiles can use the model. Omitted `enabled` means the provider default is eligible. The transport publishes no per-account variant settings or request overlays.

Account-dependent model eligibility and provider request options must come from the selected account, not another account's active-default catalog state. Response observations belong to the dispatched profile. Quota data retains its source, stability, and unknown-value semantics. Provider-wide local spend must not be presented as historical per-profile billing.

Apply provider and model configuration overlays to each account-specific model before runtime selection. Preserve configured package, endpoint, settings, headers, body, and variant precedence for both default and explicitly named profiles without copying discovered fields from another account.

See [provider usage](./provider-usage.md), [provider configuration](../docs/configuration.md#provider-profiles), and [runtime behavior](../docs/runtime.md).
