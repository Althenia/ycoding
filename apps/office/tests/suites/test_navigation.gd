## Navigation and movement tests (TEST-022, TEST-023).
##
## Every node created here is freed before the test returns. This harness has no
## SceneTree parent, so an un-freed node would be reported as a leaked instance
## when the runner exits.
extends RefCounted


func run(t) -> void:
	test_all_anchors_reachable(t)
	test_anchors_are_not_blocked(t)
	test_anchors_clear_every_prop_footprint(t)
	test_work_anchors_sort_in_front_of_their_desk(t)
	test_route_avoids_blocked_cells(t)
	test_route_between_same_cell(t)
	test_doorway_is_passable(t)
	test_actor_walks_to_anchor(t)
	test_actor_reports_walking_then_stops(t)
	test_facing_follows_travel_direction(t)


func _world() -> OfficeWorld:
	var world := OfficeWorld.new()
	world.setup(null)
	return world


func _presentation() -> ActorPresentation:
	return ActorPresentation.new(ActorIdentity.new("ses_1", "backend", "ses_root", "Backend"))


func test_all_anchors_reachable(t) -> void:
	var world := _world()
	t.check(world.navigation != null, "navigation built")
	t.check(world.navigation.all_anchors_reachable(), "every work/visitor anchor is reachable")
	t.check(world.navigation.anchor_count() >= 6, "office exposes multiple anchors")
	world.free()


func test_anchors_are_not_blocked(t) -> void:
	var world := _world()
	var nav := world.navigation
	for desk_id in OfficeWorld.ANCHORS:
		var desk: Dictionary = OfficeWorld.ANCHORS[desk_id]
		for which in desk:
			var cell: Vector2i = desk[which]
			t.check(not nav.is_blocked(cell), "anchor %s/%s is walkable" % [desk_id, which])
	world.free()


## An anchor must never sit inside a solid prop's footprint, or an actor would
## stand on furniture. This is the regression guard for the coffee/sofa overlap.
func test_anchors_clear_every_prop_footprint(t) -> void:
	for item in OfficeWorld.FURNITURE:
		if not bool(item.get("solid", false)):
			continue
		var cell: Vector2i = item["cell"]
		var footprint: Vector2i = OfficeWorld.PROP_FOOTPRINT.get(str(item["prop"]), Vector2i(1, 1))
		var rect := Rect2i(cell, footprint)
		for desk_id in OfficeWorld.ANCHORS:
			var desk: Dictionary = OfficeWorld.ANCHORS[desk_id]
			for which in desk:
				var anchor: Vector2i = desk[which]
				t.check(
					not rect.has_point(anchor),
					"anchor %s/%s is clear of prop %s" % [desk_id, which, item["id"]]
				)


## An actor standing at a work anchor must not sort behind its own desk, or it
## vanishes from the render. The comparison mirrors the runtime Y-sort exactly:
## both nodes use their own position.y as the sort key.
func test_work_anchors_sort_in_front_of_their_desk(t) -> void:
	for item in OfficeWorld.FURNITURE:
		var desk_id := str(item["id"])
		if not OfficeWorld.ANCHORS.has(desk_id):
			continue
		var cell: Vector2i = item["cell"]
		var footprint: Vector2i = OfficeWorld.PROP_FOOTPRINT.get(str(item["prop"]), Vector2i(1, 1))
		var desk_base_y := float((cell.y + footprint.y) * OfficeWorld.TILE)
		var work: Vector2i = (OfficeWorld.ANCHORS[desk_id] as Dictionary)["work"]
		var actor_y := float(work.y * OfficeWorld.TILE + OfficeWorld.TILE / 2)
		t.check(
			actor_y >= desk_base_y,
			"work anchor for %s (y=%d) sorts at or in front of its desk base (y=%d)"
			% [desk_id, int(actor_y), int(desk_base_y)]
		)


func test_route_avoids_blocked_cells(t) -> void:
	var world := _world()
	var nav := world.navigation
	var route := nav.route(
		nav.anchor_position("desk_prod_0", "work"),
		nav.anchor_position("hud_whiteboard", "work")
	)
	t.check(route.size() > 1, "a multi-step route exists across the office")
	for point in route:
		var cell := Vector2i(int(point.x / OfficeWorld.TILE), int(point.y / OfficeWorld.TILE))
		t.check(not nav.is_blocked(cell), "route point %s is walkable" % str(cell))
	world.free()


func test_route_between_same_cell(t) -> void:
	var world := _world()
	var nav := world.navigation
	var here := nav.anchor_position("desk_eng_0", "work")
	var route := nav.route(here, here)
	t.check(route.size() >= 1, "same-cell route returns the destination")
	t.check(route[0] == here, "same-cell route lands on the destination")
	world.free()


func test_doorway_is_passable(t) -> void:
	var world := _world()
	var nav := world.navigation
	t.check(not nav.is_blocked(Vector2i(9, 0)), "doorway cell 9,0 is passable")
	t.check(not nav.is_blocked(Vector2i(10, 0)), "doorway cell 10,0 is passable")
	t.check(nav.is_blocked(Vector2i(5, 0)), "solid wall stays blocked")
	world.free()


func test_actor_walks_to_anchor(t) -> void:
	var actor := OfficeActor.new()
	actor.update_from(_presentation(), Vector2(64, 64))
	t.check(not actor.is_walking(), "an actor with no route is not walking")
	actor.set_route([Vector2(64, 64), Vector2(96, 64), Vector2(96, 128)])
	t.check(actor.is_walking(), "a multi-point route starts walking")
	actor.free()


func test_actor_reports_walking_then_stops(t) -> void:
	var actor := OfficeActor.new()
	actor.update_from(_presentation(), Vector2(0, 0))
	actor.set_route([Vector2(0, 0), Vector2(8, 0)])
	actor._process(1.0)
	t.check(not actor.is_walking(), "a completed route stops walking")
	t.check_equal(actor.position, Vector2(8, 0), "the actor arrives at the destination")
	actor.free()


func test_facing_follows_travel_direction(t) -> void:
	var actor := OfficeActor.new()
	actor.update_from(_presentation(), Vector2(0, 0))
	actor.set_route([Vector2(0, 0), Vector2(64, 0)])
	actor._process(0.01)
	t.check_equal(actor.facing(), OfficeActor.DIR_RIGHT, "moving right faces right")
	var origin := actor.position
	actor.set_route([origin, origin + Vector2(0, 64)])
	actor._process(0.01)
	t.check_equal(actor.facing(), OfficeActor.DIR_DOWN, "moving down faces down")
	actor.free()
