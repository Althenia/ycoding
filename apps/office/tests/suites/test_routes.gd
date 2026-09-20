## Route owner tests (R2-04).
##
## The acceptance is: "State survives navigation; background execution and
## attention remain available across pages."
##
## What is asserted here is deliberately narrow, because the acceptance is about
## what navigation must NOT do:
##
##   * the route is a closed set, and an unknown route is refused rather than
##     adopted, so the content region can never be owned by nothing;
##   * the owner holds no transport, session or permission reference, so a route
##     change has no path by which it could stop work or retarget a prompt;
##   * work state on the projection survives a navigation, and critical attention
##     stays reachable, because the store is not the router's business.
##
## The last point is the one that matters most: a route change must leave the
## durable projection untouched. That is asserted against a real store rather than
## by inspecting the router, because "nothing happened" is only meaningful when
## there was something that could have happened.
extends RefCounted


func run(t) -> void:
	test_the_route_set_is_closed(t)
	test_an_unknown_route_is_never_adopted(t)
	test_the_default_route_is_the_spatial_office(t)
	test_navigation_reports_whether_it_changed(t)
	test_navigation_never_touches_the_projection(t)
	test_attention_stays_reachable_across_routes(t)
	test_the_owner_holds_nothing_that_could_stop_work(t)
	test_the_rail_offers_every_route_and_marks_the_current_one(t)


## Every offered route is a real route, the list is ordered, and the labels and
## glyphs cover exactly the same set. A route in the rail but not in the set would
## be unshowable.
func test_the_route_set_is_closed(t) -> void:
	t.check(OfficeRoute.ALL.size() > 1, "there is more than one route")
	for route in OfficeRoute.ALL:
		t.check(OfficeRoute.is_route(route), "an offered route is recognised: %s" % route)
		t.check(
			not OfficeRoute.label(route).is_empty(),
			"an offered route has a label: %s" % route
		)
		t.check(
			not OfficeRoute.glyph(route).is_empty(),
			"an offered route has a glyph: %s" % route
		)
	# The label and glyph tables must not carry a route the set does not offer.
	t.check_equal(
		OfficeRoute.LABELS.size(),
		OfficeRoute.ALL.size(),
		"the label table covers exactly the offered routes"
	)
	t.check_equal(
		OfficeRoute.GLYPHS.size(),
		OfficeRoute.ALL.size(),
		"the glyph table covers exactly the offered routes"
	)
	# Markers must be distinct, so two routes are never the same glyph.
	var glyphs := {}
	for route in OfficeRoute.ALL:
		var glyph := OfficeRoute.glyph(route)
		t.check(not glyphs.has(glyph), "the glyph for %s is distinct" % route)
		glyphs[glyph] = true


## An unknown route is refused, not adopted. Adopting one would leave the content
## region owned by a surface that does not exist.
func test_an_unknown_route_is_never_adopted(t) -> void:
	# `Settings` is now a real route, so the unrecognised examples below are names
	# that still are not one: a different case, and a trailing space.
	for bogus in ["", "nonsense", "OFFICE", "office ", "statistics ", "Setting", "settings "]:
		t.check(
			not OfficeRoute.is_route(bogus),
			"an unrecognised route is refused: '%s'" % bogus
		)
		t.check_equal(
			OfficeRoute.clamp_route(bogus),
			OfficeRoute.DEFAULT,
			"and clamping falls back to the default: '%s'" % bogus
		)

	# Through the owner: a bogus request leaves the current route alone.
	var router := OfficeRouter.new()
	router.go(OfficeRoute.SESSIONS)
	t.check(not router.go("nonsense"), "a bogus navigation reports no change")
	t.check_equal(
		router.route(),
		OfficeRoute.SESSIONS,
		"and the shell is still on the route it was showing"
	)


## The shell starts on the spatial Office surface, which is the product default.
func test_the_default_route_is_the_spatial_office(t) -> void:
	t.check_equal(OfficeRoute.DEFAULT, OfficeRoute.OFFICE, "Office is the default route")
	var router := OfficeRouter.new()
	t.check_equal(router.route(), OfficeRoute.OFFICE, "a new router starts on Office")
	t.check(router.shows_world(), "and the spatial world is the surface showing")
	# Only Office shows the world; the detail routes are full-width content.
	router.go(OfficeRoute.SESSIONS)
	t.check(not router.shows_world(), "Sessions does not show the spatial world")
	t.check(
		not OfficeRoute.shows_world(OfficeRoute.STATISTICS),
		"Statistics does not show the spatial world"
	)


## A real navigation reports a change exactly once, and a repeated one reports
## none. Redundant work is how a repeated navigation becomes a visible redraw.
func test_navigation_reports_whether_it_changed(t) -> void:
	var router := OfficeRouter.new()
	var seen: Array[String] = []
	router.route_changed.connect(func(route: String): seen.append(route))

	t.check(router.go(OfficeRoute.SESSIONS), "moving to a new route reports a change")
	t.check(seen == [OfficeRoute.SESSIONS], "the signal carried the new route once")
	t.check(not router.go(OfficeRoute.SESSIONS), "re-showing the same route reports nothing")
	t.check_equal(seen.size(), 1, "and emitted nothing more")

	t.check(router.go(OfficeRoute.STATISTICS), "moving on reports another change")
	t.check(router.go(OfficeRoute.OFFICE), "returning to Office reports a change")
	t.check_equal(
		seen,
		[OfficeRoute.SESSIONS, OfficeRoute.STATISTICS, OfficeRoute.OFFICE],
		"every real navigation was reported in order"
	)


## THE ACCEPTANCE. Navigating must not disturb the projection: the route is a view
## concern and the store is the canonical state. This is asserted against a real
## store holding real work and attention, so "nothing changed" is a meaningful
## claim rather than a vacuous one.
func test_navigation_never_touches_the_projection(t) -> void:
	var store := OfficeStore.new()
	store.apply({
		"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-r",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-r",
	})
	# A running step, so there is real work that a careless route change could stop.
	store.apply({
		"type": Wire.STEP_STARTED, "sessionID": "ses_r", "data": {}, "sourceEpoch": "epoch-r",
	})
	store.mark_stale()

	var actors_before := store.actor_list().size()
	var epoch_before := store.source_epoch
	var stale_before := store.is_stale()
	var state_before := store.actor_for("ses_r").work_state

	var router := OfficeRouter.new()
	for route in [OfficeRoute.SESSIONS, OfficeRoute.STATISTICS, OfficeRoute.OFFICE]:
		router.go(route)
		t.check_equal(
			store.actor_list().size(),
			actors_before,
			"the roster is unchanged after navigating to %s" % route
		)
		t.check_equal(
			store.source_epoch,
			epoch_before,
			"the epoch is unchanged after navigating to %s" % route
		)
		t.check_equal(
			store.is_stale(),
			stale_before,
			"staleness is unchanged after navigating to %s" % route
		)
		t.check_equal(
			store.actor_for("ses_r").work_state,
			state_before,
			"the running work state is unchanged after navigating to %s" % route
		)


## Critical attention must remain reachable on every route: a human review cannot
## be hidden by the surface the user happens to be looking at.
func test_attention_stays_reachable_across_routes(t) -> void:
	var store := OfficeStore.new()
	store.apply({
		"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-a",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-a",
	})
	store.apply({
		"type": Wire.GUARDRAIL_ASKED, "sessionID": "ses_a",
		"data": {
			"id": "grq_r", "sessionID": "ses_a", "action": "git.push",
			"resources": ["main"], "reason": "Protected branch",
		},
		"sourceEpoch": "epoch-a",
	})
	t.check(
		not store.attention.for_session("ses_a").is_empty(),
		"the review is pending before any navigation"
	)

	var router := OfficeRouter.new()
	for route in OfficeRoute.ALL:
		router.go(route)
		t.check(
			not store.attention.for_session("ses_a").is_empty(),
			"the review is still pending on the %s route" % route
		)


## The owner must hold nothing by which a navigation could reach the transports.
## This is a structural assertion, and it is the strongest available proof that
## navigation cannot stop work: there is no reference to stop it with.
func test_the_owner_holds_nothing_that_could_stop_work(t) -> void:
	var router := OfficeRouter.new()
	var state: Variant = router.get("_route")
	t.check(state is String, "the router's whole state is a plain string route")
	# The router exposes exactly the route it is showing and one navigation signal.
	# A transport, store or permission reference would have to appear as a property,
	# so the property list is the honest place to look.
	var names: Array[String] = []
	for property in router.get_property_list():
		names.append(str(property.get("name", "")))
	t.check(names.has("_route"), "the router's state is the route")
	for forbidden in ["_transport", "transport", "_store", "store", "live", "_live"]:
		t.check(
			not names.has(forbidden),
			"the router holds no %s by which a navigation could reach a transport"
				% forbidden
		)


## The routes must be REACHABLE. A route owner nothing can ask is not navigation,
## so the rail's own rows are built and driven here: every route has a row, a row
## asks for its own route, and the current one is marked without relying on colour.
func test_the_rail_offers_every_route_and_marks_the_current_one(t) -> void:
	var sidebar := SidebarPanel.new()
	sidebar._ensure_built()
	t.root.add_child(sidebar)

	t.check(
		sidebar._route_buttons.size() == OfficeRoute.ALL.size(),
		"the rail carries a row for every route (got %d)" % sidebar._route_buttons.size()
	)
	for route in OfficeRoute.ALL:
		t.check(
			sidebar._route_buttons.has(route),
			"the rail has a row for %s" % route
		)

	# A row ASKS for its own route; the rail never routes by itself.
	var asked: Array[String] = []
	sidebar.route_requested.connect(func(route: String): asked.append(route))
	for route in OfficeRoute.ALL:
		var button: Button = sidebar._route_buttons[route]
		button.pressed.emit()
	t.check_equal(
		asked,
		OfficeRoute.ALL,
		"each row asked for exactly its own route, in the offered order"
	)

	# The current route is marked, and only it. The marker is a text glyph, so the
	# distinction survives without colour.
	sidebar.set_route(OfficeRoute.SESSIONS)
	for route in OfficeRoute.ALL:
		var text := (sidebar._route_buttons[route] as Button).text
		var marked := text.contains(SidebarPanel.MARK_SELECTED)
		t.check_equal(
			marked,
			route == OfficeRoute.SESSIONS,
			"the %s row marker matches whether it is current" % route
		)
		t.check(
			text.contains(OfficeRoute.glyph(route)),
			"the row still carries its own glyph: %s" % route
		)
	sidebar.free()
