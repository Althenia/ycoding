## Settings navigation, search and scope tests (R3-01).
##
## The acceptance is: "Grouped application/workspace/connections/runtime/advanced;
## Global/Project/Folder/Session only where valid."
##
## Two independent half-sentences, and each fails differently:
##
##   * GROUPED NAVIGATION - the pages are grouped, the five groups are offered in a
##     fixed order, every page belongs to exactly one group, and no group is offered
##     while it holds nothing. A group without pages renders as an empty section,
##     and a page without a group is unreachable;
##   * SEARCH - a query finds pages by the names a person knows them by, a group
##     whose pages are all filtered out is not offered, and clearing the box
##     restores the full list rather than leaving it empty;
##   * SCOPE VALIDITY - a session scope with no session selected names a target that
##     does not exist, and a project or folder scope with no folder open names a
##     directory the window is not in. Those are omitted with a stated reason, and a
##     context change that invalidates the current scope reconciles it rather than
##     leaving the control claiming something untrue.
##
## The last assertion set exists because the SAVE surface does not exist yet: R3-02
## (the config owner bridge) is blocked on an additive public contract, so nothing in
## this surface may claim a setting can be edited. The test asserts that boundary
## positively - every page states it - rather than leaving it to review.
##
## The panel is driven at the real boundary: a `SettingsPanel` instance with its real
## `_ready`, and the REAL composition root for the route and scope wiring.
extends RefCounted

const TEST_VIEW_STATE_PATH := "user://test_r301_view_state.cfg"


func run(t) -> void:
	test_the_five_groups_are_offered_in_a_fixed_order(t)
	test_every_page_belongs_to_exactly_one_group(t)
	test_no_group_is_offered_without_pages(t)
	test_each_group_opens_on_a_page_it_owns(t)
	test_every_group_and_page_has_a_label(t)
	test_a_search_finds_a_page_by_the_name_a_person_knows(t)
	test_a_search_reaches_a_page_by_what_it_covers(t)
	test_a_filtered_out_group_is_not_offered(t)
	test_clearing_the_search_restores_every_page(t)
	test_an_empty_search_matches_every_page(t)
	test_search_is_case_insensitive_and_trims(t)
	test_arrow_navigation_walks_the_filtered_list(t)
	test_arrow_navigation_wraps_at_both_ends(t)
	test_only_the_api_scopes_exist(t)
	test_global_is_always_a_valid_scope(t)
	test_a_session_scope_is_never_offered(t)
	test_a_folder_scope_is_not_a_document(t)
	test_a_project_scope_needs_an_open_project(t)
	test_the_scope_reason_names_what_is_missing(t)
	test_a_narrow_scope_is_refused_when_it_is_invalid(t)
	test_an_invalid_scope_reconciles_instead_of_being_kept(t)
	test_a_still_valid_scope_survives_a_context_change(t)
	test_the_scope_badge_names_the_project_it_would_apply_to(t)
	test_a_valid_narrow_scope_is_offered_and_can_be_taken(t)
	test_a_synthetic_location_never_makes_a_project_scope_writable(t)
	test_no_page_claims_a_write_without_one(t)
	test_the_rail_offers_and_marks_the_settings_route(t)
	test_the_settings_route_is_reachable_and_bounded(t)
	test_the_settings_page_survives_navigation(t)
	test_the_page_is_remembered_per_project(t)
	test_the_surface_writes_no_preference(t)


## The settings surface must write NOTHING. This is the same honesty boundary as the
## editing line, asserted at the outside effect: the real per-user preference is read
## before and after driving every page and every scope, and must be byte-identical.
##
## This guard exists because an earlier version of this suite drove `select_folder`,
## which persists a real project list (`ProjectLedger.save()` writes
## `user://projects.cfg` unconditionally - it has no instance path, unlike
## `OfficeViewState`). The suite silently overwrote the list a person was using. The
## guard makes that class of mistake fail loudly here instead of on someone's machine.
func test_the_surface_writes_no_preference(t) -> void:
	var real_projects := ProjectSettings.globalize_path("user://projects.cfg")
	var before := _file_digest(real_projects)
	var before_exists := FileAccess.file_exists(real_projects)

	var panel := SettingsPanel.new()
	panel._ensure_built()
	t.root.add_child(panel)
	# A store with a real folder and a selected session, so every scope is live and the
	# surface is driven through its most context-heavy path.
	var store := OfficeStore.new()
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_write_probe",
		"data": {
			"agent": "lead", "title": "Write probe",
			"location": {"directory": "/workspace/probe"},
		},
		"sourceEpoch": "epoch-w",
	})
	store.select_actor("ses_write_probe")
	panel.show_page(store)
	for page in SettingsGroup.all_pages():
		panel.show_page_id(page)
		panel.show_page(store)
	for scope in panel.available_scopes():
		panel.select_scope(scope)
	panel.search("ntfy")
	panel.search("")

	t.check_equal(
		_file_digest(real_projects), before,
		"driving every settings page and scope leaves the real project list untouched"
	)
	t.check_equal(
		FileAccess.file_exists(real_projects), before_exists,
		"and does not create one where there was none"
	)
	# The path is a real per-user location, not a throwaway: the guard cannot pass
	# merely because the file it watched was somewhere nothing writes.
	t.check(
		real_projects.begins_with(ProjectSettings.globalize_path("user://")),
		"the guard ran against the real per-user path (%s)" % real_projects
	)
	_detach(t, panel)
	panel.free()


## A digest of a file's bytes, or "" when it does not exist. Used to prove a write did
## not happen, which absence alone cannot show.
func _file_digest(path: String) -> String:
	if not FileAccess.file_exists(path):
		return ""
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return ""
	var text := file.get_as_text()
	file.close()
	return str(text.hash())


## --- grouping ----------------------------------------------------------------

## The five group names the acceptance requires, offered in a fixed order. The order
## is asserted rather than merely the membership, because a navigation that reorders
## itself between builds is one a user cannot learn.
func test_the_five_groups_are_offered_in_a_fixed_order(t) -> void:
	t.check_equal(
		SettingsGroup.ORDER,
		["application", "workspace", "connections", "runtime", "advanced"] as Array[String],
		"the five groups are offered in the acceptance's order"
	)
	for group in SettingsGroup.ORDER:
		t.check(
			SettingsGroup.is_group(group),
			"each offered group is recognised: %s" % group
		)
	t.check(
		not SettingsGroup.is_group("general"),
		"a page id is not a group"
	)
	t.check(
		not SettingsGroup.is_group(""),
		"an empty string is not a group"
	)


## Every page has exactly one group, and no page sits in a group that does not exist.
## A page in two groups would appear twice; a page in none is unreachable.
func test_every_page_belongs_to_exactly_one_group(t) -> void:
	t.check(SettingsGroup.PAGES.size() > 5, "there is more than a token number of pages")
	var seen: Dictionary = {}
	for page in SettingsGroup.PAGES:
		var group := SettingsGroup.group_of(str(page))
		t.check(
			SettingsGroup.is_group(group),
			"page %s has a real group (%s)" % [str(page), group]
		)
		t.check(not seen.has(page), "page %s is declared once" % str(page))
		seen[page] = true
	# A label and a detail line are what a page renders, so a page missing either is
	# a blank row.
	for page in SettingsGroup.PAGES:
		t.check(
			not SettingsGroup.page_label(str(page)).is_empty(),
			"page %s has a label" % str(page)
		)
		t.check(
			not SettingsGroup.page_detail(str(page)).is_empty(),
			"page %s explains what it covers" % str(page)
		)
	# And every page is reachable from the offered list.
	for page in SettingsGroup.all_pages():
		t.check(
			SettingsGroup.is_page(page),
			"every offered page is a declared page: %s" % page
		)


## A group with no pages must not be offered. It would render as a heading over
## nothing, which reads as a broken section rather than an absent feature.
func test_no_group_is_offered_without_pages(t) -> void:
	for group in SettingsGroup.groups_present():
		t.check(
			not SettingsGroup.pages_in(group).is_empty(),
			"the offered group %s has pages" % group
		)
	# The two lists agree: what is offered is exactly what has pages.
	t.check_equal(
		SettingsGroup.groups_present().size(),
		SettingsGroup.ORDER.size(),
		"every declared group currently has pages"
	)


## A group opens on a page it actually owns. A first page belonging to another group
## would navigate the user out of the group they clicked.
func test_each_group_opens_on_a_page_it_owns(t) -> void:
	for group in SettingsGroup.groups_present():
		var page := SettingsGroup.first_page(group)
		t.check(
			SettingsGroup.is_page(page),
			"group %s opens on a real page (%s)" % [group, page]
		)
		t.check_equal(
			SettingsGroup.group_of(page),
			group,
			"and that page belongs to the group that opened on it"
		)
	t.check(
		SettingsGroup.is_page(SettingsGroup.default_page()),
		"the default page is a real page"
	)


## Every group names itself and says what it holds.
func test_every_group_and_page_has_a_label(t) -> void:
	for group in SettingsGroup.ORDER:
		t.check(
			not SettingsGroup.label(group).is_empty(),
			"group %s has a label" % group
		)
		t.check(
			not SettingsGroup.detail(group).is_empty(),
			"group %s explains what it holds" % group
		)
	# A coverage list is what a page renders as its contents, so an empty one would be
	# a blank page.
	for page in SettingsGroup.all_pages():
		t.check(
			not SettingsGroup.coverage(page).is_empty(),
			"page %s lists the areas it covers" % page
		)


## --- search ------------------------------------------------------------------

## A search reaches a page by the name a person knows it by, not only by its id.
func test_a_search_finds_a_page_by_the_name_a_person_knows(t) -> void:
	var matched := SettingsGroup.matching_pages("models")
	t.check(matched.has("models"), "searching for a page's name finds it")
	var by_group := SettingsGroup.matching_pages("connections")
	t.check(
		by_group.has("providers") and by_group.has("browser"),
		"searching for a group name finds the pages inside it"
	)
	# A page's own one-line description is searchable too, which is how an unfamiliar
	# name is reached.
	var by_detail := SettingsGroup.matching_pages("guardrail")
	t.check(
		by_detail.has("permissions"),
		"a page is found by a word in its description"
	)


## A search reaches a page by the CONFIGURATION AREA it covers. Without this, a
## person looking for a word that only appears in the coverage list cannot reach the
## page that owns it.
##
## Every term here is chosen so it appears ONLY in a page's coverage list and NOT in
## its label, its description, or its group - otherwise the test would pass through
## one of those fields and prove nothing about coverage. (The mutation check caught
## exactly that: the first version of this test used terms that also appeared in the
## page description, so removing coverage from the search index did not fail it.)
func test_a_search_reaches_a_page_by_what_it_covers(t) -> void:
	# (term, page) where the term is coverage-only for that page.
	var coverage_only := [
		["verbosity", "office"],
		["counters", "permissions"],
		["colour", "appearance"],
		["Leader", "keybindings"],
	]
	for pair in coverage_only:
		var term: String = pair[0]
		var page: String = pair[1]
		var matched := SettingsGroup.matching_pages(term)
		t.check(
			matched.has(page),
			"searching '%s' reaches the %s page (%s)" % [term, page, str(matched)]
		)
		# The premise of the case: the term really is coverage-only for that page, so
		# the match cannot be coming from another field.
		var detail := SettingsGroup.page_detail(page)
		var label := SettingsGroup.page_label(page)
		t.check(
			not detail.to_lower().contains(term.to_lower()),
			"'%s' is not in the %s description, so the match is the coverage list" % [term, page]
		)
		t.check(
			not label.to_lower().contains(term.to_lower()),
			"'%s' is not in the %s label" % [term, page]
		)
		# And it really is in that page's coverage, so the case is not vacuous.
		var found := false
		for item in SettingsGroup.coverage(page):
			if item.to_lower().contains(term.to_lower()):
				found = true
		t.check(found, "'%s' is one of the areas the %s page covers" % [term, page])


## A group whose pages are ALL filtered out must not be offered. An empty section
## under a heading claims the group has nothing rather than that the filter hid it.
func test_a_filtered_out_group_is_not_offered(t) -> void:
	var groups := SettingsGroup.matching_groups("compaction")
	t.check(groups.has("runtime"), "the group owning a match is offered")
	for group in groups:
		t.check(
			not SettingsGroup.pages_in(group).is_empty(),
			"an offered group still has pages (%s)" % group
		)
	# A query nothing matches offers no group at all, rather than every group empty.
	var none := SettingsGroup.matching_groups("zzz-no-such-setting")
	t.check(none.is_empty(), "a query that matches nothing offers no group")
	t.check(
		SettingsGroup.matching_pages("zzz-no-such-setting").is_empty(),
		"and no page"
	)


## Clearing the box restores the full list rather than emptying it.
func test_clearing_the_search_restores_every_page(t) -> void:
	var narrowed := SettingsGroup.matching_pages("ntfy")
	t.check(narrowed.size() < SettingsGroup.all_pages().size(), "the query narrowed the list")
	t.check_equal(
		SettingsGroup.matching_pages(""),
		SettingsGroup.all_pages(),
		"an empty query restores every page"
	)
	t.check_equal(
		SettingsGroup.matching_pages("   "),
		SettingsGroup.all_pages(),
		"whitespace alone is an empty query"
	)


func test_an_empty_search_matches_every_page(t) -> void:
	t.check_equal(
		SettingsGroup.matching_pages("").size(),
		SettingsGroup.PAGES.size(),
		"an empty search matches every declared page"
	)


## Case and surrounding whitespace must not matter: a person types "Providers", not
## the exact stored form.
func test_search_is_case_insensitive_and_trims(t) -> void:
	var lower := SettingsGroup.matching_pages("providers")
	t.check_equal(
		SettingsGroup.matching_pages("PROVIDERS"), lower,
		"an upper-case query matches the same pages"
	)
	t.check_equal(
		SettingsGroup.matching_pages("  providers  "), lower,
		"surrounding whitespace is ignored"
	)
	t.check(
		SettingsGroup.matching_pages("Providers").has("providers"),
		"a capitalised query still finds the page"
	)


## Arrow navigation walks the list the user is LOOKING AT. Stepping from a filtered
## list must not move the selection onto a page the search hid, or the filter would
## silently stop filtering.
func test_arrow_navigation_walks_the_filtered_list(t) -> void:
	var query := "context"
	var pages := SettingsGroup.matching_pages(query)
	t.check(pages.size() >= 2, "the query leaves more than one page to walk")
	if pages.size() < 2:
		return
	var first := pages[0]
	var next := SettingsGroup.stepped_page(first, 1, query)
	t.check_equal(next, pages[1], "stepping forward moves to the next matching page")
	t.check(
		pages.has(next),
		"and the next page is one the query matched"
	)
	# Stepping BACK from the second page returns to the first.
	t.check_equal(
		SettingsGroup.stepped_page(pages[1], -1, query), first,
		"stepping back returns to the previous matching page"
	)


func test_arrow_navigation_wraps_at_both_ends(t) -> void:
	var pages := SettingsGroup.all_pages()
	t.check(pages.size() > 2, "there are enough pages to wrap around")
	if pages.size() <= 2:
		return
	t.check_equal(
		SettingsGroup.stepped_page(pages[pages.size() - 1], 1),
		pages[0],
		"stepping forward past the last page wraps to the first"
	)
	t.check_equal(
		SettingsGroup.stepped_page(pages[0], -1),
		pages[pages.size() - 1],
		"stepping back past the first page wraps to the last"
	)


## --- scope -------------------------------------------------------------------

## The scope model encodes the LIVE API. `Config.Scope` is global|project|virtual and
## `Config.WriteScope` is global|project, so a fourth writable scope would name a
## document the API refuses.
func test_only_the_api_scopes_exist(t) -> void:
	t.check_equal(
		SettingsScope.ALL,
		["global", "project", "virtual"] as Array[String],
		"the scopes are the API's own Config.Scope"
	)
	t.check_equal(
		SettingsScope.WRITABLE,
		["global", "project"] as Array[String],
		"the writable scopes are the API's own Config.WriteScope"
	)
	for scope in SettingsScope.ALL:
		t.check(SettingsScope.is_scope(scope), "each declared scope is recognised: %s" % scope)
	t.check(not SettingsScope.is_scope("workspace"), "an invented scope is refused")
	t.check(not SettingsScope.is_scope(""), "an empty scope is refused")
	t.check_equal(
		SettingsScope.clamp_scope("workspace"), SettingsScope.GLOBAL,
		"an unknown scope clamps to the always-valid one"
	)


## Global is the lowest-precedence document and is always writable, so it is always
## offered - even in a window with no project open.
func test_global_is_always_a_valid_scope(t) -> void:
	for has_project in [false, true]:
		t.check(
			SettingsScope.writable(has_project).has(SettingsScope.GLOBAL),
			"Global is writable with has_project=%s" % has_project
		)
	t.check_equal(
		SettingsScope.writable(false),
		[SettingsScope.GLOBAL] as Array[String],
		"with no project open, Global is the only writable scope"
	)


## A Session scope is not a configuration document at all, so it is never offered - with
## or without a session selected - and its absence is explained.
func test_a_session_scope_is_never_offered(t) -> void:
	t.check(
		not SettingsScope.writable(true).has(SettingsScope.SESSION),
		"Session is not writable even with a project open"
	)
	t.check(
		not SettingsScope.readable(true).has(SettingsScope.SESSION),
		"nor is it readable provenance"
	)
	t.check(
		not SettingsScope.is_available(SettingsScope.SESSION, true),
		"and it is refused as a scope"
	)
	# It is still RECOGNISED, so a surface explains it rather than treating it as a typo.
	var reason := SettingsScope.not_a_scope_explanation(SettingsScope.SESSION)
	t.check(not reason.is_empty(), "Session carries an explanation")
	t.check(reason.to_lower().contains("session"), "which names the session")
	t.check(
		not reason.to_lower().contains("open a project folder"),
		"and does not blame a missing folder, which would be false"
	)


## A Folder scope is likewise not a document: the API has no path field, so the write
## target is always the discovered project document.
func test_a_folder_scope_is_not_a_document(t) -> void:
	t.check(
		not SettingsScope.writable(true).has(SettingsScope.FOLDER),
		"Folder is not writable"
	)
	var reason := SettingsScope.not_a_scope_explanation(SettingsScope.FOLDER)
	t.check(not reason.is_empty(), "Folder carries an explanation")
	t.check(
		reason.to_lower().contains("not a configuration document"),
		"naming the real cause (%s)" % reason
	)


## Project is writable exactly when a project document exists here.
func test_a_project_scope_needs_an_open_project(t) -> void:
	t.check(
		not SettingsScope.writable(false).has(SettingsScope.PROJECT),
		"Project is not offered with no project open"
	)
	t.check(
		SettingsScope.writable(true).has(SettingsScope.PROJECT),
		"Project is writable once a project is open"
	)
	t.check(
		not SettingsScope.is_writable(SettingsScope.VIRTUAL),
		"a virtual document is never writable, because it has no file to write"
	)


## An omitted scope must carry a reason naming what is missing, because a control that
## cannot act must state why.
func test_the_scope_reason_names_what_is_missing(t) -> void:
	var project_reason := SettingsScope.reason_unavailable(SettingsScope.PROJECT, false)
	t.check(not project_reason.is_empty(), "an unavailable Project scope has a reason")
	t.check(
		project_reason.to_lower().contains("project"),
		"and that reason names what is missing (%s)" % project_reason
	)
	t.check(
		not SettingsScope.reason_unavailable(SettingsScope.PROJECT, true).is_empty() == false,
		"a valid Project scope has no reason"
	)
	# A value that is not a scope at all is refused as one rather than being explained
	# with a context problem it does not have.
	t.check(
		SettingsScope.reason_unavailable("workspace", false).to_lower().contains("scope"),
		"a value that is not a scope is refused as one"
	)


## Driving the real panel: a scope that is invalid here is refused rather than
## adopted, so the control can never claim a scope the window cannot honour.
func test_a_narrow_scope_is_refused_when_it_is_invalid(t) -> void:
	var panel := SettingsPanel.new()
	panel._ensure_built()
	t.root.add_child(panel)
	# With no project open, Global is the only scope and Session is not a scope at all.
	var store := OfficeStore.new()
	panel.show_page(store)
	t.check_equal(panel.scope(), SettingsScope.GLOBAL, "the page opens on Global")
	t.check(not panel.select_scope(SettingsScope.PROJECT), "taking Project is refused")
	t.check(not panel.select_scope(SettingsScope.SESSION), "Session is refused as a non-scope")
	t.check_equal(
		panel.scope(), SettingsScope.GLOBAL,
		"and the selector is still on the scope it was showing"
	)
	t.check_equal(
		panel.available_scopes(), [SettingsScope.GLOBAL, SettingsScope.VIRTUAL] as Array[String],
		"with no project open, the read-only provenance scopes are all that is offered"
	)
	_detach(t, panel)
	panel.free()


## A context change that invalidates the chosen scope must reconcile it rather than
## leave the control claiming a scope that is no longer true.
func test_an_invalid_scope_reconciles_instead_of_being_kept(t) -> void:
	t.check_equal(
		SettingsScope.reconcile(SettingsScope.PROJECT, false),
		SettingsScope.GLOBAL,
		"a Project scope with no project falls back to Global"
	)
	t.check_equal(
		SettingsScope.reconcile("nonsense", false),
		SettingsScope.GLOBAL,
		"a scope that is not a scope falls back to Global"
	)


## But a scope that is STILL valid must survive a context change. A session being
## created must not silently move the user to another scope.
func test_a_still_valid_scope_survives_a_context_change(t) -> void:
	t.check_equal(
		SettingsScope.reconcile(SettingsScope.PROJECT, true),
		SettingsScope.PROJECT,
		"a valid Project scope is kept"
	)
	t.check_equal(
		SettingsScope.reconcile(SettingsScope.GLOBAL, true),
		SettingsScope.GLOBAL,
		"and Global is never moved off itself"
	)


## The badge names WHICH project a narrow scope would apply to.
func test_the_scope_badge_names_the_project_it_would_apply_to(t) -> void:
	t.check_equal(SettingsScope.badge(SettingsScope.GLOBAL), "Global", "Global is named")
	t.check_equal(
		SettingsScope.badge(SettingsScope.PROJECT, "/w/beta"), "Project: /w/beta",
		"a Project badge names the project"
	)
	t.check_equal(
		SettingsScope.badge(SettingsScope.PROJECT, ""), "Project",
		"a Project badge with no name is still readable"
	)


## --- the write boundary -------------------------------------------------------

## No page may claim a write happened when none did. With the owner now wired, a page
## whose value has not been read must say so rather than showing a value or a success.
## The positive side - that a previewed write DOES report - is covered by
## `test_config_bridge.gd`; this asserts the surface never fabricates.
func test_no_page_claims_a_write_without_one(t) -> void:
	var panel := SettingsPanel.new()
	panel._ensure_built()
	t.root.add_child(panel)
	var store := OfficeStore.new()
	for page in SettingsGroup.all_pages():
		panel.show_page_id(page)
		t.check_equal(panel.page(), page, "the panel shows the page asked for: %s" % page)
		# A page that owns no key states why, rather than rendering blank.
		if SettingsGroup.keys_for(page).is_empty():
			t.check(
				not SettingsGroup.no_key_reason(page).is_empty(),
				"page %s with no key states why" % page
			)
	_detach(t, panel)
	panel.free()


## A scope that is VALID must actually be OFFERED, and taking it must work. The
## negative half is covered above; this is the half that fails if the selector only ever
## offers Global, which would make the whole scope control decorative.
func test_a_valid_narrow_scope_is_offered_and_can_be_taken(t) -> void:
	var panel := SettingsPanel.new()
	panel._ensure_built()
	t.root.add_child(panel)
	# A store holding a real project session: a non-synthetic actor reporting a real
	# directory. That is the context in which the Project document is writable.
	var store := OfficeStore.new()
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_scope",
		"data": {
			"agent": "lead", "title": "Scope probe",
			"location": {"directory": "/workspace/beta"},
		},
		"sourceEpoch": "epoch-s",
	})
	store.select_actor("ses_scope")
	panel.show_page(store)
	t.check_equal(
		panel.available_scopes(),
		[SettingsScope.GLOBAL, SettingsScope.PROJECT, SettingsScope.VIRTUAL] as Array[String],
		"with a project open, both writable scopes and the read-only one are offered"
	)
	# The selector is usable now, so it must not be disabled.
	t.check(not panel._scope_button.disabled, "the selector can act")
	# Taking a narrow scope works and reports it.
	var seen: Array[String] = []
	panel.scope_changed.connect(func(scope: String): seen.append(scope))
	t.check(panel.select_scope(SettingsScope.PROJECT), "Project can be taken")
	t.check_equal(panel.scope(), SettingsScope.PROJECT, "and the page is scoped to it")
	t.check_equal(seen, [SettingsScope.PROJECT] as Array[String], "the change is reported once")
	# The badge names WHICH project, not merely the scope kind.
	t.check(
		panel._scope_button.text.contains("beta"),
		"the badge names the project it applies to (%s)" % panel._scope_button.text
	)
	_detach(t, panel)
	panel.free()


## A synthetic session's fixture folder is not a real place, so it must never make the
## Project document writable: the selector would then name a location the window is not
## in, and a write would target a document that does not exist.
func test_a_synthetic_location_never_makes_a_project_scope_writable(t) -> void:
	var panel := SettingsPanel.new()
	panel._ensure_built()
	t.root.add_child(panel)
	var store := OfficeStore.new()
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_demo",
		"data": {
			"agent": "lead", "title": "Synthetic",
			"location": {"directory": "/fixtures/not-a-real-place"},
			"synthetic": true,
		},
		"sourceEpoch": "epoch-d",
	})
	store.select_actor("ses_demo")
	panel.show_page(store)
	t.check(
		not panel.available_scopes().has(SettingsScope.PROJECT),
		"a synthetic folder does not make Project writable (%s)" % str(panel.available_scopes())
	)
	t.check_equal(
		panel.scope(), SettingsScope.GLOBAL,
		"so the page stays on the global document"
	)
	_detach(t, panel)
	panel.free()


## --- route and root wiring ----------------------------------------------------

## The rail offers the Settings route and marks it when it is current, exactly as it
## does the other routes. A route the rail cannot ask for is not navigation.
func test_the_rail_offers_and_marks_the_settings_route(t) -> void:
	var sidebar := SidebarPanel.new()
	sidebar._ensure_built()
	t.root.add_child(sidebar)
	t.check(
		sidebar._route_buttons.has(OfficeRoute.SETTINGS),
		"the rail carries a Settings row"
	)
	var asked: Array[String] = []
	sidebar.route_requested.connect(func(route: String): asked.append(route))
	(sidebar._route_buttons[OfficeRoute.SETTINGS] as Button).pressed.emit()
	t.check_equal(asked, [OfficeRoute.SETTINGS] as Array[String], "and it asks for Settings")
	sidebar.set_route(OfficeRoute.SETTINGS)
	var text := (sidebar._route_buttons[OfficeRoute.SETTINGS] as Button).text
	t.check(
		text.contains(SidebarPanel.MARK_SELECTED),
		"the Settings row is marked when current (%s)" % text
	)
	t.check(
		text.contains(OfficeRoute.glyph(OfficeRoute.SETTINGS)),
		"and carries its own glyph"
	)
	_detach(t, sidebar)
	sidebar.free()


## The Settings surface is a bounded large page centred in the content region: never
## full-bleed, and never under the docked rail.
func test_the_settings_route_is_reachable_and_bounded(t) -> void:
	t.check(
		OfficeRoute.is_route(OfficeRoute.SETTINGS),
		"Settings is a route the shell can show"
	)
	t.check(
		not OfficeRoute.shows_world(OfficeRoute.SETTINGS),
		"and it is not the spatial world"
	)
	for scale in UiScale.STEPS:
		for size in [
			Vector2(1024, 768), Vector2(1280, 720), Vector2(1440, 900),
			Vector2(1920, 1080), Vector2(2560, 1440),
		]:
			var rect := OfficeShellLayout.settings_region(size, scale)
			var sidebar_w := OfficeShellLayout.sidebar_width(size, scale)
			t.check(rect.size.x > 0.0 and rect.size.y > 0.0,
				"the settings page has area at %s x%.2f" % [str(size), scale])
			t.check(
				rect.position.x >= sidebar_w - 0.01,
				"the settings page starts east of the docked rail at %s x%.2f" % [str(size), scale]
			)
			t.check(
				rect.position.x + rect.size.x <= size.x + 0.01,
				"and stays inside the window at %s x%.2f" % [str(size), scale]
			)
			t.check(
				rect.size.x <= OfficeShellLayout.SETTINGS_W * scale + 0.01,
				"its width is capped at %s x%.2f" % [str(size), scale]
			)
			# The floor grows with the text scale, so a scaled-up page is not capped
			# below the width its own navigation column and body need.
			var content_w: float = size.x - sidebar_w
			var available: float = content_w - OfficeShellLayout.SETTINGS_MARGIN * 2.0
			if available >= OfficeShellLayout.SETTINGS_MIN_W * scale:
				t.check(
					rect.size.x >= OfficeShellLayout.SETTINGS_MIN_W * scale - 0.01,
					"its width honours the scaled content floor at %s x%.2f"
						% [str(size), scale]
				)
			t.check(
				rect.size.y <= size.y - OfficeShellLayout.SETTINGS_MARGIN * 2.0 + 0.01,
				"its height keeps the margin at %s x%.2f" % [str(size), scale]
			)
	t.check(
		not OfficeShellLayout.OVERLAYS.has("settings"),
		"the settings page is a surface, not a floating overlay"
	)


## The REAL composition root: navigating to Settings shows the settings surface and
## nothing else owns the content region there.
func test_the_settings_page_survives_navigation(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	main.router.go(OfficeRoute.SETTINGS)
	t.check(main.settings_panel.visible, "the settings surface is shown on its route")
	t.check(not main.office_view.visible, "the world is not shown behind it")
	t.check(not main.prompt_panel.visible, "and neither is the composer")
	t.check(
		not str(main.statistics_panel.visible) if main.statistics_panel == null
		else not main.statistics_panel.visible,
		"the statistics surface does not own the region"
	)
	# The panel is showing a real page, not an empty surface.
	t.check(
		SettingsGroup.is_page(main.settings_panel.page()),
		"the surface shows a real page (%s)" % main.settings_panel.page()
	)
	# Leaving and returning preserves the page.
	main.settings_panel.show_page_id("permissions")
	main.router.go(OfficeRoute.OFFICE)
	t.check(main.office_view.visible, "the office is shown again on its own route")
	main.router.go(OfficeRoute.SETTINGS)
	t.check_equal(
		main.settings_panel.page(), "permissions",
		"returning to Settings resumes the page it was left on"
	)
	_free(t, main)


## A page chosen in one project must not be the page another project opens on.
##
## The real path is driven WITHOUT `select_folder`: `ProjectLedger.save()` writes
## `user://projects.cfg` unconditionally (it has no instance path, unlike
## `OfficeViewState`), so a folder switch in a test overwrites the project list a
## person is actually using. The view-state transaction is therefore driven directly
## - `_capture_view_state` and `_restore_view_state` are the two halves a switch uses -
## so the property is still proven end to end without writing that preference.
func test_the_page_is_remembered_per_project(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_VIEW_STATE_PATH))
	var alpha_entry := "entry-r301-alpha"
	var beta_entry := "entry-r301-beta"

	# Project alpha: settings open on the usage page, which is then captured the way a
	# switch captures the project being left.
	main.router.go(OfficeRoute.SETTINGS)
	main.settings_panel.show_page_id("usage")
	t.check_equal(main.settings_panel.page(), "usage", "the usage page can be chosen")
	var captured := main._capture_view_state()
	t.check_equal(
		str(captured.get("settings_page", "")), "usage",
		"the page is part of the project's saved view state"
	)
	main.view_state.remember(alpha_entry, captured)

	# Project beta has NO saved page, so entering it must RESET the surface rather than
	# inherit the page left open in alpha.
	main.view_state.remember(beta_entry, {
		"view_route": OfficeRoute.SETTINGS,
		"unsent_draft": "",
	})
	main._restore_view_state(beta_entry)
	t.check_equal(
		main.settings_panel.page(), SettingsGroup.default_page(),
		"a project with no saved page opens on the default, not the other project's page"
	)

	# Returning to alpha restores its own page.
	main._restore_view_state(alpha_entry)
	t.check_equal(
		main.settings_panel.page(), "usage",
		"returning to a project restores the settings page it was left on"
	)
	_free(t, main)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_VIEW_STATE_PATH))


## --- fixtures -----------------------------------------------------------------

## A composition root wired the way `_ready` wires the settings surface, without the
## scene. The panels are attached to the TREE so their `_ready` runs in real scope;
## the root itself is not readied.
func _bootable(t) -> OfficeMain:
	var main := OfficeMain.new()
	main.store = OfficeStore.new()
	main.director = OfficeDirector.new()
	main.demo = DemoTransport.new()
	main.live = LiveTransport.new()
	main.models_api = ModelCatalogApi.new()
	main.sessions_api = SessionApi.new()
	# The composer is attached to the tree, because focus exists only in tree scope.
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
	# The statistics surface is attached so a route test can assert that it does NOT
	# own the content region while Settings does. Without it the assertion would be
	# made against null and prove nothing.
	main.statistics_panel = StatisticsPanel.new()
	t.root.add_child(main.statistics_panel)
	# The settings surface is attached to the TREE so its real `_ready` builds it.
	main.settings_panel = SettingsPanel.new()
	t.root.add_child(main.settings_panel)
	main.office_view = OfficeViewport.new()
	main.add_child(main.office_view)
	# A test must never write over the preference a person is using.
	main.view_state = OfficeViewState.new()
	main.view_state.file_path = TEST_VIEW_STATE_PATH
	main._wire_signals()
	return main


func _free(t, main: OfficeMain) -> void:
	if main.live != null:
		main.live.stop()
	# The composer and the panels parented to the TREE rather than the root are not
	# freed by freeing the root, so they are detached from the tree and freed here.
	for panel: Node in [main.prompt_panel, main.settings_panel, main.statistics_panel]:
		if panel == null:
			continue
		var parent: Node = panel.get_parent()
		if parent != null:
			parent.remove_child(panel)
		panel.free()
	main.free()


## Detach a panel from the tree before freeing it.
##
## The runner is a `SceneTree`, which has no `remove_child`: the parent NODE owns the
## operation. A panel freed while still parented to the tree leaks.
func _detach(t, panel: Node) -> void:
	var parent: Node = panel.get_parent()
	if parent != null:
		parent.remove_child(panel)


## Every piece of text a panel is showing, so an assertion can be made against what a
## reader would see rather than against an internal field.
func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()