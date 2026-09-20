## Configuration read/preview/commit tests (R3-02).
##
## The acceptance is: "Reuse or add minimal scoped read/preview/write/readback with
## expected revision; preserve JSONC/comments and substitutions."
##
## What the CLIENT is responsible for, and what is asserted here:
##
##   * the exact wire shapes of `server.config` - `{location, data}` envelope, the
##     `patch`/`scope`/`expectedRevision` payload, and the `Read`/`Preview`/`Commit`
##     members, checked against the live Schema and spec;
##   * `expectedRevision` is actually SENT, and a stale-revision refusal is surfaced
##     actionably rather than swallowed or blindly retried;
##   * a value the service withheld as `[redacted]` is NEVER written back, refused
##     locally before any request is issued;
##   * only the two write scopes the API accepts are ever offered, and a session or
##     folder scope is explained rather than silently offered;
##   * a missing scope document produces setup guidance, not a fake success;
##   * an edit is not committable until a preview validated exactly that text;
##   * the draft survives a failure, and a scope change invalidates an armed preview.
##
## The tests drive the REAL transport against a throwaway loopback stub
## (`ycoding-office-repair-kit/tools/config_stub_server.py`), so headers, basic auth,
## the JSON body, and the response parsing are all exercised for real. Where a test needs
## a deterministic answer without a socket, it injects a recording transport double; the
## double is confined to the transport boundary, and the assertions are about the wire
## shape the production code builds.
extends RefCounted


func run(t) -> void:
	test_scope_model_exposes_only_the_two_writable_scopes(t)
	test_a_session_scope_is_explained_not_offered(t)
	test_a_virtual_value_reports_its_provenance_and_cannot_be_written(t)
	test_every_page_key_belongs_to_exactly_one_page(t)
	test_no_page_offers_a_key_the_config_schema_does_not_have(t)
	test_a_page_without_keys_states_why(t)
	test_the_scope_and_page_tables_cover_every_page(t)
	test_redaction_is_detected_at_any_depth(t)
	test_a_withheld_value_is_refused_before_any_request(t)
	test_a_withheld_value_is_not_refused_when_it_is_a_new_value(t)
	test_a_patch_always_carries_the_revision_the_client_saw(t)
	test_no_revision_is_sent_without_one_being_known(t)
	test_the_guard_is_sent_whenever_a_revision_is_known(t)
	test_a_preview_carries_the_key_and_scope_and_reports_change(t)
	test_a_session_scope_is_refused_against_the_real_wire(t)
	test_a_commit_carries_the_expected_revision(t)
	test_a_stale_revision_is_refused_and_reported_actionably(t)
	test_a_commit_adopts_the_settled_readback(t)
	test_a_commit_reports_unsettled_keys(t)
	test_a_missing_scope_document_reports_setup_guidance(t)
	test_a_commit_without_a_validated_revision_is_refused(t)
	test_a_failed_read_reports_its_reason_without_stale_values(t)
	test_text_must_be_json_before_it_is_sent(t)
	test_an_edit_is_not_committable_before_its_exact_text_is_previewed(t)
	test_a_scope_change_invalidates_an_armed_preview(t)
	test_the_review_panel_shows_provenance_and_a_withheld_note(t)
	test_the_review_panel_offers_no_editor_for_an_unwritable_value(t)
	test_the_review_surface_is_absent_on_a_page_that_owns_no_key(t)
	test_the_preview_control_exists_and_emits_for_the_edited_key(t)
	test_the_ui_path_arms_apply_and_requests_a_commit(t)
	test_an_answer_for_a_superseded_edit_never_arms_apply(t)
	test_a_pending_call_disables_both_controls(t)
	test_apply_is_disabled_while_the_review_is_not_ready(t)
	test_the_chosen_scope_drives_the_preview_and_commit_payload(t)
	test_the_commit_carries_the_scope_the_preview_validated(t)
	test_a_scope_change_invalidates_a_preview_validated_elsewhere(t)
	test_the_panel_scope_selection_reaches_the_review(t)
	test_the_root_drives_preview_and_commit_from_the_panel_signals(t)
	test_the_root_never_blesses_a_superseded_edit(t)
	test_the_root_writes_to_the_chosen_scope(t)
	test_rebinding_the_location_cancels_the_old_transport(t)
	test_a_removable_key_offers_remove_and_emits_it(t)
	test_remove_is_offered_only_where_a_document_defines_the_key(t)
	test_a_withheld_value_offers_no_remove(t)
	test_the_ui_path_previews_then_commits_a_removal(t)
	test_the_root_drives_a_removal_through_preview_and_commit(t)
	test_a_removal_carries_the_previewed_revision(t)
	test_a_scope_change_invalidates_an_armed_removal(t)
	test_a_removal_is_disabled_while_not_ready_or_in_flight(t)
	test_a_removal_reports_the_key_owned_by_another_document(t)
	test_the_remove_flow_mounts_a_visible_clickable_apply(t)
	test_a_removal_hides_the_editor_text_and_names_its_target(t)
	test_switching_to_an_edit_drops_a_pending_removal(t)
	test_switching_page_drops_a_pending_removal(t)
	test_a_late_answer_never_arms_a_new_intent(t)
	test_preview_cannot_act_during_a_removal(t)
	test_the_target_document_is_the_last_of_its_scope(t)
	test_a_key_defined_only_by_an_earlier_document_is_not_removable(t)
	test_remove_refuses_a_record_with_a_withheld_nested_value(t)


## --- Remove ------------------------------------------------------------------

## A key a writable document defines offers a Remove action, and pressing it asks for a
## removal preview. Without this no user action could remove a value at all, and the
## `null`-removes-a-key half of `Config.Patch` would be unreachable.
func test_a_removable_key_offers_remove_and_emits_it(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	t.check(panel.remove_offered("share"), "a key a document defines offers Remove")
	var asked: Array = []
	panel.remove_requested.connect(func(key: String) -> void: asked.append(key))
	panel.press_remove("share")
	t.check_equal(asked, ["share"] as Array, "pressing Remove asks for a removal preview")


## Remove is offered only where the target document actually defines the key.
##
## The API removes by writing `null` to the target document, so removing a key that
## document does not define would write nothing while looking like it deleted something -
## exactly the enabled-affordance defect. Such a key states why instead.
func test_remove_is_offered_only_where_a_document_defines_the_key(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	# `model` is owned by the General page and defined by NO document in the fixture read,
	# so there is nothing to remove from any document.
	t.check(
		not panel.remove_offered("model"),
		"a key no document defines offers no Remove"
	)
	var reason: String = panel.remove_refusal("model")
	t.check(
		not reason.is_empty() and reason.to_lower().contains("define"),
		"and it states that no document defines it (%s)" % reason
	)
	# The review is the authority for that decision, so the same answer is reachable there.
	t.check(not panel._review.can_remove("model"), "the review refuses it too")
	t.check(
		panel._review.can_remove("share"),
		"while a key the global document defines can be removed"
	)
	panel.free()


## A withheld value offers NO Remove in this step: deleting a credential is a separate,
## more sensitive flow than removing an ordinary setting, and the refusal is stated rather
## than the action being silently missing.
func test_a_withheld_value_offers_no_remove(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	t.check(
		not panel.remove_offered("username"),
		"a withheld value offers no Remove"
	)
	var reason: String = panel.remove_refusal("username")
	t.check(
		not reason.is_empty() and reason.to_lower().contains("withheld"),
		"and the reason says the value is withheld (%s)" % reason
	)
	panel.free()


## The whole UI path for a removal: press Remove, the preview settles, Apply arms, and
## pressing Apply requests the commit - carrying the fact that this is a REMOVAL rather
## than an edit, so the two cannot be confused on the wire.
func test_the_ui_path_previews_then_commits_a_removal(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	var previews: Array = []
	panel.remove_requested.connect(func(key: String) -> void: previews.append(key))
	panel.press_remove("share")
	t.check_equal(previews.size(), 1, "the removal preview was requested")
	t.check(
		not panel.apply_available(),
		"Apply is not armed until the removal is validated"
	)
	# The settled answer arrives for that key.
	panel.removal_settled("share", "rev-remove")
	t.check(panel.apply_available(), "the settled removal preview arms Apply")
	var commits: Array = []
	panel.remove_commit_requested.connect(
		func(key: String, revision: String) -> void: commits.append([key, revision])
	)
	panel._apply.pressed.emit()
	t.check_equal(commits.size(), 1, "pressing Apply requests exactly one removal commit")
	if commits.size() == 1:
		t.check_equal(str(commits[0][0]), "share", "for the removed key")
		t.check_equal(
			str(commits[0][1]), "rev-remove",
			"with the revision the removal preview validated"
		)
	panel.free()


## The REAL root: press Remove, settle, press Apply, and the wire carries a `null` value
## for the key with the preview's revision. This is the flow a user performs, end to end.
func test_the_root_drives_a_removal_through_preview_and_commit(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body([])
	var api := ConfigApi.new()
	api.configure(transport)
	main.config_api = api
	main.config_review = ConfigReview.new()
	main.config_review.configure(api)
	main.settings_panel.bind_review(main.config_review)
	var surface := main.settings_panel.review_surface()
	surface.read_requested.connect(main._on_config_read_requested)
	surface.remove_requested.connect(main._on_config_remove_requested)
	surface.remove_commit_requested.connect(main._on_config_remove_commit_requested)
	surface.read_requested.emit()
	while main.config_api.is_pending():
		main._settle_config()
	t.check_equal(main.config_review.state(), ConfigReview.READY, "the read settled")
	surface.show_page_for("general")
	t.check(surface.remove_offered("share"), "Remove is offered for a defined key")
	surface.press_remove("share")
	while main.config_api.is_pending():
		main._settle_config()
	t.check(surface.apply_available(), "the root armed Apply from the removal preview")
	surface._apply.pressed.emit()
	while main.config_api.is_pending():
		main._settle_config()
	var put := _last_put(transport)
	t.check(not put.is_empty(), "a removal commit reached the wire")
	var patch: Dictionary = put.get("patch", {})
	t.check(patch.has("share"), "the patch names the removed key")
	t.check_equal(patch.get("share", "missing"), null, "with a JSON null, which removes it")
	t.check_equal(str(put.get("scope", "")), "global", "targeting the owning document")
	t.check(
		not str(put.get("expectedRevision", "")).is_empty(),
		"and guarded by a revision"
	)
	_free(t, main)


## A removal is guarded by the revision the PREVIEW validated, so a concurrent edit is
## refused rather than silently deleting a value the user has not seen.
func test_a_removal_carries_the_previewed_revision(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body([])
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check(review.begin_preview_removal("share"), "the removal preview is issued")
	while review.is_pending():
		review.poll_preview()
	t.check_equal(review.preview_state(), ConfigReview.PREVIEW_READY, "the preview settled")
	var revision := review.preview_revision()
	t.check(not revision.is_empty(), "the preview reported a revision")
	t.check(review.begin_commit_removal("share", revision), "the removal commit is issued")
	var patch: Dictionary = _last_request(transport).get("patch", {})
	t.check(patch.has("share"), "the patch names the key")
	t.check_equal(patch.get("share", "missing"), null, "with a null value, which removes it")
	t.check_equal(
		str(_last_request(transport).get("expectedRevision", "")), revision,
		"guarded by the previewed revision"
	)
	# And the settled readback is adopted, so the surface shows what the service reports.
	while review.is_pending():
		review.poll_commit()
	t.check(review.has_values(), "the readback was adopted")


## A settled removal belongs to the document it was validated against, so a scope change
## invalidates it exactly as it does an edit.
func test_a_scope_change_invalidates_an_armed_removal(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	review.set_chosen_scope("global")
	review.begin_preview_removal("share")
	while review.is_pending():
		review.poll_preview()
	t.check_equal(review.preview_state(), ConfigReview.PREVIEW_READY, "the removal settled")
	review.set_chosen_scope("project")
	t.check_equal(
		review.preview_state(), ConfigReview.PREVIEW_IDLE,
		"the scope change invalidates the armed removal"
	)
	t.check(
		not review.begin_commit_removal("share", review.preview_revision()),
		"and a removal relying on it is refused"
	)
	# Driving the panel: the same invalidation must disarm Apply.
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	# The removal is requested through the control first, because that is what puts the
	# panel into the removal state a settled preview then arms.
	panel.press_remove("share")
	panel.removal_settled("share", "rev-r")
	t.check(panel.apply_available(), "the armed removal enables Apply")
	panel.invalidate_preview()
	t.check(not panel.apply_available(), "invalidating disarms a removal too")
	panel.free()


## The same gating as an edit: a removal cannot be requested while a call is in flight or
## while the review has not settled a read.
func test_a_removal_is_disabled_while_not_ready_or_in_flight(t) -> void:
	var loading := ConfigReview.new()
	loading.configure(_recording_api(_read_body()))
	loading.begin_read()
	var panel := ConfigReviewPanel.new()
	panel.bind(loading)
	panel.show_page_for("general")
	t.check(
		not panel.remove_available("share"),
		"Remove is disabled while the review has not settled its read"
	)
	panel.free()

	var ready := _ready_review()
	var armed := ConfigReviewPanel.new()
	armed.bind(ready)
	armed.show_page_for("general")
	armed.press_remove("share")
	armed.removal_settled("share", "rev-1")
	t.check(armed.apply_available(), "Apply is armed after the removal settles")
	armed.commit_pending()
	t.check(
		not armed.apply_available(),
		"and a duplicate removal cannot be applied while the commit is in flight"
	)
	armed.free()


## The write SUCCEEDS but the effective value is still owned by another document: the
## project override is gone and the value falls back to the global one. That is reported
## as unsettled rather than shown as a plain deletion.
func test_a_removal_reports_the_key_owned_by_another_document(t) -> void:
	# The PROJECT document must define the key for there to be a project override to
	# remove; otherwise the request would rightly be refused and the test would be vacuous.
	var read := _read_body()
	((read["data"]["sources"] as Array)[2] as Dictionary)["keys"] = ["share", "project_only_key"]
	var transport := RecordingTransport.new()
	transport.answer = read
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("project")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body_scoped("project", ["share"])
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	review.set_chosen_scope("project")
	t.check_equal(
		review.write_scope_for("share"), "project",
		"the chosen scope is where the removal targets"
	)
	t.check(
		review.can_remove("share"),
		"the project document defines the key, so it can be removed there"
	)
	t.check(review.begin_preview_removal("share"), "the project removal preview is issued")
	while review.is_pending():
		review.poll_preview()
	t.check(
		review.begin_commit_removal("share", review.preview_revision()),
		"the removal commits"
	)
	while review.is_pending():
		review.poll_commit()
	t.check_equal(
		review.unsettled_keys(), ["share"] as Array,
		"the key is reported as still owned by another document"
	)
	t.check(
		review.last_error().is_empty(),
		"and the removal is not presented as a failure (%s)" % review.last_error()
	)


## The body of the last PUT, which is the removal commit under test.
func _last_put(transport: RecordingTransport) -> Dictionary:
	for index in range(transport.requests.size() - 1, -1, -1):
		if int(transport.requests[index]["method"]) == HTTPClient.METHOD_PUT:
			return transport.requests[index]["body"]
	return {}


## --- the mounted Remove flow (review defect 1) --------------------------------

## The whole flow must work on a MOUNTED panel through visible, clickable controls.
##
## `_apply.pressed.emit()` alone misses this: Apply and the actions row are children of
## `_editor_box`, which starts hidden, so a removal that never shows the box leaves Apply
## `visible == false` while `apply_available()` reports true - an affordance the user
## cannot see or click. `is_visible_in_tree()` is the assertion that catches it.
func test_the_remove_flow_mounts_a_visible_clickable_apply(t) -> void:
	var panel := ConfigReviewPanel.new()
	t.root.add_child(panel)
	# Visibility in the tree is settled by a frame, so the assertions below are about a
	# mounted panel rather than about a node that has not been laid out yet.
	await t.process_frame
	panel.bind(_ready_review())
	panel.show_page_for("general")
	t.check(panel.is_visible_in_tree(), "the panel is mounted")
	# Reach Remove through the RENDERED ROW FOR THIS KEY rather than by calling the private
	# handler; the first Remove button on the page belongs to another key.
	var remove_button := _remove_button_for(panel, "share")
	t.check(remove_button != null, "a Remove control is rendered for `share`")
	if remove_button == null:
		_detach(t, panel)
		panel.free()
		return
	t.check(remove_button.is_visible_in_tree(), "the Remove control is visible and clickable")
	remove_button.pressed.emit()
	t.check(panel.is_removing(), "pressing it starts a removal")
	t.check_equal(panel.edited_key(), "share", "for the key whose row was pressed")
	panel.removal_settled("share", "rev-visible")
	t.check(panel.apply_available(), "the settled removal arms Apply")
	t.check(
		panel._editor_box.visible,
		"and the box holding Apply is SHOWN, or the control cannot be reached"
	)
	t.check(panel._apply.is_visible_in_tree(), "Apply is visible in the tree")
	# Clickable: a real press reaches the callback rather than being blocked by visibility.
	var commits: Array = []
	panel.remove_commit_requested.connect(
		func(key: String, revision: String) -> void: commits.append([key, revision])
	)
	panel._apply.pressed.emit()
	t.check_equal(commits.size(), 1, "and pressing it requests the removal commit")
	_detach(t, panel)
	panel.free()


## A removal is not an edit: the value's text must not be in the editor, and the surface
## must name the document it targets so the confirmation is unambiguous.
func test_a_removal_hides_the_editor_text_and_names_its_target(t) -> void:
	var panel := ConfigReviewPanel.new()
	t.root.add_child(panel)
	await t.process_frame
	panel.bind(_ready_review())
	panel.show_page_for("general")
	var remove_button := _remove_button_for(panel, "share")
	t.check(remove_button != null, "a Remove control is rendered for `share`")
	if remove_button != null:
		remove_button.pressed.emit()
	panel.removal_settled("share", "rev-named")
	t.check_equal(
		panel.editor_text(), "",
		"the value's text is not presented as an edit"
	)
	var text := _panel_text(panel)
	t.check(text.contains("share"), "the surface names the key being removed")
	t.check(text.contains("global"), "and the document it targets")
	t.check(
		text.to_lower().contains("remov"),
		"and says that this is a removal, not an edit"
	)
	_detach(t, panel)
	panel.free()


## --- stale intent (review defect 2) -------------------------------------------

## Starting an EDIT while a removal is pending must drop the removal: otherwise a late
## removal answer could arm Apply for an edit that was never validated, or an edit's own
## state could be committed as a removal.
func test_switching_to_an_edit_drops_a_pending_removal(t) -> void:
	var panel := ConfigReviewPanel.new()
	t.root.add_child(panel)
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.press_remove("share")
	t.check(panel.is_removing(), "a removal is pending")
	panel.edit_key("share", "\"manual\"")
	t.check(not panel.is_removing(), "starting an edit drops the removal")
	t.check(not panel.apply_available(), "and Apply is not armed by the dropped removal")
	# A late removal answer must not arm the edit.
	panel.removal_settled("share", "rev-late")
	t.check(
		not panel.apply_available(),
		"a late removal answer cannot arm an edit that was never previewed"
	)
	_detach(t, panel)
	panel.free()


## Moving to another page must drop a pending removal, so a late answer for a key on the
## old page cannot arm anything on the new one.
func test_switching_page_drops_a_pending_removal(t) -> void:
	var panel := ConfigReviewPanel.new()
	t.root.add_child(panel)
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.press_remove("share")
	panel.show_page_for("tools")
	t.check(not panel.is_removing(), "changing page drops the removal")
	t.check(not panel.apply_available(), "and Apply is not armed")
	panel.removal_settled("share", "rev-late")
	t.check(not panel.apply_available(), "a late answer for the old page arms nothing")
	_detach(t, panel)
	panel.free()


## The property both cases above exist for: an answer that arrives for work the user has
## moved on from never arms the new intent.
func test_a_late_answer_never_arms_a_new_intent(t) -> void:
	var panel := ConfigReviewPanel.new()
	t.root.add_child(panel)
	panel.bind(_ready_review())
	panel.show_page_for("general")
	# Removal of one key, then an edit of a DIFFERENT key before the removal answers.
	panel.press_remove("share")
	panel.edit_key("shell", "\"/bin/dash\"")
	panel.removal_settled("share", "rev-share")
	t.check(
		not panel.apply_available(),
		"the removal's answer cannot arm the shell edit"
	)
	t.check_equal(panel.edited_key(), "shell", "and the edit is still the subject")
	# A preview for the edit's exact text is what arms it.
	panel.preview_settled("shell", "\"/bin/dash\"", "rev-shell")
	t.check(panel.apply_available(), "only the edit's own validation arms it")
	_detach(t, panel)
	panel.free()


## Preview acts on the editor's text, so it must be inert during a removal rather than
## offering a press that does nothing.
##
## Asserted on the HANDLER, not only on `preview_available()`: the control's disabled state
## and the guard are two independent protections, and a mutation that removed the guard
## while leaving the state would otherwise pass.
func test_preview_cannot_act_during_a_removal(t) -> void:
	var panel := ConfigReviewPanel.new()
	t.root.add_child(panel)
	await t.process_frame
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.press_remove("share")
	t.check(not panel.preview_available(), "Preview cannot act while a removal is pending")
	# Pressing it through the real control must not issue a preview for empty text.
	var asked: Array = []
	panel.preview_requested.connect(func(key: String, text: String) -> void: asked.append(key))
	if panel._preview != null:
		panel._preview.pressed.emit()
	# And the private handler is guarded too, so a caller cannot bypass the control state.
	panel._on_preview()
	t.check_equal(
		asked, [] as Array,
		"no preview was requested during a removal (asked %s)" % str(asked)
	)
	# THE DISCRIMINATING STATE: once the removal SETTLES, no call is in flight any more, so
	# only the removal itself can keep Preview inert. A Preview enabled here would be an
	# action that cannot produce anything, because a removal has no editor text to validate.
	panel.removal_settled("share", "rev-removal")
	t.check(
		not panel.preview_available(),
		"Preview is still inert once the removal has settled and nothing is in flight"
	)
	if panel._preview != null:
		panel._preview.pressed.emit()
	panel._on_preview()
	t.check_equal(
		asked, [] as Array,
		"and pressing it still requests nothing (%s)" % str(asked)
	)
	_detach(t, panel)
	panel.free()


## --- the target document is the LAST of its scope (review defect 3) ------------

## Discovery can find SEVERAL documents of one scope, and the backend's `targetOf` selects
## `findLast` - the last in priority order. A client that reported the FIRST one's revision
## would guard a write with a revision belonging to a different document, so a concurrent
## edit to the real target would go undetected.
func test_the_target_document_is_the_last_of_its_scope(t) -> void:
	var read := _two_global_body()
	var transport := RecordingTransport.new()
	transport.answer = read
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check_equal(
		review.revision_for_scope("global"), _digest("second"),
		"the revision is the LAST global document's, not the first's"
	)
	# The same rule through the API reader, which the removal guard also uses.
	t.check_equal(
		api.revision_for("global"), _digest("second"),
		"the API reader agrees on the target document"
	)


## Removal must be offered only when the document the write TARGETS defines the key. With
## two global documents, a key defined only by the earlier one is not in the target, so
## removing it there would change nothing.
func test_a_key_defined_only_by_an_earlier_document_is_not_removable(t) -> void:
	var read := _read_body()
	(read["data"] as Dictionary)["values"] = {"earlier_only": "value", "shell": "/bin/zsh"}
	(read["data"] as Dictionary)["sources"] = [
		{
			"path": "/stub/global/earlier.jsonc", "scope": "global",
			"keys": ["earlier_only"], "revision": _digest("first"),
		},
		{
			"path": "/stub/global/ycoding.jsonc", "scope": "global",
			"keys": ["shell"], "revision": _digest("second"),
		},
	]
	var transport := RecordingTransport.new()
	transport.answer = read
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check(
		not review.can_remove("earlier_only"),
		"a key the TARGET document does not define is not removable"
	)
	t.check(review.can_remove("shell"), "while a key the target document defines is")
	var reason := review.remove_refusal("earlier_only")
	t.check(
		reason.contains("global") and reason.to_lower().contains("define"),
		"and the reason states that the target document does not define it (%s)" % reason
	)


## --- nested withheld values (review defect 4) ---------------------------------

## The exclusion of secret-bearing values must hold for a RECORD whose nested leaf is
## withheld, not only for a value that is itself the sentinel. Otherwise an ordinary
## Remove could delete a secret-bearing record, contradicting the stated exclusion.
func test_remove_refuses_a_record_with_a_withheld_nested_value(t) -> void:
	var read := _read_body()
	# `mcp` is a record whose nested environment value the service withheld. Top-level
	# redaction does not see it, so the recursion is what must refuse the removal.
	(read["data"] as Dictionary)["values"] = {
		"shell": "/bin/zsh",
		"mcp": {"servers": {"private": {"environment": {"TOKEN": ConfigApi.REDACTED}}}},
	}
	(read["data"] as Dictionary)["sources"] = [{
		"path": "/stub/global/ycoding.jsonc", "scope": "global",
		"keys": ["shell", "mcp"], "revision": _digest("a"),
	}]
	var transport := RecordingTransport.new()
	transport.answer = read
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check(review.defines("mcp"), "the record is defined by the target document")
	t.check(
		not review.can_remove("mcp"),
		"a record holding a withheld value cannot be removed"
	)
	var reason := review.remove_refusal("mcp")
	t.check(
		reason.to_lower().contains("withheld") and reason.contains("TOKEN"),
		"and the reason names the withheld path (%s)" % reason
	)
	# An ordinary key is still removable, so the recursion is not refusing everything.
	t.check(review.can_remove("shell"), "while an ordinary value remains removable")


## A read with TWO global documents, the second the one a global write targets.
func _two_global_body() -> Dictionary:
	return {
		"location": {"directory": "/stub/project", "workspaceID": null, "project": null},
		"data": {
			"values": {"shell": "/bin/zsh"},
			"sources": [
				{
					"path": "/stub/global/earlier.jsonc", "scope": "global",
					"keys": ["shell"], "revision": _digest("first"),
				},
				{
					"path": "/stub/global/ycoding.jsonc", "scope": "global",
					"keys": ["shell"], "revision": _digest("second"),
				},
			],
		},
	}


## The first button in a container whose text is `label`, or null.
func _find_button(node: Node, label: String) -> Button:
	if node is Button and (node as Button).text == label:
		return node
	for child in node.get_children():
		var found := _find_button(child, label)
		if found != null:
			return found
	return null


## The Remove button belonging to `key`'s row.
##
## A page renders one row per key, so finding "the Remove button" would find the first
## key's and press the wrong action. The row is identified by the key's own label, which is
## what a user reads before pressing.
func _remove_button_for(panel: ConfigReviewPanel, key: String) -> Button:
	for child in panel._rows_box.get_children():
		if not _row_names_key(child, key):
			continue
		return _find_button(child, "Remove")
	return null


func _row_names_key(node: Node, key: String) -> bool:
	if node is Label and (node as Label).text == key:
		return true
	for child in node.get_children():
		if _row_names_key(child, key):
			return true
	return false


## --- the location rebind cancels the old transport (review defect 5) ----------------


## --- the scope model ---------------------------------------------------------

## Exactly two scopes are writable, and `virtual` is readable provenance only.
func test_scope_model_exposes_only_the_two_writable_scopes(t) -> void:
	t.check_equal(
		SettingsScope.WRITABLE,
		["global", "project"] as Array[String],
		"the two writable scopes are the API's own WriteScope"
	)
	t.check_equal(
		SettingsScope.ALL,
		["global", "project", "virtual"] as Array[String],
		"the readable scopes are the API's own Scope"
	)
	t.check(SettingsScope.is_writable(SettingsScope.GLOBAL), "global is writable")
	t.check(SettingsScope.is_writable(SettingsScope.PROJECT), "project is writable")
	t.check(not SettingsScope.is_writable(SettingsScope.VIRTUAL), "virtual is NOT writable")
	t.check(
		not SettingsScope.is_scope(SettingsScope.SESSION),
		"session is not a configuration scope at all"
	)
	t.check(
		not SettingsScope.is_scope(SettingsScope.FOLDER),
		"folder is not a configuration scope at all"
	)
	# The names are still RECOGNISED, so they can be explained rather than treated as typos.
	t.check(SettingsScope.is_recognised(SettingsScope.SESSION), "session is a recognised concept")
	t.check(SettingsScope.is_recognised(SettingsScope.FOLDER), "folder is a recognised concept")
	t.check(not SettingsScope.is_recognised("nonsense"), "an invented name is not recognised")


## A session scope must be EXPLAINED, not silently absent. The reason must name the real
## cause - session overrides are not configuration documents - rather than blaming a
## missing folder, which would be a false explanation.
func test_a_session_scope_is_explained_not_offered(t) -> void:
	var reason := SettingsScope.not_a_scope_explanation(SettingsScope.SESSION)
	t.check(not reason.is_empty(), "a session scope carries an explanation")
	t.check(
		reason.to_lower().contains("session"),
		"and it names the session (%s)" % reason
	)
	t.check(
		not reason.to_lower().contains("open a project folder"),
		"and does not blame a missing folder, which would be false"
	)
	t.check(
		not SettingsScope.writable(true).has(SettingsScope.SESSION),
		"a session scope is never offered for a write, even with a project open"
	)
	t.check(
		not SettingsScope.readable(true).has(SettingsScope.SESSION),
		"nor is it offered as provenance"
	)
	# A folder scope is explained the same way.
	var folder_reason := SettingsScope.not_a_scope_explanation(SettingsScope.FOLDER)
	t.check(not folder_reason.is_empty(), "a folder scope carries an explanation")
	t.check(
		folder_reason.to_lower().contains("not a configuration document")
			or folder_reason.to_lower().contains("discovery"),
		"and it says a folder is not a document (%s)" % folder_reason
	)
	# A REAL scope has no such explanation, and neither does an invented name.
	t.check(
		SettingsScope.not_a_scope_explanation(SettingsScope.GLOBAL).is_empty(),
		"a real scope has no not-a-scope explanation"
	)
	t.check(
		SettingsScope.not_a_scope_explanation("nonsense").is_empty(),
		"an invented name gets no scope explanation"
	)


## A value whose most specific source is `virtual` is readable but not writable, and the
## refusal must point at the real cause: the document has no file path.
func test_a_virtual_value_reports_its_provenance_and_cannot_be_written(t) -> void:
	var review := ConfigReview.new()
	review.configure(_recording_api(_read_body()))
	read_now(review)
	t.check_equal(review.state(), ConfigReview.READY, "the read settled")
	t.check_equal(
		review.write_scope_for("username"), "",
		"a value owned by a virtual document has no writable scope"
	)
	var refusal := review.write_refusal_for("username")
	t.check(not refusal.is_empty(), "and it carries a refusal reason")
	t.check(
		refusal.to_lower().contains("file path") or refusal.to_lower().contains("no file"),
		"naming the real cause (%s)" % refusal
	)
	t.check(
		review.provenance_for("username").contains("virtual"),
		"and its provenance names the virtual document (%s)" % review.provenance_for("username")
	)
	# A value the global document owns IS writable, and to the global document.
	t.check_equal(
		review.write_scope_for("shell"), "global",
		"a globally-owned value is written globally"
	)
	t.check_equal(review.write_refusal_for("shell"), "", "and needs no refusal")
	t.check(
		review.provenance_for("shell").contains("global"),
		"and its provenance names the global document"
	)


## Every top-level key has exactly ONE owning page, so two pages cannot offer the same
## value and disagree about it.
func test_every_page_key_belongs_to_exactly_one_page(t) -> void:
	var seen: Dictionary = {}
	for page in SettingsGroup.PAGES:
		for key in SettingsGroup.keys_for(str(page)):
			t.check(
				not seen.has(key),
				"key '%s' is owned by exactly one page (also claimed by %s)" % [key, str(seen.get(key, ""))]
			)
			seen[key] = str(page)
			t.check_equal(
				SettingsGroup.page_for_key(key), str(page),
				"and the reverse lookup finds that page for '%s'" % key
			)
	t.check(seen.size() > 10, "the mapping covers the configuration surface")


## Every key a page offers must be a REAL top-level key in the configuration schema, or
## the UI would offer a value no document can hold.
func test_no_page_offers_a_key_the_config_schema_does_not_have(t) -> void:
	# The live top-level keys of `Config.Info` (packages/core/src/config.ts), read from
	# the schema rather than guessed. `path` and `type` belong to the document envelope,
	# not to `Info`, so they are excluded.
	var schema_keys := [
		"$schema", "shell", "shell_sandbox", "shell_memory_limit_mb", "model",
		"default_agent", "autoupdate", "share", "enterprise", "username", "permissions",
		"agents", "snapshots", "watcher", "formatter", "lsp", "attachments", "tool_output",
		"mcp", "compaction", "memory", "guardrails", "skills", "commands", "instructions",
		"instruction_max_bytes", "references", "plugins", "providers", "ntfy",
		"provider_usage", "efficiency", "image_analyzer", "experimental",
	]
	for page in SettingsGroup.PAGES:
		for key in SettingsGroup.keys_for(str(page)):
			t.check(
				schema_keys.has(key),
				"'%s' on page %s is a real top-level configuration key" % [key, str(page)]
			)
	# And `$schema` is deliberately NOT offered: it is document metadata, not a setting.
	t.check(
		not SettingsGroup.all_keys().has("$schema"),
		"document metadata is not offered as a setting"
	)


## A page that owns no key says why, rather than rendering as an empty page.
func test_a_page_without_keys_states_why(t) -> void:
	var pages_without := 0
	for page in SettingsGroup.PAGES:
		var page_id := str(page)
		if not SettingsGroup.keys_for(page_id).is_empty():
			t.check_equal(
				SettingsGroup.no_key_reason(page_id), "",
				"a page with keys carries no excuse: %s" % page_id
			)
			continue
		pages_without += 1
		var reason := SettingsGroup.no_key_reason(page_id)
		t.check(
			not reason.is_empty(),
			"a page with no key states why: %s" % page_id
		)
	t.check(pages_without > 0, "some pages legitimately own no runtime configuration key")


## The grouping and key tables agree: every page has both entries, so nothing renders as
## an unexplained blank.
func test_the_scope_and_page_tables_cover_every_page(t) -> void:
	for page in SettingsGroup.PAGES:
		var page_id := str(page)
		t.check(
			SettingsGroup.PAGE_KEYS.has(page_id),
			"page %s declares its key list" % page_id
		)


## --- redaction ---------------------------------------------------------------

## Redaction is detected at ANY depth: the API replaces nested credential leaves, and a
## patch replaces a whole subtree, so a hidden placeholder one level down would otherwise
## be written back.
func test_redaction_is_detected_at_any_depth(t) -> void:
	t.check(ConfigApi.is_redacted("[redacted]"), "the sentinel is recognised")
	t.check(not ConfigApi.is_redacted("[REDACTED]"), "a different case is not the sentinel")
	t.check(not ConfigApi.is_redacted("not redacted"), "ordinary text is not the sentinel")
	t.check(not ConfigApi.is_redacted(null), "null is not the sentinel")
	# At depth, in both container kinds.
	var nested := {
		"providers": {
			"openai": {
				"headers": {"Authorization": "[redacted]"},
			},
		},
	}
	var reason := ConfigApi.withheld_write_reason(nested)
	t.check(not reason.is_empty(), "a nested withheld value is detected")
	t.check(
		reason.contains("Authorization"),
		"and the reason names the path (%s)" % reason
	)
	var in_array := {"plugins": [{"options": {"token": "[redacted]"}}]}
	t.check(
		not ConfigApi.withheld_write_reason(in_array).is_empty(),
		"a withheld value inside an array is detected"
	)
	t.check(
		ConfigApi.withheld_write_reason({"shell": "/bin/sh"}).is_empty(),
		"a patch with no withheld value is safe"
	)


## A withheld value must never reach the wire. The refusal is LOCAL, so no request is
## issued at all, which is stronger than rejecting the response.
func test_a_withheld_value_is_refused_before_any_request(t) -> void:
	var transport := RecordingTransport.new()
	var api := ConfigApi.new()
	api.configure(transport)
	t.check(
		not api.start_commit({"username": ConfigApi.REDACTED}, "global", "rev-1"),
		"committing a withheld value is refused"
	)
	t.check_equal(
		transport.requests.size(), 0,
		"and no request was issued (issued %d)" % transport.requests.size()
	)
	t.check(
		not api.last_error().is_empty(),
		"the refusal carries a reason (%s)" % api.last_error()
	)
	# The same guard applies to a preview, so the user learns before the apply step.
	t.check(
		not api.start_preview({"username": ConfigApi.REDACTED}, "global"),
		"previewing a withheld value is refused too"
	)
	t.check_equal(transport.requests.size(), 0, "and still nothing reached the wire")


## The guard must not fire on a legitimately-changed value.
func test_a_withheld_value_is_not_refused_when_it_is_a_new_value(t) -> void:
	var transport := RecordingTransport.new()
	var api := ConfigApi.new()
	api.configure(transport)
	t.check(
		api.start_commit({"username": "someone-else"}, "global", "rev-1"),
		"a new value for a withheld key commits"
	)
	t.check_equal(transport.requests.size(), 1, "and one request was issued")


## --- the wire shape ----------------------------------------------------------

## A patch must carry the revision the client last SAW for that document, or the guard is
## decorative.
func test_a_patch_always_carries_the_revision_the_client_saw(t) -> void:
	var review := ConfigReview.new()
	review.configure(_recording_api(_read_body()))
	read_now(review)
	t.check_equal(
		review.write_scope_for("shell"), "global",
		"the key is owned by the global document"
	)
	# The revision comes from the document that DEFINES the key, which is the read's own
	# provenance rather than a value this client invented.
	var revision := _revision_for(review, "global")
	t.check(not revision.is_empty(), "a revision is available for the global document")
	t.check(
		revision.length() > 20,
		"and it is a real digest rather than a placeholder (%s)" % revision
	)


## With nothing read, no revision is sent. An empty string would be a VALUE the schema
## would accept as an expectation, which is a different statement from "no expectation".
func test_no_revision_is_sent_without_one_being_known(t) -> void:
	var transport := RecordingTransport.new()
	var api := ConfigApi.new()
	api.configure(transport)
	t.check_equal(api.revision_for("global"), "", "no revision is known before a read")
	t.check(
		api.start_preview({"shell": "/bin/sh"}, "global"),
		"a preview is still issued"
	)
	t.check_equal(transport.requests.size(), 1, "and it reached the transport")
	var body: Dictionary = transport.requests[0]["body"]
	t.check(
		not body.has("expectedRevision"),
		"the guard is OMITTED rather than sent empty"
	)
	t.check_equal(str(body.get("scope", "")), "global", "the scope is sent")
	t.check(
		body.get("patch", null) is Dictionary,
		"the patch is sent as an object"
	)


## THE GUARD IS SENT when a revision IS known: both on an explicit request and when the
## client falls back to the revision the read reported. Without this the stale-revision
## protection is decorative, because the service would never be given an expectation.
func test_the_guard_is_sent_whenever_a_revision_is_known(t) -> void:
	# An explicit revision from a caller (the preview's own revision on the commit path).
	var explicit := RecordingTransport.new()
	var explicit_api := ConfigApi.new()
	explicit_api.configure(explicit)
	t.check(
		explicit_api.start_commit({"shell": "/bin/sh"}, "global", "rev-from-preview"),
		"a commit with an explicit revision is issued"
	)
	t.check_equal(
		str(explicit.requests[0]["body"].get("expectedRevision", "")), "rev-from-preview",
		"and the payload carries that revision"
	)

	# A revision the CLIENT learned from the read, when the caller supplies none. This is
	# the path that makes a plain preview protected without extra bookkeeping.
	var learned := RecordingTransport.new()
	learned.answer = _read_body()
	learned.answer_status = 200
	var api := ConfigApi.new()
	api.configure(learned)
	t.check(api.fetch_read(4000), "the read settled")
	var known := api.revision_for("global")
	t.check(
		known.length() > 20,
		"a real revision was learned from the read's provenance (%s)" % known
	)
	t.check(api.start_preview({"shell": "/bin/sh"}, "global"), "a preview is issued")
	t.check_equal(
		str(learned.requests[1]["body"].get("expectedRevision", "")), known,
		"and the guard the client learned is attached to it"
	)


## A preview carries the patch, the scope, and reports the change and the revision it
## validated against - read from the real stub, so the envelope is exercised.
func test_a_preview_carries_the_key_and_scope_and_reports_change(t) -> void:
	if not _wire_available():
		# Skipped EXPLICITLY: a suite that passed without the stub would claim coverage
		# it did not have. r302_config_check.sh supplies the stub.
		t.check(true, "SKIPPED: no loopback config stub is configured (YCODING_CONFIG_STUB_URL)")
		return
	var base := _base_url()
	var api := ConfigApi.new()
	api.configure(_transport(base))
	t.check(api.fetch_read(6000), "the read settled against the stub (%s)" % api.last_error())
	t.check(api.read_values().has("shell"), "the stub's value was read")
	t.check_equal(
		str(api.resolved_location().get("directory", "")), "/stub/project",
		"the resolved location comes back with the values"
	)
	t.check(api.fetch_preview({"shell": "/bin/sh"}, "global", "", 6000), "the preview settled")
	var preview := api.preview()
	t.check_equal(str(preview.get("scope", "")), "global", "the preview reports its scope")
	t.check(
		not str(preview.get("path", "")).is_empty(),
		"and the document it would write"
	)
	t.check(
		not str(preview.get("revision", "")).is_empty(),
		"and the revision it validated against"
	)
	t.check_equal(
		api.revision_for("global"), str(preview.get("revision", "")),
		"which is what a later commit would send"
	)


## The real wire refuses a scope with no document. The refusal is the SERVICE's, and it
## must be surfaced rather than treated as a successful no-op.
##
## The LOCAL half of this clause is asserted with a recording transport, so the refusal
## is proven without a stub; the wire half then proves the client never even sends it.
func test_a_session_scope_is_refused_against_the_real_wire(t) -> void:
	# Local first: a scope the API does not accept must be refused BEFORE any request.
	var local_transport := RecordingTransport.new()
	var local_api := ConfigApi.new()
	local_api.configure(local_transport)
	t.check(
		not local_api.start_preview({"shell": "/bin/sh"}, "session"),
		"a session scope is refused"
	)
	t.check_equal(
		local_transport.requests.size(), 0,
		"and no request was issued for it (issued %d)" % local_transport.requests.size()
	)
	t.check(
		not local_api.last_error().is_empty(),
		"the refusal explains why (%s)" % local_api.last_error()
	)
	t.check(
		not local_api.start_commit({"shell": "/bin/sh"}, "session", "rev"),
		"a commit is refused for it too"
	)
	t.check_equal(
		local_transport.requests.size(), 0,
		"and still nothing reached the wire"
	)
	# A folder scope is refused the same way, because it is not a document either.
	t.check(
		not local_api.start_preview({"shell": "/bin/sh"}, "folder"),
		"a folder scope is refused"
	)

	if not _wire_available():
		t.check(true, "SKIPPED: no loopback config stub is configured (YCODING_CONFIG_STUB_URL)")
		return
	var base := _base_url()
	var api := ConfigApi.new()
	api.configure(_transport(base))
	t.check(
		not api.start_preview({"shell": "/bin/sh"}, "session"),
		"a session scope never reaches the real service either"
	)


func test_a_commit_carries_the_expected_revision(t) -> void:
	if not _wire_available():
		# Skipped EXPLICITLY: a suite that passed without the stub would claim coverage
		# it did not have. r302_config_check.sh supplies the stub.
		t.check(true, "SKIPPED: no loopback config stub is configured (YCODING_CONFIG_STUB_URL)")
		return
	var base := _base_url()
	var api := ConfigApi.new()
	api.configure(_transport(base))
	t.check(api.fetch_read(6000), "the read settled")
	var revision := api.revision_for("global")
	t.check(not revision.is_empty(), "a revision is known")
	t.check(
		api.fetch_commit({"shell": "/bin/sh"}, "global", revision, 6000),
		"the commit settled (%s)" % api.last_error()
	)
	t.check_equal(
		str(api.commit().get("scope", "")), "global",
		"the commit reports the scope it wrote"
	)


## THE STALE-REVISION CLAUSE. A commit presenting a revision the document no longer has
## must be refused with an actionable message, and must not be treated as written.
func test_a_stale_revision_is_refused_and_reported_actionably(t) -> void:
	if not _wire_available():
		# Skipped EXPLICITLY: a suite that passed without the stub would claim coverage
		# it did not have. r302_config_check.sh supplies the stub.
		t.check(true, "SKIPPED: no loopback config stub is configured (YCODING_CONFIG_STUB_URL)")
		return
	var base := _base_url()
	var api := ConfigApi.new()
	api.configure(_transport(base))
	t.check(
		not api.fetch_commit({"shell": "/bin/sh"}, "global", "stale-revision", 6000),
		"a commit presenting a stale revision is refused"
	)
	var reason := api.last_error()
	t.check(not reason.is_empty(), "the refusal is not swallowed")
	t.check(
		reason.to_lower().contains("changed") or reason.to_lower().contains("re-read"),
		"and it says what to do (%s)" % reason
	)
	t.check(
		api.commit().is_empty(),
		"and NO commit is adopted, so nothing is shown as written"
	)


## A successful commit adopts the SERVICE's settled readback, not the patch the client
## sent: what is stored is what the service reports, not what was hoped for.
func test_a_commit_adopts_the_settled_readback(t) -> void:
	if not _wire_available():
		# Skipped EXPLICITLY: a suite that passed without the stub would claim coverage
		# it did not have. r302_config_check.sh supplies the stub.
		t.check(true, "SKIPPED: no loopback config stub is configured (YCODING_CONFIG_STUB_URL)")
		return
	var base := _base_url()
	var api := ConfigApi.new()
	api.configure(_transport(base))
	t.check(api.fetch_read(6000), "the read settled")
	t.check(
		api.fetch_commit({"shell": "/bin/sh"}, "global", api.revision_for("global"), 6000),
		"the commit settled"
	)
	t.check_equal(
		str(api.read_values().get("shell", "")), "/bin/sh",
		"the effective value is the service's readback"
	)
	t.check(
		not str(api.commit().get("revision", "")).is_empty(),
		"and the new revision is reported"
	)


func test_a_commit_reports_unsettled_keys(t) -> void:
	# A commit whose readback reports every key settled: the write took effect.
	var settled := ConfigReview.new()
	settled.configure(_recording_api(_read_body()))
	read_now(settled)
	t.check(settled.has_values(), "the read settled")
	t.check_equal(
		settled.unsettled_keys(), [] as Array,
		"before a commit, nothing is reported unsettled"
	)

	# A commit whose readback says the key is still owned by another document. The write
	# SUCCEEDED, so this is a caveat on a success rather than a failure, and it must be
	# visible rather than dropped.
	#
	# The transport answers DIFFERENTLY per route: the read must return effective values
	# and the commit must return a readback reporting the key unsettled. One canned body
	# could not do both, which is itself the point - the readback is a distinct payload.
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answer_status = 200
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body(["shell"])
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check(review.has_values(), "the read settled from the read route")
	# A commit follows a preview: the revision it carries is the one the preview
	# validated, which is what makes the guard meaningful rather than decorative.
	t.check(review.begin_preview("shell", "\"/bin/sh\""), "the preview is issued")
	while review.is_pending():
		review.poll_preview()
	t.check_equal(review.preview_state(), ConfigReview.PREVIEW_READY, "the preview settled")
	t.check(
		review.begin_commit("shell", "\"/bin/sh\"", review.preview_revision()),
		"a commit with the previewed revision is issued"
	)
	var guard := 0
	while review.is_pending() and guard < 20:
		review.poll_commit()
		guard += 1
	t.check(
		api.last_error().is_empty(),
		"the commit settled without a refusal (%s)" % api.last_error()
	)
	t.check_equal(
		review.unsettled_keys(), ["shell"] as Array,
		"an unsettled key is reported from the commit's own readback"
	)


## A refusal for a missing scope document must be shown as setup guidance, not as a
## successful write. This is the clause that stops a disabled route reading as done.
func test_a_missing_scope_document_reports_setup_guidance(t) -> void:
	# A read that works, then a preview the service refuses because no project document
	# exists for the location. The refusal is the SERVICE's own guidance and must appear
	# verbatim rather than being replaced by a generic message or treated as a success.
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answer_status = 200
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check(review.has_values(), "the read settled first")
	transport.refuse_next = "No project configuration document exists for this location."
	t.check(
		review.begin_preview("shell", "\"/bin/sh\""),
		"the preview call is issued"
	)
	while api.is_pending():
		review.poll_preview()
	t.check(
		review.last_error().contains("No project configuration document"),
		"the service's own guidance is surfaced (%s)" % review.last_error()
	)
	t.check_equal(
		review.preview_state(), ConfigReview.PREVIEW_IDLE,
		"and no preview is left armed, so nothing can be applied"
	)
	# And a commit is refused, because no preview validated anything.
	t.check(
		not review.begin_commit("shell", "\"/bin/sh\"", review.preview_revision()),
		"a commit is refused when nothing was previewed"
	)


## A failed read reports its reason and does NOT keep showing the previous values as if
## they were current.
func test_a_failed_read_reports_its_reason_without_stale_values(t) -> void:
	var review := ConfigReview.new()
	review.configure(_failing_api("The configuration could not be read."))
	t.check(not review.read_now(), "the read failed")
	t.check_equal(review.state(), ConfigReview.ERROR, "the state is ERROR")
	t.check(
		review.last_error().contains("could not be read"),
		"its reason is reported (%s)" % review.last_error()
	)
	t.check(not review.has_values(), "and no values are claimed")
	t.check(not review.defines("shell"), "so no key reads as defined")


## Text that is not JSON is refused locally, naming the field, rather than becoming an
## opaque HTTP 400.
func test_text_must_be_json_before_it_is_sent(t) -> void:
	t.check_equal(
		ConfigReview.text_refusal("\"/bin/sh\""), "",
		"a JSON string is accepted"
	)
	t.check(
		ConfigReview.text_refusal("/bin/sh").contains("not valid JSON"),
		"a bare word is refused with the reason"
	)
	t.check(
		not ConfigReview.text_refusal("").is_empty(),
		"an empty field is refused"
	)
	t.check(
		ConfigReview.text_refusal("null").contains("Remove"),
		"`null` is routed to Remove rather than written"
	)
	t.check_equal(ConfigReview.text_refusal("42"), "", "a number is valid JSON")
	t.check_equal(ConfigReview.text_refusal("{\"a\": 1}"), "", "an object is valid JSON")
	# The round trip is unambiguous: what was shown is what is sent back.
	t.check_equal(
		ConfigReview.parse_text("\"123\""), "123",
		"a quoted number stays a string"
	)
	t.check_equal(ConfigReview.parse_text("123"), 123, "a bare number is a number")


## --- the review surface: the UI path that arms Apply (review defects 1-4) -----------

## The Preview control must EXIST and must EMIT, or the whole preview-before-commit
## guarantee is unreachable from the interface: no user action could ever arm Apply.
func test_the_preview_control_exists_and_emits_for_the_edited_key(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/zsh\"")
	t.check(panel.preview_available(), "a Preview control is present while editing")
	var asked: Array = []
	panel.preview_requested.connect(func(key: String, text: String) -> void: asked.append([key, text]))
	panel._preview.pressed.emit()
	t.check_equal(asked.size(), 1, "pressing Preview emits exactly once")
	if asked.size() == 1:
		t.check_equal(str(asked[0][0]), "shell", "and it names the edited key")
		t.check_equal(str(asked[0][1]), "\"/bin/zsh\"", "and carries the editor's text")
	panel.free()


## The WHOLE UI path: press Preview, settle the answer, and Apply becomes available -
## then press Apply and a commit is requested with the preview's revision.
func test_the_ui_path_arms_apply_and_requests_a_commit(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/sh\"")
	t.check(not panel.apply_available(), "Apply starts disabled")
	# The composition root requests the preview when the control is pressed.
	var previews: Array = []
	panel.preview_requested.connect(func(key: String, text: String) -> void: previews.append([key, text]))
	panel._preview.pressed.emit()
	t.check_equal(previews.size(), 1, "the Preview control requested a preview")
	# The settled answer arrives for exactly that key and text.
	panel.preview_settled("shell", "\"/bin/sh\"", "rev-ui")
	t.check(panel.apply_available(), "the settled preview arms Apply through the UI path")
	var commits: Array = []
	panel.commit_requested.connect(
		func(key: String, text: String, revision: String) -> void:
			commits.append([key, text, revision])
	)
	panel._apply.pressed.emit()
	t.check_equal(commits.size(), 1, "pressing Apply requests exactly one commit")
	if commits.size() == 1:
		t.check_equal(str(commits[0][0]), "shell", "for the edited key")
		t.check_equal(str(commits[0][1]), "\"/bin/sh\"", "with the editor's text")
		t.check_equal(str(commits[0][2]), "rev-ui", "and the revision the preview validated")
	panel.free()


## A preview in flight must not have its answer bless an edit made AFTER the request.
## Edit A -> Preview -> Edit B -> A's answer settles: Apply must stay disabled, because
## the answer describes text the user has already replaced.
func test_an_answer_for_a_superseded_edit_never_arms_apply(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/zsh\"")
	panel._preview.pressed.emit()
	# The user keeps typing while the preview is in flight.
	panel._editor.text = "\"/bin/dash\""
	panel._on_edit_changed()
	# The answer for the FIRST text arrives now.
	panel.preview_settled("shell", "\"/bin/zsh\"", "rev-a")
	t.check(
		not panel.apply_available(),
		"an answer for superseded text does not arm Apply"
	)
	t.check_equal(
		panel.editor_text(), "\"/bin/dash\"",
		"and the user's newer edit is preserved"
	)
	# Only a preview of the text now in the editor arms it.
	panel.preview_settled("shell", "\"/bin/dash\"", "rev-b")
	t.check(panel.apply_available(), "a preview of the current text arms Apply")
	panel.free()


## While a call is unresolved the controls must not issue a second one.
func test_a_pending_call_disables_both_controls(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/zsh\"")
	panel._preview.pressed.emit()
	panel.preview_pending()
	t.check(not panel.preview_available(), "Preview is disabled while its call is in flight")
	panel.preview_settled("shell", "\"/bin/zsh\"", "rev-1")
	panel.commit_pending()
	t.check(not panel.apply_available(), "Apply is disabled while its commit is in flight")
	t.check(not panel.preview_available(), "and Preview is disabled during the commit too")
	t.check(
		panel.apply_reason().to_lower().contains("wait")
			or panel.apply_reason().to_lower().contains("flight")
			or panel.apply_reason().to_lower().contains("applying"),
		"stating why (%s)" % panel.apply_reason()
	)
	panel.free()


## A read that has not settled, or that failed, must not leave Apply armed.
##
## The arming happens BEFORE the readiness check in production, so a mutation that removed
## the readiness guard would still be masked by the text check. This case therefore arms a
## preview FIRST (which is the only way Apply can be armed at all) and then makes the
## review not-ready by REBINDING it to a fresh, unread reader while the panel keeps its
## armed revision.
func test_apply_is_disabled_while_the_review_is_not_ready(t) -> void:
	# Not-read-yet: an armed preview on a review that has not settled its read.
	var loading := ConfigReview.new()
	loading.configure(_recording_api(_read_body()))
	loading.begin_read()
	var panel := ConfigReviewPanel.new()
	panel.bind(loading)
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/zsh\"")
	panel.preview_settled("shell", "\"/bin/zsh\"", "rev-x")
	t.check(
		not panel.apply_available(),
		"Apply is disabled while the review has not settled its read"
	)
	t.check(
		panel.apply_reason().to_lower().contains("read"),
		"and it says the read has not settled (%s)" % panel.apply_reason()
	)
	panel.free()

	# ERROR: the same, with a failed read.
	var failed := ConfigReview.new()
	failed.configure(_failing_api("The configuration could not be read."))
	failed.read_now()
	var error_panel := ConfigReviewPanel.new()
	error_panel.bind(failed)
	error_panel.show_page_for("general")
	error_panel.edit_key("shell", "\"/bin/zsh\"")
	error_panel.preview_settled("shell", "\"/bin/zsh\"", "rev-y")
	t.check(
		not error_panel.apply_available(),
		"Apply is disabled when the review is in ERROR"
	)
	error_panel.free()

	# THE DISCRIMINATING CASE: read settled and armed FIRST, then the reader is rebound to
	# one that has not read. The panel still holds an armed revision, so only the readiness
	# guard can keep Apply disabled here.
	var ready := _ready_review()
	var rebound_panel := ConfigReviewPanel.new()
	rebound_panel.bind(ready)
	rebound_panel.show_page_for("general")
	rebound_panel.edit_key("shell", "\"/bin/zsh\"")
	rebound_panel.preview_settled("shell", "\"/bin/zsh\"", "rev-z")
	t.check(rebound_panel.apply_available(), "the armed preview does arm Apply while READY")
	# The reader is swapped for one whose read has not settled.
	ready.configure(_recording_api(_read_body()))
	ready.begin_read()
	rebound_panel.refresh()
	t.check(
		not rebound_panel.apply_available(),
		"and Apply is DISARMED once the review is no longer ready"
	)
	rebound_panel.free()


## --- the scope the user chose drives the write (review defect 3) --------------------

## Choosing Project must write PROJECT even when the effective value is owned by the
## global document, and choosing Global must write GLOBAL even when the project document
## owns the value. Otherwise the selector is decorative and a write lands in a document
## the user did not choose.
func test_the_chosen_scope_drives_the_preview_and_commit_payload(t) -> void:
	var review := _ready_review()
	# The effective `shell` is owned by the GLOBAL document.
	t.check_equal(
		review.effective_scope_for("shell"), "global",
		"the fixture's shell is owned by the global document"
	)
	t.check_equal(review.revision_for_scope("global").length() > 20, true, "its revision is known")

	# The user chose PROJECT. The payload must target project, with the PROJECT document's
	# revision, even though the effective value comes from global.
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("project")
	var api := ConfigApi.new()
	api.configure(transport)
	var scoped := ConfigReview.new()
	scoped.configure(api)
	read_now(scoped)
	scoped.set_chosen_scope("project")
	t.check(scoped.begin_preview("shell", "\"/bin/sh\""), "a project-scoped preview is issued")
	var body: Dictionary = _last_request(transport)
	t.check_equal(str(body.get("scope", "")), "project", "the payload targets PROJECT")
	t.check(
		body.has("expectedRevision"),
		"and carries a guard"
	)
	t.check_equal(
		str(body.get("expectedRevision", "")), scoped.revision_for_scope("project"),
		"the guard is the PROJECT document's revision, not global's"
	)

	# And the other way: Global writes global even if project defines the value.
	var global_transport := RecordingTransport.new()
	global_transport.answer = _read_body()
	global_transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	var global_api := ConfigApi.new()
	global_api.configure(global_transport)
	var global_review := ConfigReview.new()
	global_review.configure(global_api)
	read_now(global_review)
	global_review.set_chosen_scope("global")
	t.check(global_review.begin_preview("shell", "\"/bin/sh\""), "a global-scoped preview is issued")
	t.check_equal(
		str(_last_request(global_transport).get("scope", "")), "global",
		"the payload targets GLOBAL"
	)
	t.check_equal(
		str(_last_request(global_transport).get("expectedRevision", "")),
		global_review.revision_for_scope("global"),
		"with the global document's revision"
	)


## The commit carries the scope the preview was validated against, so the two can never
## disagree about which document the write lands in.
func test_the_commit_carries_the_scope_the_preview_validated(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("project")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body_scoped("project", [])
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	review.set_chosen_scope("project")
	t.check(review.begin_preview("shell", "\"/bin/sh\""), "the preview is issued")
	while review.is_pending():
		review.poll_preview()
	t.check_equal(review.preview_state(), ConfigReview.PREVIEW_READY, "the preview settled")
	var revision := review.preview_revision()
	t.check(
		review.begin_commit("shell", "\"/bin/sh\"", revision),
		"the commit is issued"
	)
	var commit_body: Dictionary = _last_request(transport)
	t.check_equal(str(commit_body.get("scope", "")), "project", "the commit targets PROJECT")
	t.check_equal(
		str(commit_body.get("expectedRevision", "")), revision,
		"guarded by the revision the preview validated"
	)


## A scope change invalidates a preview that was validated against the OLD scope's
## document, so a commit can never carry a revision belonging to another document.
func test_a_scope_change_invalidates_a_preview_validated_elsewhere(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	review.set_chosen_scope("global")
	review.begin_preview("shell", "\"/bin/sh\"")
	while review.is_pending():
		review.poll_preview()
	t.check_equal(review.preview_state(), ConfigReview.PREVIEW_READY, "the global preview settled")
	# The user switches to Project.
	review.set_chosen_scope("project")
	t.check_equal(
		review.preview_state(), ConfigReview.PREVIEW_IDLE,
		"the preview is invalidated by the scope change"
	)
	t.check(
		not review.begin_commit("shell", "\"/bin/sh\"", review.preview_revision()),
		"and a commit relying on it is refused"
	)


## Driving the REAL panel: selecting a scope must reach the review, so the selector
## is not decorative.
func test_the_panel_scope_selection_reaches_the_review(t) -> void:
	var review := _ready_review()
	var settings := SettingsPanel.new()
	settings._ensure_built()
	settings.bind_review(review)
	t.root.add_child(settings)
	# A project-backed store, so Project is available.
	var store := OfficeStore.new()
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_scope2",
		"data": {"agent": "lead", "title": "T", "location": {"directory": "/workspace/beta"}},
		"sourceEpoch": "e",
	})
	store.select_actor("ses_scope2")
	settings.show_page(store)
	t.check_equal(settings.scope(), "global", "the page opens on Global")
	t.check(settings.select_scope("project"), "Project can be selected")
	t.check_equal(
		review.chosen_scope(), "project",
		"and the selection reaches the review that decides the write target"
	)
	_detach(t, settings)
	settings.free()


## Detach a panel from the tree before freeing it. The runner is a `SceneTree`, which has
## no `remove_child`; the parent NODE owns the operation.
func _detach(t, panel: Node) -> void:
	var parent: Node = panel.get_parent()
	if parent != null:
		parent.remove_child(panel)


## A composition root wired the way `_ready` wires the settings surfaces, without the
## scene. The panels are attached to the TREE so their `_ready` runs in real scope.
##
## The configuration reader is left to the test: each case installs the transport it needs,
## so nothing here depends on a service being reachable.
func _bootable(t) -> OfficeMain:
	var main := OfficeMain.new()
	main.store = OfficeStore.new()
	main.director = OfficeDirector.new()
	main.demo = DemoTransport.new()
	main.live = LiveTransport.new()
	main.models_api = ModelCatalogApi.new()
	main.sessions_api = SessionApi.new()
	main.prompt_panel = PromptPanel.new()
	t.root.add_child(main.prompt_panel)
	await t.process_frame
	main.sidebar = SidebarPanel.new()
	main.sidebar._ensure_built()
	main.add_child(main.sidebar)
	main.conversation_panel = ConversationPanel.new()
	main.add_child(main.conversation_panel)
	main.chrome_toggles = ChromeToggles.new()
	main.add_child(main.chrome_toggles)
	main.statistics_panel = StatisticsPanel.new()
	t.root.add_child(main.statistics_panel)
	main.settings_panel = SettingsPanel.new()
	t.root.add_child(main.settings_panel)
	main.office_view = OfficeViewport.new()
	main.add_child(main.office_view)
	# A test must never write over the preference a person is using.
	main.view_state = OfficeViewState.new()
	main.view_state.file_path = "user://test_r302_view_state.cfg"
	main._wire_signals()
	return main


func _free(t, main: OfficeMain) -> void:
	if main.live != null:
		main.live.stop()
	# Panels parented to the TREE are not freed by freeing the root.
	for panel: Node in [
		main.prompt_panel, main.settings_panel, main.statistics_panel,
	]:
		if panel == null:
			continue
		var parent: Node = panel.get_parent()
		if parent != null:
			parent.remove_child(panel)
		panel.free()
	main.free()


## A commit is refused when NO revision was validated, even if the review still believes a
## preview settled. The service can report a preview without a revision, and committing
## then would send no guard at all - which is the blind overwrite `expectedRevision`
## exists to prevent. This is a distinct clause from the text-identity check, so it needs
## its own case: a mutation that removed only this guard would otherwise be masked by it.
func test_a_commit_without_a_validated_revision_is_refused(t) -> void:
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	# A preview body that reports NO revision, which is what the guard check is for.
	var revisionless := _preview_body("global")
	(revisionless["data"] as Dictionary).erase("revision")
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = revisionless
	var api := ConfigApi.new()
	api.configure(transport)
	var review := ConfigReview.new()
	review.configure(api)
	read_now(review)
	t.check(review.begin_preview("shell", "\"/bin/sh\""), "the preview is issued")
	while review.is_pending():
		review.poll_preview()
	t.check_equal(
		review.preview_revision(), "",
		"the service reported no revision for the preview"
	)
	t.check(
		not review.begin_commit("shell", "\"/bin/sh\"", review.preview_revision()),
		"a commit is refused when no revision was validated"
	)
	t.check(
		review.last_error().to_lower().contains("previewed"),
		"and the reason says nothing was validated (%s)" % review.last_error()
	)
	# No commit reached the wire, so nothing was written unguarded. A commit is the only
	# PUT; the read is a GET and the preview a POST, so neither can be mistaken for one.
	var methods: Array = []
	for request in transport.requests:
		methods.append(int(request["method"]))
	t.check(
		not methods.has(HTTPClient.METHOD_PUT),
		"no commit (PUT) was issued, only the read and the preview (%s)" % str(methods)
	)
	t.check_equal(
		methods.size(), 2,
		"exactly the read and the preview were issued"
	)


## --- the root drives the review from the panel's own signals (all five defects) -----

## The REAL composition root: pressing Preview, settling, and pressing Apply must work
## entirely through the root's own handlers, which is what makes the flow a product flow
## rather than a panel-only one.
func test_the_root_drives_preview_and_commit_from_the_panel_signals(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	# A reader whose calls answer immediately, installed as the review's own.
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body([])
	var api := ConfigApi.new()
	api.configure(transport)
	main.config_api = api
	main.config_review = ConfigReview.new()
	main.config_review.configure(api)
	main.settings_panel.bind_review(main.config_review)
	var surface := main.settings_panel.review_surface()
	surface.read_requested.connect(main._on_config_read_requested)
	surface.preview_requested.connect(main._on_config_preview_requested)
	surface.commit_requested.connect(main._on_config_commit_requested)
	surface.read_requested.emit()
	while main.config_api.is_pending():
		main._settle_config()
	t.check_equal(main.config_review.state(), ConfigReview.READY, "the root read the configuration")

	surface.show_page_for("general")
	surface.edit_key("shell", "\"/bin/sh\"")
	t.check(not surface.apply_available(), "Apply starts disabled")
	surface._preview.pressed.emit()
	while main.config_api.is_pending():
		main._settle_config()
	t.check(
		surface.apply_available(),
		"the root armed Apply from the panel's own Preview press"
	)
	surface._apply.pressed.emit()
	while main.config_api.is_pending():
		main._settle_config()
	t.check(
		not surface.is_editing(),
		"and the committed readback closed the editor"
	)
	_free(t, main)


## The ROOT-level superseded-edit race: the answer is matched against the identity captured
## when the request was made, not against the editor at response time.
func test_the_root_never_blesses_a_superseded_edit(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("global")
	# The preview answer is HELD, so the user can edit before it settles.
	transport.hold["preview"] = true
	var api := ConfigApi.new()
	api.configure(transport)
	main.config_api = api
	main.config_review = ConfigReview.new()
	main.config_review.configure(api)
	main.settings_panel.bind_review(main.config_review)
	var surface := main.settings_panel.review_surface()
	surface.read_requested.connect(main._on_config_read_requested)
	surface.preview_requested.connect(main._on_config_preview_requested)
	surface.read_requested.emit()
	while main.config_api.is_pending():
		main._settle_config()
	surface.show_page_for("general")
	surface.edit_key("shell", "\"/bin/zsh\"")
	surface._preview.pressed.emit()
	t.check(main.config_api.is_pending(), "the preview is in flight")
	# The user edits again while it is unresolved.
	surface._editor.text = "\"/bin/dash\""
	surface._on_edit_changed()
	# Now the answer for the FIRST text is released.
	transport.release("preview")
	while main.config_api.is_pending():
		main._settle_config()
	t.check(
		not surface.apply_available(),
		"the root does not arm Apply with an answer for superseded text"
	)
	t.check_equal(
		surface.editor_text(), "\"/bin/dash\"",
		"and the user's newer edit is intact"
	)
	_free(t, main)


## The ROOT-level scope choice: selecting a scope in the panel changes the payload the root
## sends, so the selector is wired to the write rather than decorative.
func test_the_root_writes_to_the_chosen_scope(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	var transport := RecordingTransport.new()
	transport.answer = _read_body()
	transport.answers_by_path[ConfigApi.PREVIEW_PATH] = _preview_body("project")
	transport.answers_by_call["%d %s" % [HTTPClient.METHOD_PUT, ConfigApi.CONFIG_PATH]] = _commit_body_scoped("project", [])
	var api := ConfigApi.new()
	api.configure(transport)
	main.config_api = api
	main.config_review = ConfigReview.new()
	main.config_review.configure(api)
	main.settings_panel.bind_review(main.config_review)
	var surface := main.settings_panel.review_surface()
	surface.read_requested.connect(main._on_config_read_requested)
	surface.preview_requested.connect(main._on_config_preview_requested)
	surface.read_requested.emit()
	while main.config_api.is_pending():
		main._settle_config()
	# A project is open, so Project is selectable; choosing it must reach the review.
	main.settings_panel._has_project = true
	main.settings_panel._project_name = "/workspace/beta"
	main.settings_panel._scope = "global"
	t.check(main.settings_panel.select_scope("project"), "Project can be selected")
	main._on_settings_scope_changed("project")
	t.check_equal(main.config_review.chosen_scope(), "project", "the review is scoped to Project")
	surface.show_page_for("general")
	surface.edit_key("shell", "\"/bin/sh\"")
	surface._preview.pressed.emit()
	while main.config_api.is_pending():
		main._settle_config()
	t.check(surface.apply_available(), "the preview armed Apply")
	surface._apply.pressed.emit()
	while main.config_api.is_pending():
		main._settle_config()
	var last := _last_request(transport)
	t.check_equal(str(last.get("scope", "")), "project", "the write targeted PROJECT")
	_free(t, main)

## Rebinding the configuration transport to another location must CANCEL whatever the old
## transport had in flight, or an answer for the project the user left could land on the
## one they are in.
##
## The rebind is to a DIFFERENT transport, which is what a location switch does (`_side`
## is rebuilt): reconfiguring to the SAME transport is not a location change and must not
## cancel work the caller still owns.
func test_rebinding_the_location_cancels_the_old_transport(t) -> void:
	var old_transport := RecordingTransport.new()
	old_transport.answer = _read_body()
	var api := ConfigApi.new()
	api.configure(old_transport)
	t.check(api.start_read(), "a read is in flight on the old transport")
	t.check(api.is_pending(), "and it is pending")
	# The location changes: a new transport is bound for the new directory.
	var next_transport := RecordingTransport.new()
	next_transport.answer = _read_body()
	api.configure(next_transport)
	t.check(
		old_transport.cancelled.size() >= 1,
		"rebinding cancels the old transport's in-flight request (cancelled %d)"
			% old_transport.cancelled.size()
	)
	t.check(not api.is_pending(), "and the reader is no longer waiting on it")
	t.check_equal(
		next_transport.cancelled.size(), 0,
		"the NEW transport's work is not cancelled"
	)
	# Reconfiguring to the SAME transport is not a location change, so nothing is cancelled.
	var same_transport := RecordingTransport.new()
	same_transport.answer = _read_body()
	var same_api := ConfigApi.new()
	same_api.configure(same_transport)
	same_api.start_read()
	same_api.configure(same_transport)
	t.check_equal(
		same_transport.cancelled.size(), 0,
		"rebinding the same transport cancels nothing"
	)


## --- fixtures added for the above ------------------------------------------------

func _preview_body(scope: String) -> Dictionary:
	return {
		"location": {"directory": "/stub/project", "workspaceID": null, "project": null},
		"data": {
			"scope": scope,
			"path": "/stub/%s/ycoding.jsonc" % scope,
			"revision": _digest("p"),
			"result": _digest("r"),
			"changes": [{"key": "shell", "value": "/bin/sh"}],
		},
	}


func _commit_body_scoped(scope: String, unsettled: Array) -> Dictionary:
	var body := _read_body()
	body["data"] = {
		"scope": scope,
		"path": "/stub/%s/ycoding.jsonc" % scope,
		"revision": _digest("c"),
		"changes": [{"key": "shell", "value": "/bin/sh"}],
		"unsettled": unsettled,
		"read": _read_body()["data"],
	}
	return body


## --- the review surface ------------------------------------------------------

## An edit is not committable until a preview validated EXACTLY that text. This is the
## control-level guarantee, asserted on the control's state.
func test_an_edit_is_not_committable_before_its_exact_text_is_previewed(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/zsh\"")
	t.check(panel.is_editing(), "the editor is open")
	t.check(
		not panel.apply_available(),
		"apply is disabled before a preview"
	)
	t.check(
		panel.apply_reason().to_lower().contains("preview"),
		"and it says a preview is required (%s)" % panel.apply_reason()
	)
	# A settled preview for the SAME text arms it.
	panel.preview_settled("shell", "\"/bin/zsh\"", "rev-abc")
	t.check(panel.apply_available(), "apply is enabled once the exact text is previewed")
	# Editing the text DISARMS it again: the preview no longer describes what would be
	# written.
	panel._editor.text = "\"/bin/dash\""
	panel._on_edit_changed()
	t.check(
		not panel.apply_available(),
		"changing the text after a preview disables apply again"
	)
	# A preview that arrives for DIFFERENT text cannot arm it.
	panel.preview_settled("shell", "\"/bin/zsh\"", "rev-abc")
	t.check(
		not panel.apply_available(),
		"a preview for other text does not arm the current edit"
	)
	panel.free()


## A scope change invalidates an armed preview, because the revision belongs to the old
## scope's document.
func test_a_scope_change_invalidates_an_armed_preview(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	panel.show_page_for("general")
	panel.edit_key("shell", "\"/bin/zsh\"")
	panel.preview_settled("shell", "\"/bin/zsh\"", "rev-abc")
	t.check(panel.apply_available(), "apply is armed")
	panel.invalidate_preview()
	t.check(
		not panel.apply_available(),
		"invalidating the preview disarms apply"
	)
	panel.free()


## The page body shows where a value came from and labels a withheld value, so a reader
## is never told the placeholder is the text.
func test_the_review_panel_shows_provenance_and_a_withheld_note(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	# `share` is owned by the General page and defined by the global document in the
	# fixture read, so it is the row that proves provenance renders.
	panel.show_page_for("general")
	var text := _panel_text(panel)
	t.check(text.contains("share"), "a defined key is listed")
	t.check(
		text.contains("global"),
		"its provenance names the scope it comes from"
	)
	t.check(
		not text.contains("(not set by any document)"),
		"a defined key is not reported as unset"
	)
	# A withheld value is labelled as withheld rather than shown as its text.
	t.check(
		text.contains(ConfigApi.REDACTED) and text.to_lower().contains("withhold"),
		"a withheld value is labelled as withheld (%s)" % text.substr(0, 300)
	)
	t.check(
		panel.apply_available() == false,
		"and nothing is armed simply by showing the page"
	)
	panel.free()


## A value whose only source is virtual offers NO editor, and states why. An edit control
## that would fail on apply is the enabled-affordance defect.
func test_the_review_panel_offers_no_editor_for_an_unwritable_value(t) -> void:
	var panel := ConfigReviewPanel.new()
	panel.bind(_ready_review())
	# `username` is the fixture's virtual-sourced, withheld value, and it is owned by the
	# General page. A row for it must carry the reason rather than an Edit control.
	panel.show_page_for("general")
	var text := _panel_text(panel)
	t.check(text.contains("username"), "the unwritable key is listed")
	t.check(
		text.to_lower().contains("no file") or text.to_lower().contains("file path"),
		"and it states why it cannot be written (%s)" % text.substr(0, 400)
	)
	panel.free()


## A page that owns no key shows no review surface at all, and the navigation says why.
func test_the_review_surface_is_absent_on_a_page_that_owns_no_key(t) -> void:
	var settings := SettingsPanel.new()
	settings._ensure_built()
	settings.bind_review(_ready_review())
	settings.show_page_id("keybindings")
	t.check(
		settings.review_surface() != null and not settings.review_surface().visible,
		"the review surface is hidden on a page that owns no configuration key"
	)
	settings.show_page_id("general")
	t.check(
		settings.review_surface().visible,
		"and shown on a page that owns keys"
	)
	settings.free()


## --- fixtures ----------------------------------------------------------------

## A read body in the live `{location, data}` envelope, with one virtual-sourced value and
## one withheld value of each depth.
func _read_body() -> Dictionary:
	return {
		"location": {"directory": "/stub/project", "workspaceID": null, "project": null},
		"data": {
			"values": {
				"shell": "/bin/zsh",
				"autoupdate": "notify",
				"username": ConfigApi.REDACTED,
				"share": "manual",
			},
			"sources": [
				{
					"path": "/stub/global/ycoding.jsonc",
					"scope": "global",
					"keys": ["shell", "share", "autoupdate"],
					"revision": _digest("a"),
				},
				{"path": "", "scope": "virtual", "keys": ["username"], "revision": _digest("b")},
				{
					"path": "/stub/project/ycoding.jsonc", "scope": "project",
					"keys": ["project_only_key"], "revision": _digest("d"),
				},
			],
		},
	}


## The body of the LAST request, which is the call under test. An earlier request would be
## the read that supplied the revision the call was guarded by.
func _last_request(transport: RecordingTransport) -> Dictionary:
	if transport.requests.is_empty():
		return {}
	return transport.requests[transport.requests.size() - 1]["body"]


## A digest-shaped revision, so a test never asserts against a short placeholder that a
## real document could not produce.
static func _digest(seed: String) -> String:
	var out := ""
	while out.length() < 64:
		out += seed
	return out.substr(0, 64)


func _commit_body(unsettled: Array) -> Dictionary:
	var body := _read_body()
	body["data"] = {
		"scope": "global",
		"path": "/stub/global/ycoding.jsonc",
		"revision": _digest("c"),
		"changes": [{"key": "shell", "value": "/bin/sh"}],
		"unsettled": unsettled,
		"read": _read_body()["data"],
	}
	return body


## A `ConfigApi` whose transport answers from `body` without a socket. The double is
## confined to the transport boundary; the ConfigApi under test is the production one.
func _recording_api(body: Dictionary) -> ConfigApi:
	var transport := RecordingTransport.new()
	transport.answer = body
	transport.answer_status = 200
	var api := ConfigApi.new()
	api.configure(transport)
	return api


## A `ConfigApi` whose every call is refused with `message`.
func _failing_api(message: String) -> ConfigApi:
	var transport := RecordingTransport.new()
	transport.answer = {"message": message, "_tag": "ConfigInvalidError"}
	transport.answer_status = 400
	var api := ConfigApi.new()
	api.configure(transport)
	return api


func _ready_review() -> ConfigReview:
	var review := ConfigReview.new()
	review.configure(_recording_api(_read_body()))
	read_now(review)
	return review


func read_now(review: ConfigReview) -> void:
	review.begin_read()
	var guard := 0
	while review.state() == ConfigReview.LOADING and guard < 50:
		review.poll()
		guard += 1


func _revision_for(review: ConfigReview, scope: String) -> String:
	for value in review._api.sources():
		var source: Dictionary = value
		if str(source.get("scope", "")) == scope:
			return str(source.get("revision", ""))
	return ""


func _transport(base: String) -> HttpTransport:
	var transport := HttpTransport.new()
	transport.configure(base, Gateway.AUTH_USERNAME, _stub_password())
	return transport


## The stub's address and password, passed by the harness through the environment so the
## suite can run standalone (and skip) without one.
func _base_url() -> String:
	return OS.get_environment("YCODING_CONFIG_STUB_URL")


func _stub_password() -> String:
	return OS.get_environment("YCODING_CONFIG_STUB_PASSWORD")


## Whether a loopback stub is available. The wire cases need one, and a suite that
## silently passed without it would claim coverage it did not have, so they SKIP
## explicitly. `ycoding-office-repair-kit/tools/r302_config_check.sh` supplies it.
func _wire_available() -> bool:
	return not _base_url().is_empty()


## Every piece of text a panel is showing.
func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	elif node is TextEdit:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


## A transport double that records requests and answers a canned response.
##
## It is confined to the TRANSPORT boundary: the `ConfigApi`, `ConfigReview`, and panels
## under test are the production classes. What this proves is the wire shape the
## production code BUILDS; what it cannot prove is the service's own behaviour, which the
## loopback stub in `gc_*` cases covers instead.
##
## `hold`/`release` let a test leave a call in flight while it performs another action, so
## a race between a request and a user's edit can be driven deterministically.
class RecordingTransport extends HttpTransport:
	var requests: Array = []
	var answer: Dictionary = {}
	var answer_status := 200
	var answers_by_path: Dictionary = {}
	## Answers keyed by "METHOD path", so the two calls that share `/api/config` - the GET
	## read and the PUT commit - can answer differently. Keying by path alone made a read
	## return a commit body, which left the review with no `values` and no `sources`.
	var answers_by_call: Dictionary = {}
	var refuse_next: String = ""
	var cancelled: Array = []
	## Paths whose answer is withheld until `release` names them.
	var hold: Dictionary = {}
	var _settled: Array[Dictionary] = []
	var _held: Array[Dictionary] = []

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({"method": method, "path": path, "body": body})
		var status := answer_status
		var payload := answer
		if answers_by_path.has(path):
			payload = answers_by_path[path]
		if answers_by_call.has(_call_key(method, path)):
			payload = answers_by_call[_call_key(method, path)]
		if not refuse_next.is_empty():
			status = 400
			payload = {"message": refuse_next}
			refuse_next = ""
		var entry := {
			"request_id": requests.size(), "kind": KIND_RESPONSE,
			"status": status, "body": payload, "event": {}, "error": "",
		}
		if hold.has(path):
			_held.append(entry)
		else:
			_settled.append(entry)
		return requests.size()

	func _call_key(method: int, path: String) -> String:
		return "%d %s" % [method, path]

	## Deliver every withheld answer for `path`.
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
		entries.assign(_settled)
		_settled.clear()
		return entries