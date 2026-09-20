## Anchor kinds, bounded reservations and Y-sort depth tests (R4-02).
##
## The acceptance is: "No wall cutting, wrong foreground depth or stuck doors;
## work/visitor/meeting anchors use bounded reservations."
##
## Three separate properties, failing differently:
##
##   * ANCHOR KINDS - the acceptance names work, visitor AND meeting anchors. Only
##     work and visitor were declared anywhere, and nothing in the project mentioned
##     `meeting` at all, so the meeting kind is the one that had to be added. The
##     real meeting places are already named by the world's own `STATIONS`, so the
##     kind is attached to those props rather than to arbitrary cells.
##   * BOUNDED RESERVATIONS - no reserve/release concept existed anywhere. A
##     reservation must admit one holder, be idempotent for the same holder, free on
##     release, refuse an unknown anchor, and never be able to block a work anchor
##     forever (which is what `docs/PLAYER_CONTROLS.md:15` forbids: "Never let a
##     stuck player permanently block NPC work anchors").
##   * DEPTH - a seated actor and the prop it sits at must not share a draw order
##     that puts the prop in front of the actor, or the actor is hidden by its desk.
##     That is what "wrong foreground depth" means, and it is asserted per anchor kind
##     rather than for work anchors only.
extends RefCounted


func run(t) -> void:
	test_every_anchor_kind_includes_the_accepted_three(t)
	test_meeting_anchors_belong_to_the_real_meeting_places(t)
	test_every_anchor_of_every_kind_is_reachable_and_standable(t)
	test_a_reservation_admits_one_holder(t)
	test_the_same_holder_re_reserving_is_idempotent(t)
	test_release_frees_the_anchor_for_another_holder(t)
	test_an_unknown_anchor_is_refused(t)
	test_a_reservation_cannot_outlive_its_bound(t)
	test_reserving_never_makes_a_cell_solid(t)
	test_reservations_are_bounded_by_the_declared_anchors(t)
	test_seated_actors_are_not_hidden_by_their_props(t)


## The accepted three kinds. A kind the layout declares but the code cannot name is
## unreachable, and a kind the acceptance names but the layout lacks is unimplemented.
func test_every_anchor_kind_includes_the_accepted_three(t) -> void:
	var kinds := {}
	for desk_id in OfficeWorld.ANCHORS:
		for which in (OfficeWorld.ANCHORS[desk_id] as Dictionary):
			kinds[str(which)] = true
	for kind in ["work", "visitor", "meeting"]:
		t.check(kinds.has(kind), "the layout declares %s anchors" % kind)


## The meeting kind must sit on the props the world itself calls meeting places.
## Attaching it to arbitrary cells would satisfy the kind count while meaning nothing.
func test_meeting_anchors_belong_to_the_real_meeting_places(t) -> void:
	var huddle: Array = OfficeWorld.STATIONS.get("huddle", [])
	t.check(not huddle.is_empty(), "the world names its huddle stations")
	if huddle.is_empty():
		return
	for desk_id in huddle:
		var id := str(desk_id)
		t.check(OfficeWorld.ANCHORS.has(id), "the huddle station %s has a row" % id)
		if not OfficeWorld.ANCHORS.has(id):
			continue
		var row: Dictionary = OfficeWorld.ANCHORS[id]
		t.check(row.has("meeting"), "the huddle station %s declares a meeting anchor" % id)
	# And no NON-huddle prop may claim one, or the kind stops meaning "meeting place".
	for desk_id in OfficeWorld.ANCHORS:
		var id := str(desk_id)
		if huddle.has(id):
			continue
		t.check(
			not (OfficeWorld.ANCHORS[id] as Dictionary).has("meeting"),
			"%s is not a huddle station, so it declares no meeting anchor" % id
		)


## Every anchor of every kind must be standable and reachable from the doorway. A
## meeting anchor placed inside a table would be a reservation nobody can honour.
func test_every_anchor_of_every_kind_is_reachable_and_standable(t) -> void:
	var world := OfficeWorld.new()
	t.check(world != null, "the world builds")
	if world == null:
		return
	world.setup(null)
	t.check(
		world.navigation.all_anchors_reachable(),
		"every anchor of every kind is reachable and unblocked"
	)
	# Each declared kind can actually be addressed by the navigation API.
	for desk_id in OfficeWorld.ANCHORS:
		var id := str(desk_id)
		for which in (OfficeWorld.ANCHORS[id] as Dictionary):
			var pos := world.navigation.anchor_position(id, str(which))
			t.check(
				pos != Vector2.ZERO,
				"the %s anchor of %s resolves to a position" % [str(which), id]
			)
	world.free()


## A reservation admits ONE holder. Two holders on one anchor is the collision the
## reservation exists to prevent.
func test_a_reservation_admits_one_holder(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	t.check(
		navigation.reserve("desk_prod_0", "work", "ses_a"),
		"the first holder reserves an anchor"
	)
	t.check(
		not navigation.reserve("desk_prod_0", "work", "ses_b"),
		"a different holder is refused the same anchor"
	)
	t.check_equal(
		navigation.holder_of("desk_prod_0", "work"),
		"ses_a",
		"the anchor still belongs to the first holder"
	)


## Re-reserving the same anchor by the SAME holder is not a failure: a runner that
## re-affirms its seat every frame must not be told it lost it.
func test_the_same_holder_re_reserving_is_idempotent(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	t.check(navigation.reserve("desk_ops_1", "work", "ses_a"), "the holder reserves it")
	t.check(
		navigation.reserve("desk_ops_1", "work", "ses_a"),
		"the same holder re-reserving succeeds"
	)
	t.check_equal(
		navigation.holder_of("desk_ops_1", "work"),
		"ses_a",
		"and nothing changed hands"
	)


## Release frees the anchor, which is how a departed actor stops holding a seat.
func test_release_frees_the_anchor_for_another_holder(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	navigation.reserve("hud_table", "meeting", "ses_a")
	t.check_equal(navigation.holder_of("hud_table", "meeting"), "ses_a", "held")
	navigation.release("hud_table", "meeting")
	t.check_equal(navigation.holder_of("hud_table", "meeting"), "", "released")
	t.check(
		navigation.reserve("hud_table", "meeting", "ses_b"),
		"another holder can take it after release"
	)
	# Releasing an anchor nobody holds is a no-op, not an error.
	navigation.release("hud_table", "meeting")
	navigation.release("hud_table", "meeting")
	t.check_equal(
		navigation.holder_of("hud_table", "meeting"),
		"",
		"a repeated release leaves it free"
	)


## An unknown anchor is refused rather than silently keyed, which is what keeps the
## reservation table bounded by the declared anchors.
func test_an_unknown_anchor_is_refused(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	# `hud_table` is deliberately NOT in this list: it is a real anchor, and
	# reserving it must succeed. Only names that are not declared anchors are refused.
	for bogus in ["desk_nope", "", "ghost_desk", "hud_tabl"]:
		t.check(
			not navigation.reserve(bogus, "work", "ses_a"),
			"reserving an unknown anchor is refused: '%s'" % bogus
		)
		t.check(
			not navigation.reserve("desk_prod_0", "nonsense", "ses_a"),
			"reserving an unknown KIND is refused"
		)
	t.check_equal(
		navigation.holder_of("desk_prod_0", "work"),
		"",
		"and nothing was keyed by the refusals"
	)


## A reservation must not be able to block an anchor forever. The spec forbids a
## stuck holder permanently blocking a work anchor, so a reservation EXPIRES: a
## caller contract alone cannot guarantee release when a session dies.
func test_a_reservation_cannot_outlive_its_bound(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	t.check(OfficeNavigation.RESERVATION_TTL_MS > 0, "there is a positive TTL bound")
	navigation.reserve("desk_prod_1", "work", "ses_stuck", 1000)
	# Still held well inside the bound.
	t.check(
		navigation.holder_of("desk_prod_1", "work", 1000 + OfficeNavigation.RESERVATION_TTL_MS - 1) == "ses_stuck",
		"the reservation holds inside its bound"
	)
	# Expired at the bound, so a stuck holder cannot block the seat forever.
	t.check_equal(
		navigation.holder_of("desk_prod_1", "work", 1000 + OfficeNavigation.RESERVATION_TTL_MS),
		"",
		"the reservation expires at its bound"
	)
	t.check(
		navigation.reserve("desk_prod_1", "work", "ses_next", 1000 + OfficeNavigation.RESERVATION_TTL_MS),
		"and the anchor is available to a new holder after expiry"
	)


## Reserving is a claim on a STANDING SPOT, never a change to the map: it must not
## make the cell solid, or reserving a seat would wall an actor in.
func test_reserving_never_makes_a_cell_solid(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	var cell := navigation.anchor_cell("desk_prod_0", "work")
	t.check(not navigation.is_blocked(cell), "the anchor cell starts standable")
	navigation.reserve("desk_prod_0", "work", "ses_a")
	t.check(
		not navigation.is_blocked(cell),
		"reserving an anchor does NOT make its cell solid"
	)
	t.check(
		navigation.all_anchors_reachable(),
		"and every anchor stays reachable with reservations outstanding"
	)


## The reservation table is bounded by the declared anchors: an unknown anchor is
## never keyed, so the table cannot grow past the layout.
func test_reservations_are_bounded_by_the_declared_anchors(t) -> void:
	var world := _world()
	var navigation := world.navigation
	t.check(navigation != null, "the navigation builds")
	if navigation == null:
		world.free()
		return
	# Try to blow the table up with names that do not exist.
	for index in 500:
		navigation.reserve("ghost_%d" % index, "work", "ses_x")
	t.check(
		navigation.reserved_count() <= navigation.anchor_count(),
		"the reservation table cannot exceed the declared anchors (held %d of %d)"
			% [navigation.reserved_count(), navigation.anchor_count()]
	)


## DEPTH. A seated actor must be drawn in front of the prop it sits at, or its desk
## hides it. Asserted for every kind, not only work anchors.
##
## The mechanism is Y-sort, which orders by each node's base Y; the property that
## makes it work is that an anchor's ROW is at or below its prop's base row. That is
## asserted here from the world's own public `FURNITURE` data, so no private accessor
## has to be invented for the test.
func test_seated_actors_are_not_hidden_by_their_props(t) -> void:
	# Every anchored prop's base row, from the world's own declarations.
	var prop_row := {}
	for item in OfficeWorld.FURNITURE:
		prop_row[str(item.get("id", ""))] = (item["cell"] as Vector2i).y
		t.check(
			item.has("cell"),
			"a furniture row carries its cell"
		)

	var compared := 0
	for desk_id in OfficeWorld.ANCHORS:
		var id := str(desk_id)
		if not prop_row.has(id):
			continue
		var base: int = prop_row[id]
		for which in (OfficeWorld.ANCHORS[id] as Dictionary):
			var cell: Vector2i = (OfficeWorld.ANCHORS[id] as Dictionary)[which]
			compared += 1
			t.check(
				cell.y >= base,
				"the %s anchor of %s sits at or below its prop's base row (anchor %d, prop %d)"
					% [str(which), id, cell.y, base]
			)
	t.check(
		compared > 0,
		"at least one anchor's depth was actually compared"
	)
	# The rule only takes effect because the prop layer sorts by Y. That is a property
	# of the scene the world builds, so it is asserted by building it rather than by
	# restating the constant.
	var world := OfficeWorld.new()
	world.setup(null)
	t.check(world.prop_sort_enabled(), "the world's prop layer sorts by Y")
	world.free()


## A world built the way the product builds it. The caller uses it and frees it, which
## is the pattern this suite's neighbours already use (`test_navigation.gd`).
func _world() -> OfficeWorld:
	var world := OfficeWorld.new()
	world.setup(null)
	return world
