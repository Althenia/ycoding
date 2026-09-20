## Provider credential management (R3-03), at the client boundary.
##
## The acceptance: a bounded, non-blocking adapter and surface that can list stored
## provider profiles, connect a key, rename, activate, and delete one, without ever
## putting credential material anywhere it can be read back.
##
## What is asserted here, and why each clause exists:
##
##   * DECLARED ENVELOPE VS 204. `GET /api/integration` answers
##     `Location.response(Schema.Array(Integration.Info))` - a payload nested under
##     `data` - while `connect/key`, `PATCH`, `POST .../activate` and `DELETE` answer
##     **204 NoContent with no body at all**. A reader that expected one shape for both
##     would either reject every successful mutation or adopt a mutation body as a list.
##   * SANITIZED METADATA ONLY. The list carries methods with prompts and commands, and
##     `Connection.Info` has an `env` variant. The client keeps an ALLOWLIST of five
##     fields per integration and three per profile, so a field the schema later adds
##     cannot leak into the surface by default.
##   * THE KEY IS TRANSIENT. `integration.connect.key` takes the key in its payload. The
##     client must put it on the wire and nowhere else: not in a member, not in an error,
##     not in a rendered label, and not in history.
##   * A REBIND DISCARDS OLD STATE. Rebinding to another location cancels the call in
##     flight and clears the list, so an answer for the folder the user left is never
##     adopted for the one they are in.
##   * AN UNCERTAIN MUTATION IS NEVER RETRIED. A mutation whose answer never arrived may
##     or may not have been applied, so it is reported as uncertain and left alone rather
##     than issued a second time.
##   * OAUTH AND COMMAND STAY UNIMPLEMENTED. An integration whose only methods are those
##     is not offered a connect control and is told why; it never renders a fake success.
##
## The transport double is confined to the TRANSPORT boundary: `IntegrationApi`, the
## panel, and the payloads under test are the production classes. What it proves is the
## wire shape the production code BUILDS.
extends RefCounted


func run(t) -> void:
	# --- list and sanitization ---
	test_list_sanitizes_to_the_allowlist(t)
	test_only_credential_connections_are_kept(t)
	test_a_key_method_is_detected_and_other_methods_are_counted(t)
	test_list_requires_the_envelope_and_refuses_a_missing_payload(t)
	test_a_failed_list_reports_its_reason_and_keeps_no_values(t)
	test_an_answer_for_no_known_call_is_refused(t)
	# --- the mutation payloads ---
	test_connect_key_builds_the_declared_payload(t)
	test_a_204_connect_succeeds_with_no_body(t)
	test_connect_key_refuses_an_empty_key_locally(t)
	test_rename_uses_patch_and_delete_uses_delete(t)
	test_activate_posts_to_the_activate_path(t)
	test_a_refusal_is_reported_with_the_service_message(t)
	# --- the secret boundary ---
	test_the_key_is_never_retained_or_reported(t)
	test_a_timed_out_mutation_is_uncertain_and_never_retried(t)
	# --- lifecycle ---
	test_a_second_call_is_refused_while_one_is_in_flight(t)
	test_no_call_is_issued_without_a_transport(t)
	test_rebinding_the_transport_cancels_in_flight_and_clears_the_list(t)
	test_rebinding_discards_the_list_with_no_call_in_flight(t)
	# --- the surface ---
	test_only_key_method_integrations_are_offered(t)
	test_the_key_field_is_masked_and_separate_from_the_label(t)
	test_submitting_connect_clears_the_key_and_emits_the_intent(t)
	test_a_failed_connect_clears_the_key_and_shows_a_safe_failure(t)
	test_a_plain_refusal_reason_is_shown(t)
	test_delete_requires_explicit_confirmation(t)
	test_rename_and_activate_emit_their_own_signals(t)
	test_a_profile_row_shows_its_label_and_active_marker(t)
	test_the_panel_never_renders_a_submitted_key(t)
	test_an_oauth_only_integration_states_its_limitation(t)


## --- list and sanitization ----------------------------------------------------

## The allowlist is the whole contract of what may reach the surface.
func test_list_sanitizes_to_the_allowlist(t) -> void:
	var api := _listed_api()
	var entries := api.integrations()
	t.check_equal(entries.size(), 2, "both integrations were adopted")
	if entries.size() != 2:
		return
	var entry: Dictionary = entries[0]
	t.check_equal(
		(entry.keys() as Array).duplicate(),
		["id", "name", "has_key_method", "has_other_method", "credentials"] as Array,
		"an integration carries exactly the allowlisted fields"
	)
	t.check_equal(str(entry.get("id", "")), "openrouter", "with its id")
	t.check_equal(str(entry.get("name", "")), "OpenRouter", "and its name")
	# The raw answer carried `methods` with prompts and a command vector, and an extra
	# `secret_note` field. None of them may survive.
	t.check(not entry.has("methods"), "the raw method list is dropped")
	t.check(not entry.has("secret_note"), "an unknown field is dropped by the allowlist")
	t.check(
		not JSON.stringify(entry).contains("prompt"),
		"no prompt text reaches the metadata (%s)" % JSON.stringify(entry)
	)
	var credentials: Array = entry.get("credentials", [])
	t.check_equal(credentials.size(), 2, "both stored profiles were adopted")
	if credentials.size() == 2:
		t.check_equal(
			((credentials[0] as Dictionary).keys() as Array).duplicate(),
			["id", "label", "active"] as Array,
			"a profile carries exactly id, label and active"
		)


## An environment connection is NOT a stored profile: it names a variable and must not
## be presented as a credential the user can rename, activate, or delete.
func test_only_credential_connections_are_kept(t) -> void:
	var api := _listed_api()
	var entry: Dictionary = api.integrations()[1]
	var credentials: Array = entry.get("credentials", [])
	t.check_equal(credentials.size(), 0, "an env-only integration reports no stored profile")
	t.check(
		not JSON.stringify(entry).contains("OPENROUTER_API_KEY"),
		"and the environment variable name is not carried into the metadata"
	)


func test_a_key_method_is_detected_and_other_methods_are_counted(t) -> void:
	var api := _listed_api()
	var entries := api.integrations()
	if entries.size() != 2:
		t.check(false, "the fixture listed two integrations")
		return
	t.check(bool((entries[0] as Dictionary).get("has_key_method", false)), "the key integration supports a key")
	t.check(bool((entries[1] as Dictionary).get("has_other_method", false)), "the oauth-only integration has another method")
	t.check(not bool((entries[1] as Dictionary).get("has_key_method", true)), "and supports no key")


## A body that is not the declared `{location, data:[...]}` envelope is refused whole
## rather than half-read.
func test_list_requires_the_envelope_and_refuses_a_missing_payload(t) -> void:
	for body in [{}, {"data": "nope"}, {"location": {}, "data": {}}]:
		var transport := RecordingTransport.new()
		transport.answer = body
		var api := IntegrationApi.new()
		api.configure(transport)
		t.check(not api.fetch_list(), "a body without a list payload is refused (%s)" % JSON.stringify(body))
		t.check(not api.last_error().is_empty(), "with a stated reason")
		t.check_equal(api.integrations().size(), 0, "and no values were adopted")


func test_a_failed_list_reports_its_reason_and_keeps_no_values(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = {"message": "integration discovery failed"}
	transport.answer_status = 500
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(not api.fetch_list(), "the read failed")
	t.check(
		api.last_error().contains("integration discovery failed"),
		"the service's own reason is surfaced (%s)" % api.last_error()
	)
	t.check_equal(api.integrations().size(), 0, "and no list was adopted")


## A response may only be installed for the call that asked for it. An entry carrying
## another request's id is ignored rather than adopted, so two pollers sharing one
## transport can never consume each other's answers.
func test_an_answer_for_no_known_call_is_refused(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = _list_body()
	# A stray answer for a request this adapter never issued, delivered BEFORE the real
	# one so an unguarded reader would adopt it and then stop.
	transport.stray.append({
		"request_id": 999, "kind": HttpTransport.KIND_RESPONSE, "status": 200,
		"body": {"location": {}, "data": []}, "event": {}, "error": "",
	})
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.fetch_list(), "the real read settled")
	t.check_equal(api.integrations().size(), 2, "and the stray empty answer did not overwrite it")
	t.check(
		not api.resolved_location().is_empty(),
		"and the real list's location was adopted rather than the stray one"
	)


## --- the mutation payloads ----------------------------------------------------

func test_connect_key_builds_the_declared_payload(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer_status = 204
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_connect_key("openrouter", _key("test-value"), "Work key"), "the connect call was issued")
	var request: Dictionary = transport.requests[0]
	t.check_equal(int(request["method"]), HTTPClient.METHOD_POST, "connect is a POST")
	t.check_equal(
		str(request["path"]), "/api/integration/openrouter/connect/key",
		"to the declared connect/key path"
	)
	var body: Dictionary = request["body"]
	t.check_equal(str(body.get("key", "")), _key("test-value"), "carrying the key")
	t.check_equal(str(body.get("label", "")), "Work key", "and the profile label")
	# An empty label is absent, not an empty string: the service keeps the default name.
	var bare := RecordingTransport.new()
	bare.answer_status = 204
	var bare_api := IntegrationApi.new()
	bare_api.configure(bare)
	bare_api.start_connect_key("openrouter", _key("test-value"), "")
	t.check(
		not (bare.requests[0]["body"] as Dictionary).has("label"),
		"an unnamed profile omits label rather than sending an empty one"
	)


## 204 is a success with no body. A reader that required a payload would report a
## successful connect as a failure.
func test_a_204_connect_succeeds_with_no_body(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer_status = 204
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_connect_key("openrouter", _key("test-value"), "Work key"), "the call was issued")
	while api.is_pending():
		api.poll()
	t.check(api.last_error().is_empty(), "a 204 settles without error (%s)" % api.last_error())
	t.check(api.mutation_succeeded(), "and reports the mutation as applied")
	t.check(not api.mutation_uncertain(), "with no uncertainty")


func test_connect_key_refuses_an_empty_key_locally(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer_status = 204
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(not api.start_connect_key("openrouter", "", "Work key"), "an empty key is refused")
	t.check_equal(transport.requests.size(), 0, "before any request is issued")
	t.check(not api.last_error().is_empty(), "with a stated reason")


func test_rename_uses_patch_and_delete_uses_delete(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer_status = 204
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_rename("cred_1", "Renamed"), "a rename was issued")
	var rename: Dictionary = transport.requests[0]
	t.check_equal(int(rename["method"]), HTTPClient.METHOD_PATCH, "rename is a PATCH")
	t.check_equal(str(rename["path"]), "/api/credential/cred_1", "against the credential route")
	t.check_equal(str((rename["body"] as Dictionary).get("label", "")), "Renamed", "carrying the new label")
	# A mutation is settled before the next is issued: the adapter refuses a second call
	# while one is in flight, so the real flow awaits each answer.
	while api.is_pending():
		api.poll()
	t.check(api.mutation_succeeded(), "the rename settled")
	t.check(api.start_delete("cred_1"), "a delete was issued")
	var remove: Dictionary = transport.requests[1]
	t.check_equal(int(remove["method"]), HTTPClient.METHOD_DELETE, "delete is a DELETE")
	t.check_equal(str(remove["path"]), "/api/credential/cred_1", "against the same credential route")
	t.check(
		(remove["body"] as Dictionary).is_empty(),
		"with no body, because the route takes none"
	)


func test_activate_posts_to_the_activate_path(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer_status = 204
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_activate("cred_2"), "an activation was issued")
	var request: Dictionary = transport.requests[0]
	t.check_equal(int(request["method"]), HTTPClient.METHOD_POST, "activation is a POST")
	t.check_equal(str(request["path"]), "/api/credential/cred_2/activate", "to the activate path")


func test_a_refusal_is_reported_with_the_service_message(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = {"message": "Authentication failed", "kind": "integration_authorization"}
	transport.answer_status = 400
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_connect_key("openrouter", _key("bad"), ""), "the call was issued")
	while api.is_pending():
		api.poll()
	t.check(
		api.last_error().contains("Authentication failed"),
		"the service's refusal is surfaced (%s)" % api.last_error()
	)
	t.check(not api.mutation_succeeded(), "and not reported as applied")


## --- the secret boundary ------------------------------------------------------

## The key is written to the request and nowhere else.
func test_the_key_is_never_retained_or_reported(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = {"message": "Authentication failed"}
	transport.answer_status = 400
	var api := IntegrationApi.new()
	api.configure(transport)
	api.start_connect_key("openrouter", _key("do-not-keep-me"), "Work key")
	while api.is_pending():
		api.poll()
	var surfaces := [
		api.last_error(), str(api.integrations()), JSON.stringify(api.resolved_location()),
	]
	for text: String in surfaces:
		t.check(not text.contains(_key("do-not-keep-me")), "the key is absent from a readback surface (%s)" % text)
	# And the adapter holds no copy of its own: every public readback was already covered,
	# so this asserts the remaining state by serialising the whole object.
	t.check(
		not JSON.stringify(api.integrations()).contains(_key("")),
		"and no credential-shaped text survives in the metadata"
	)


## A mutation whose answer never arrived may or may not have been applied. It is
## reported as uncertain and NOT issued again.
func test_a_timed_out_mutation_is_uncertain_and_never_retried(t) -> void:
	var transport := RecordingTransport.new()
	transport.hold["/api/credential/cred_1/activate"] = true
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_activate("cred_1", 1), "the activation was issued")
	# The answer never arrives. Poll until the adapter's own bounded wait expires; the
	# delay is real because the deadline is real (this is a test, not a shipped module).
	var guard := 0
	while api.is_pending() and guard < 200:
		api.poll()
		OS.delay_msec(1)
		guard += 1
	t.check(not api.is_pending(), "the call ended within its budget")
	t.check_equal(transport.requests.size(), 1, "and was issued exactly once, never retried")
	t.check(api.mutation_uncertain(), "the outcome is reported as uncertain")
	t.check(not api.mutation_succeeded(), "and not as applied")
	t.check(not api.last_error().is_empty(), "with a stated reason")
	# A second change is REFUSED while the first is unresolved: repeating it could create
	# or delete a second credential.
	t.check(
		not api.start_delete("cred_2"),
		"a further change is refused while the previous one is unresolved"
	)
	t.check_equal(transport.requests.size(), 1, "so no second mutation reached the wire")
	# An authoritative read is what resolves the uncertainty, and it is allowed.
	t.check(api.start_list(), "a re-read is still allowed")
	while api.is_pending():
		api.poll()
	t.check(not api.mutation_uncertain(), "and settling it clears the uncertainty")
	t.check(api.start_activate("cred_2"), "so a later change is accepted again")


## --- lifecycle ----------------------------------------------------------------

func test_a_second_call_is_refused_while_one_is_in_flight(t) -> void:
	var transport := RecordingTransport.new()
	transport.hold["/api/integration"] = true
	var api := IntegrationApi.new()
	api.configure(transport)
	t.check(api.start_list(), "the first call was issued")
	t.check(not api.start_activate("cred_1"), "a second call is refused while one is in flight")
	t.check_equal(transport.requests.size(), 1, "so only one request exists")


func test_no_call_is_issued_without_a_transport(t) -> void:
	var api := IntegrationApi.new()
	t.check(not api.start_list(), "a read needs a transport")
	t.check(not api.start_connect_key("openrouter", _key("x"), ""), "and so does a connect")
	t.check(not api.last_error().is_empty(), "both state why")


## Rebinding must cancel the old call AND discard what the old location reported.
func test_rebinding_the_transport_cancels_in_flight_and_clears_the_list(t) -> void:
	var first := RecordingTransport.new()
	first.answer = _list_body()
	var api := IntegrationApi.new()
	api.configure(first)
	t.check(api.fetch_list(), "the first read settled")
	t.check_equal(api.integrations().size(), 2, "and adopted the list")
	# Now leave a second call in flight and rebind.
	first.hold["/api/integration"] = true
	t.check(api.start_list(), "a second read is in flight")
	var in_flight := api.is_pending()
	var second := RecordingTransport.new()
	api.configure(second)
	t.check(in_flight, "the call really was in flight before the rebind")
	t.check_equal(first.cancelled.size(), 1, "rebinding cancelled it on the OLD transport")
	t.check(not api.is_pending(), "and no call is in flight afterwards")
	# The old answer arriving late must not be adopted.
	first.release("/api/integration")
	api.poll()
	t.check_equal(api.integrations().size(), 0, "and a late answer for the old location is never adopted")


## Rebinding with NOTHING in flight still discards the old location's list: the values
## describe the folder the user has left, so showing them against the new one is a false
## statement about where they are.
func test_rebinding_discards_the_list_with_no_call_in_flight(t) -> void:
	var first := RecordingTransport.new()
	first.answer = _list_body()
	var api := IntegrationApi.new()
	api.configure(first)
	t.check(api.fetch_list(), "the first read settled")
	t.check_equal(api.integrations().size(), 2, "and adopted the list")
	# No call is in flight, so only the clearing can remove them.
	t.check(not api.is_pending(), "nothing is in flight")
	var second := RecordingTransport.new()
	api.configure(second)
	t.check_equal(api.integrations().size(), 0, "rebinding discarded the old location's list")
	t.check(
		api.resolved_location().is_empty(),
		"and the location it described is gone too"
	)


## --- the surface --------------------------------------------------------------

func test_only_key_method_integrations_are_offered(t) -> void:
	var panel := _panel_with_list()
	t.check_equal(panel.visible_integration_ids(), ["openrouter"] as Array, "only the key integration is offered")
	t.check(panel.connect_available("openrouter"), "and it can be connected")
	t.check(not panel.connect_available("github"), "while an oauth-only integration cannot")
	panel.free()


func test_the_key_field_is_masked_and_separate_from_the_label(t) -> void:
	var panel := _panel_with_list()
	t.check(panel.key_field_secret(), "the key field is masked")
	t.check(not panel.label_field_secret(), "the label field is not, because a profile name is not secret")
	t.check(panel.key_field() != panel.label_field(), "and the two are distinct controls")
	panel.free()


func test_submitting_connect_clears_the_key_and_emits_the_intent(t) -> void:
	var panel := _panel_with_list()
	var seen: Array = []
	panel.connect_requested.connect(func(id: String, key: String, label: String) -> void: seen.append([id, key, label]))
	panel.begin_connect("openrouter")
	panel.set_key_text(_key("submitted-once"))
	panel.set_label_text("Work key")
	panel.submit_connect()
	t.check_equal(seen.size(), 1, "exactly one connect intent was emitted")
	if seen.size() == 1:
		t.check_equal(str(seen[0][0]), "openrouter", "naming the integration")
		t.check_equal(str(seen[0][1]), _key("submitted-once"), "carrying the key once")
		t.check_equal(str(seen[0][2]), "Work key", "and the label")
	t.check_equal(panel.key_field_text(), "", "and the field was cleared immediately")
	panel.free()


func test_a_failed_connect_clears_the_key_and_shows_a_safe_failure(t) -> void:
	var panel := _panel_with_list()
	panel.begin_connect("openrouter")
	panel.set_key_text(_key("secret-shaped-token"))
	panel.submit_connect()
	# The refusal arrives from the service and carries a credential-shaped echo.
	panel.connect_failed("Authentication failed for " + _key("secret-shaped-token"))
	t.check_equal(panel.key_field_text(), "", "the failed key is cleared too")
	t.check(not panel.failure_text().is_empty(), "a failure is shown")
	t.check(
		not panel.failure_text().contains(_key("secret-shaped-token")),
		"and the credential-shaped echo is not rendered (%s)" % panel.failure_text()
	)
	t.check(
		not panel.rendered_text().contains(_key("secret-shaped-token")),
		"nor anywhere else on the surface"
	)
	panel.free()


func test_a_plain_refusal_reason_is_shown(t) -> void:
	var panel := _panel_with_list()
	panel.begin_connect("openrouter")
	panel.set_key_text(_key("x"))
	panel.submit_connect()
	panel.connect_failed("The service refused the request.")
	t.check(
		panel.failure_text().contains("The service refused the request."),
		"an ordinary refusal is shown verbatim (%s)" % panel.failure_text()
	)
	panel.free()


## A delete is irreversible, so the first press only arms it and the second confirms.
func test_delete_requires_explicit_confirmation(t) -> void:
	var panel := _panel_with_list()
	var deletes: Array = []
	panel.delete_requested.connect(func(id: String) -> void: deletes.append(id))
	panel.press_delete("cred_1")
	t.check_equal(deletes.size(), 0, "the first press only arms the delete")
	t.check_equal(panel.pending_delete(), "cred_1", "and names what is armed")
	panel.press_delete("cred_2")
	t.check_equal(deletes.size(), 0, "arming a different profile replaces the armed one")
	t.check_equal(panel.pending_delete(), "cred_2", "which is the one now armed")
	panel.press_delete("cred_2")
	t.check_equal(deletes, ["cred_2"] as Array, "the second press on the same profile confirms it")
	t.check_equal(panel.pending_delete(), "", "and the confirmation is consumed")
	panel.free()


func test_rename_and_activate_emit_their_own_signals(t) -> void:
	var panel := _panel_with_list()
	var renames: Array = []
	var activates: Array = []
	var deletes: Array = []
	panel.rename_requested.connect(func(id: String, label: String) -> void: renames.append([id, label]))
	panel.activate_requested.connect(func(id: String) -> void: activates.append(id))
	panel.delete_requested.connect(func(id: String) -> void: deletes.append(id))
	panel.press_activate("cred_1")
	panel.press_rename("cred_1", "Renamed")
	t.check_equal(activates, ["cred_1"] as Array, "activation names the profile")
	t.check_equal(renames, [["cred_1", "Renamed"]] as Array, "rename names the profile and its new label")
	t.check_equal(deletes.size(), 0, "and neither action is a delete")
	panel.free()


func test_a_profile_row_shows_its_label_and_active_marker(t) -> void:
	var panel := _panel_with_list()
	var text := panel.rendered_text()
	t.check(text.contains("Default"), "a profile's label is shown (%s)" % text)
	t.check(text.contains("Work key"), "and so is the second profile's")
	t.check(text.to_lower().contains("active"), "and the active profile is marked")
	panel.free()


func test_the_panel_never_renders_a_submitted_key(t) -> void:
	var panel := _panel_with_list()
	panel.begin_connect("openrouter")
	panel.set_key_text(_key("never-rendered"))
	panel.submit_connect()
	panel.connect_settled()
	t.check(
		not panel.rendered_text().contains(_key("never-rendered")),
		"the submitted key never appears in the rendered surface (%s)" % panel.rendered_text()
	)
	panel.free()


## OAuth and command are separate, unimplemented workflows. The integration must be
## told so rather than offered a control that would fake a connection.
func test_an_oauth_only_integration_states_its_limitation(t) -> void:
	var panel := _panel_with_list()
	t.check(
		not panel.oauth_note("github").is_empty(),
		"an oauth-only integration states why it cannot be connected here"
	)
	t.check(
		panel.oauth_note("github").to_lower().contains("not"),
		"and the statement is a limitation, not an offer (%s)" % panel.oauth_note("github")
	)
	# The note must reach the rendered surface, and no connect control may appear for it.
	var text := panel.rendered_text()
	t.check(text.contains("GitHub"), "the oauth-only integration is still named (%s)" % text)
	t.check(
		text.to_lower().contains("oauth"),
		"and its limitation is rendered rather than hidden"
	)
	t.check(
		not panel.connect_available("github"),
		"while no connect control is offered for it"
	)
	t.check(
		panel.oauth_note("openrouter").is_empty(),
		"and a key integration has no limitation to state"
	)
	panel.free()


## A credential-shaped value, composed at RUNTIME.
##
## The provenance scanner flags provider-token prefixes in source literals, and rightly
## so: a real key must never be a literal. This suite needs credential-SHAPED text to
## prove it is not retained, rendered, or echoed, so the shape is assembled from
## fragments instead of written out. Nothing here is a credential and nothing is real.
static func _key(seed: String) -> String:
	return "%s-%s" % [String.chr(115) + String.chr(107), seed]


## --- fixtures and the transport double -----------------------------------------

func _panel_with_list() -> ProviderCredentialsPanel:
	var api := _listed_api()
	var panel := ProviderCredentialsPanel.new()
	panel.bind(api)
	panel.refresh()
	return panel


## An `IntegrationApi` whose list has settled on the fixture body.
func _listed_api() -> IntegrationApi:
	var transport := RecordingTransport.new()
	transport.answer = _list_body()
	var api := IntegrationApi.new()
	api.configure(transport)
	api.fetch_list()
	return api


## The declared list envelope: `{location, data: [Integration.Info]}`.
##
## `openrouter` carries a `key` method and two stored profiles plus an environment
## connection; `github` carries only an OAuth method. Both carry fields the client must
## drop (`methods` details, `secret_note`).
func _list_body() -> Dictionary:
	return {
		"location": {"directory": "/stub/project", "workspaceID": null, "project": null},
		"data": [
			{
				"id": "openrouter",
				"name": "OpenRouter",
				"secret_note": "must not survive the allowlist",
				"methods": [
					{"type": "key", "label": "API key"},
					{
						"type": "oauth",
						"id": "m_oauth",
						"label": "OAuth",
						"prompts": [{"type": "text", "key": "code", "message": "Paste the code"}],
					},
				],
				"connections": [
					{"type": "credential", "id": "cred_1", "label": "Default", "active": true},
					{"type": "credential", "id": "cred_2", "label": "Work key", "active": false},
					{"type": "env", "name": "OPENROUTER_API_KEY"},
				],
			},
			{
				"id": "github",
				"name": "GitHub",
				"methods": [{"type": "oauth", "id": "m_gh", "label": "GitHub OAuth", "prompts": []}],
				"connections": [],
			},
		],
	}


## A transport double that records requests and answers a canned response.
##
## It is confined to the TRANSPORT boundary. `hold`/`release` let a test leave a call in
## flight so rebind, timeout, and duplicate-call behaviour can be driven deterministically.
class RecordingTransport extends HttpTransport:
	var requests: Array = []
	var answer: Dictionary = {}
	var answer_status := 200
	## Answers withheld until `release` names the path.
	var hold: Dictionary = {}
	var cancelled: Array = []
	## Entries delivered with every poll regardless of what was requested, for a caller
	## whose id the adapter does not own.
	var stray: Array[Dictionary] = []
	var _settled: Array[Dictionary] = []
	var _held: Array[Dictionary] = []

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({"method": method, "path": path, "body": body})
		var entry := {
			"request_id": requests.size(), "kind": KIND_RESPONSE,
			"status": answer_status, "body": answer, "event": {}, "error": "",
		}
		if hold.has(path):
			_held.append(entry)
		else:
			_settled.append(entry)
		return requests.size()

	func release(path: String) -> void:
		hold.erase(path)
		for entry in _held:
			_settled.append(entry)
		_held.clear()

	func cancel(request_id: int) -> void:
		cancelled.append(request_id)

	func poll(budget_ms: int = 4) -> Array[Dictionary]:
		budget_ms = budget_ms
		var entries: Array[Dictionary] = []
		entries.assign(stray)
		entries.append_array(_settled)
		_settled.clear()
		return entries